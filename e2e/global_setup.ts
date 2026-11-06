// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {Client4} from '@mattermost/client';
import {baseGlobalSetup, testConfig} from '@mattermost/playwright-lib';

import {findPluginBundle, uploadPlugin} from './lib/drive_plugin';
import {fakeGoogle} from './lib/fake_google';
import {configuredGoogleAccount} from './lib/google/auth';
import {trashLeftoverFiles} from './lib/google/drive';
import {googleMode} from './lib/google/mode';
import {
    assertServerAlive,
    composeDatabaseURL,
    composeFakeGoogleURL,
    DEFAULT_EXTERNAL_DATABASE_URL,
    EXTERNAL_CONFIG_BACKUP,
    fakeGoogleIsRunning,
    saveExternalConfigBackup,
    serverMode,
} from './lib/server_mode';

export default async function globalSetup() {
    // Fail before touching any server if the bundle is missing or would be rejected.
    const bundle = findPluginBundle();
    const mode = serverMode();
    const google = googleMode();
    if (google === 'fake' && mode === 'external') {
        throw new Error('E2E_GOOGLE=fake needs E2E_SERVER=compose: the fake answers on Google hostnames inside the Docker network. Use E2E_GOOGLE=real with an external server.');
    }

    // The stack is started outside the run (npm run server:up), so this only checks it is there.
    await assertServerAlive(testConfig.baseURL);

    if (mode === 'compose') {
        // Read by workers (they start after global setup and inherit this environment).
        process.env.E2E_DATABASE_URL ??= composeDatabaseURL();
        const fakeURL = process.env.FAKE_GOOGLE_URL ?? composeFakeGoogleURL();
        const fakeRunning = await fakeGoogleIsRunning(fakeURL);
        if (google === 'fake') {
            if (!fakeRunning) {
                throw new Error(`Fake Google is not answering at ${fakeURL}. Start the stack with \`npm run server:up\` (the real lane's \`server:up:real\` leaves the fake out).`);
            }
            await useFakeGoogleAccounts(fakeURL);
        } else if (fakeRunning) {
            // Its proxy would send Mattermost's Google calls to the fake.
            throw new Error('E2E_GOOGLE=real but the fake Google is running in the stack. Restart it without the fake: `npm run server:down && npm run server:up:real`.');
        }
    } else {
        process.env.E2E_DATABASE_URL ??= DEFAULT_EXTERNAL_DATABASE_URL;
        console.log(`Using external Mattermost at ${testConfig.baseURL} (database ${redact(process.env.E2E_DATABASE_URL)})`);
    }

    // Creates the sysadmin (on a fresh server) and default team, and sets default preferences.
    await baseGlobalSetup();

    const adminClient = new Client4();
    adminClient.setUrl(testConfig.baseURL);
    await adminClient.login(testConfig.adminUsername, testConfig.adminPassword);

    if (mode === 'external') {
        // pw.initSetup() replaces the whole server config with test defaults (including
        // ListenAddress ':8065' and EnableLocalMode false). Keep a backup to restore in teardown,
        // and keep the settings the dev server needs to start again.
        const config = await adminClient.getConfig();
        saveExternalConfigBackup(config);
        process.env.E2E_PRESERVED_SERVICE_SETTINGS = JSON.stringify({
            ListenAddress: config.ServiceSettings.ListenAddress,
            EnableLocalMode: config.ServiceSettings.EnableLocalMode,
        });
        console.log(`Saved server config backup to ${EXTERNAL_CONFIG_BACKUP}`);
    }

    await uploadPlugin(adminClient, bundle);
    console.log(`Uploaded plugin bundle ${bundle}`);

    if (google === 'real') {
        await sweepLeftoverFiles();
    }
}

/** A run takes minutes, so files this old belong to no run that is still going. */
const LEFTOVER_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Trashes `e2e-` files that interrupted runs left in the real test accounts' Drives (each test
 * trashes its own files, but a killed run skips that). Only files older than LEFTOVER_AGE_MS, so a
 * parallel run sharing the accounts keeps its files. The fake lane needs none of this: the fake is
 * reset above. `npm run sweep` is the manual version, without the age limit.
 */
async function sweepLeftoverFiles() {
    const createdBefore = new Date(Date.now() - LEFTOVER_AGE_MS);
    for (const role of ['owner', 'collab'] as const) {
        const account = configuredGoogleAccount(role);
        if (!account) {
            continue;
        }
        const trashed = await trashLeftoverFiles(account, createdBefore);
        if (trashed.length) {
            console.log(`Trashed ${trashed.length} leftover e2e file(s) older than 2 hours from the ${role} account: ${trashed.join(', ')}`);
        }
    }
}

/**
 * Resets the fake (the compose stack outlives a run, so this is what isolates one run from the
 * previous one) and points the GOOGLE_* variables the specs read at the fake's fixed OAuth client
 * and accounts (replacing any real ones loaded from .env.local), so the same specs run in both lanes.
 */
async function useFakeGoogleAccounts(url: string) {
    process.env.FAKE_GOOGLE_URL = url;
    await fakeGoogle.reset();
    const {clientId, clientSecret, users} = await fakeGoogle.accounts();
    process.env.GOOGLE_AUTH_MODE = 'refresh_token';
    process.env.GOOGLE_OAUTH_CLIENT_ID = clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret;
    for (const user of users) {
        const prefix = user.key === 'owner' ? 'GOOGLE_OWNER' : 'GOOGLE_COLLAB';
        process.env[`${prefix}_EMAIL`] = user.email;
        process.env[`${prefix}_REFRESH_TOKEN`] = user.refreshToken;
    }
    console.log(`Using fake Google at ${url} (E2E_GOOGLE=fake)`);
}

function redact(url: string) {
    return url.replace(/\/\/[^@]*@/, '//***@');
}
