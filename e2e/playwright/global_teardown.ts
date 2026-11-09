// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {Client4} from '@mattermost/client';
import {testConfig} from '@mattermost/playwright-lib';

import {fakeGoogle} from './lib/fake_google';
import {googleMode} from './lib/google/mode';
import {EXTERNAL_CONFIG_BACKUP, readExternalConfigBackup, removeExternalConfigBackup, serverMode} from './lib/server_mode';

// The compose stack keeps running after the run (npm run server:down removes it).
export default async function globalTeardown() {
    if (serverMode() === 'external') {
        await restoreExternalServerConfig();
        return;
    }
    if (googleMode() !== 'fake' || !process.env.FAKE_GOOGLE_URL) {
        return;
    }

    // lib/test.ts fails each test on its own violations and takes them. What is left came from
    // outside a test (global setup, a late notification after the last test), and `late` holds what
    // arrived after the test that caused it was checked. Both still fail the run.
    const contract = await fakeGoogle.violations();
    for (const divergence of new Set(contract.divergences)) {
        console.log(`Fake Google accepted something real Google would reject: ${divergence}`);
    }
    const unreported = [...new Set([...contract.late, ...contract.value])];
    if (unreported.length > 0) {
        throw new Error(`Fake Google saw traffic outside a test's check that breaks the Google API contract:\n${unreported.join('\n')}`);
    }
}

/** Puts back the config the external server had before the run (secrets come back masked, which the server ignores). */
async function restoreExternalServerConfig() {
    const backup = readExternalConfigBackup();
    if (!backup) {
        return;
    }

    try {
        const adminClient = new Client4();
        adminClient.setUrl(testConfig.baseURL);
        await adminClient.login(testConfig.adminUsername, testConfig.adminPassword);
        await adminClient.updateConfig(backup as any);
    } catch (err) {
        // Fail the run; the backup stays, and the next run's setup refuses to overwrite it.
        throw new Error(
            `Could not restore the external server's config (${String(err)}). ` +
                `The pre-run config is in ${EXTERNAL_CONFIG_BACKUP}; restore it from the System Console or with mmctl, then delete the file.`,
        );
    }
    removeExternalConfigBackup();
    console.log("Restored the external server's config");
}
