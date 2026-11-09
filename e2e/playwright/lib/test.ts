// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {expect, test as base} from '@mattermost/playwright-lib';

import {fakeGoogle} from './fake_google';
import {googleMode} from './google/mode';

/**
 * The `pw` test plus a check of the fake Google's contract after every test: traffic that breaks
 * Google's published contract fails the test that sent it. Traffic that arrives after a test was
 * checked is kept and fails the run at global teardown. Specs
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

            // Anything recorded since the previous test's check arrived late (e.g. a push notification
            // or the plugin's follow-up reads). Keep it for global teardown rather than failing this test.
            const late = await fakeGoogle.deferViolations();
            for (const message of new Set(late.value)) {
                testInfo.annotations.push({type: 'fake-google late violation', description: message});
            }
            await use();

            const contract = await fakeGoogle.takeViolations();
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
