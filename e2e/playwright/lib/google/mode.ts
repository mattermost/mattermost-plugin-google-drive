// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {test} from '@playwright/test';

/**
 * Which Google the run talks to (E2E_GOOGLE):
 * - `fake` (default, the PR lane): fake-google/ in a container next to Mattermost. No accounts or
 *   secrets. The plugin reaches it on Google's real hostnames (see lib/fake_google.ts).
 * - `real` (nightly): real Google with the accounts in .env.local / CI secrets.
 * The specs are the same in both lanes; only credentials and endpoints change.
 */
export type GoogleMode = 'fake' | 'real';

export function googleMode(): GoogleMode {
    const mode = process.env.E2E_GOOGLE ?? 'fake';
    if (mode !== 'fake' && mode !== 'real') {
        throw new Error(`E2E_GOOGLE must be 'fake' or 'real', got '${mode}'.`);
    }
    return mode;
}

/**
 * Skips tests that need Drive push notifications delivered to the plugin. The fake delivers them
 * inside the Docker network. Real Drive needs a public HTTPS SiteURL (the nightly tunnel), which
 * the suite does not wire up yet.
 */
export function requireDrivePush() {
    test.skip(googleMode() === 'real', 'Real Drive push needs a public HTTPS SiteURL (E2E_PUBLIC_URL), not wired up yet.');
}

/** Skips tests that drive the fake Google itself (its sign-in pages or its test-only settings). */
export function requireFakeGoogle() {
    test.skip(googleMode() === 'real', 'Needs the fake Google.');
}

/** Base URLs for test-side Google calls (assertions, actor actions and cleanup). */
export function googleEndpoints(): {token: string; drive: string} {
    if (googleMode() === 'real') {
        return {token: 'https://oauth2.googleapis.com/token', drive: 'https://www.googleapis.com/drive/v3'};
    }
    const fake = process.env.FAKE_GOOGLE_URL;
    if (!fake) {
        throw new Error('FAKE_GOOGLE_URL is not set; it is exported by global_setup.ts when E2E_GOOGLE=fake.');
    }
    return {token: `${fake}/token`, drive: `${fake}/drive/v3`};
}
