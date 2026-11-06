// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {expect, test as base} from '@mattermost/playwright-lib';

import {fakeGoogle} from './fake_google';
import {googleMode} from './google/mode';

/**
 * The `pw` test plus a check of the fake Google's contract after every test: traffic that breaks
 * Google's published contract fails the test that sent it, not the whole run at teardown. Specs
 * import `test` and `expect` from here.
 */
export const test = base.extend<{fakeGoogleContract: void}>({
    fakeGoogleContract: [
        // eslint-disable-next-line no-empty-pattern
        async ({}, use, testInfo) => {
            if (googleMode() !== 'fake' || !process.env.FAKE_GOOGLE_URL) {
                await use();
                return;
            }

            // Drop anything an earlier test left behind (e.g. a late push notification).
            await fakeGoogle.clearViolations();
            await use();

            const contract = await fakeGoogle.violations();
            await fakeGoogle.clearViolations();
            for (const divergence of new Set(contract.divergences)) {
                testInfo.annotations.push({type: 'fake-google divergence', description: divergence});
            }
            if (contract.value.length > 0) {
                throw new Error(`Fake Google saw traffic that breaks the Google API contract:\n${[...new Set(contract.value)].join('\n')}`);
            }
        },
        {auto: true},
    ],
});

export {expect};
