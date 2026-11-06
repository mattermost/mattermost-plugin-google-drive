// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {Client4} from '@mattermost/client';
import {testConfig} from '@mattermost/playwright-lib';

import {fakeGoogle} from './lib/fake_google';
import {googleMode} from './lib/google/mode';
import {EXTERNAL_CONFIG_BACKUP, readExternalConfigBackup, serverMode} from './lib/server_mode';

// The compose stack keeps running after the run (npm run server:down removes it).
export default async function globalTeardown() {
    if (serverMode() === 'external') {
        await restoreExternalServerConfig();
        return;
    }
    if (googleMode() !== 'fake' || !process.env.FAKE_GOOGLE_URL) {
        return;
    }

    // lib/test.ts fails each test on its own violations and clears them. What is left came from
    // outside a test (global setup, a late notification after the last test) and still fails the run.
    const contract = await fakeGoogle.violations();
    for (const divergence of new Set(contract.divergences)) {
        console.log(`Fake Google accepted something real Google would reject: ${divergence}`);
    }
    if (contract.value.length > 0) {
        throw new Error(`Fake Google saw traffic that breaks the Google API contract:\n${[...new Set(contract.value)].join('\n')}`);
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
        console.log(`Restored the external server's config from ${EXTERNAL_CONFIG_BACKUP}`);
    } catch (err) {
        console.warn(
            `Could not restore the external server's config (${String(err)}). ` +
                `The pre-run config is in ${EXTERNAL_CONFIG_BACKUP}; restore it from the System Console or with mmctl.`,
        );
    }
}
