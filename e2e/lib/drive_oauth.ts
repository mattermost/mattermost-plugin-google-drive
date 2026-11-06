// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {APIRequestContext, BrowserContext} from '@playwright/test';

import {PLUGIN_ID} from './drive_plugin';

export const GOOGLE_AUTH_ORIGIN = 'https://accounts.google.com';

/** Scopes the plugin requests (server/plugin/oauth2/oauth2.go GetOAuthConfig). */
export const DRIVE_OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.activity',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
];

/** Length of the random part of the plugin's OAuth state (server/plugin/api.go). */
export const STATE_RANDOM_LENGTH = 15;

export const oauthCompletePath = `/plugins/${PLUGIN_ID}/oauth/complete`;

export const oauthConnectPath = `/plugins/${PLUGIN_ID}/oauth/connect`;

/**
 * Captures where the plugin's connect endpoint redirects the browser, without contacting Google.
 *
 * Playwright's route() does not see requests that result from a redirect, so intercepting
 * accounts.google.com would miss the 302 from the plugin. Instead this intercepts the plugin's
 * /oauth/connect request, sends it to the server without following redirects, records the
 * Location header and answers the browser with a blank page.
 */
export async function captureGoogleConsentRedirect(context: BrowserContext): Promise<() => Promise<URL>> {
    let resolveUrl: (url: URL) => void;
    let rejectUrl: (err: Error) => void;
    const captured = new Promise<URL>((resolve, reject) => {
        resolveUrl = resolve;
        rejectUrl = reject;
    });
    await context.route(`**${oauthConnectPath}`, async (route) => {
        const response = await route.fetch({maxRedirects: 0});
        const location = response.headers().location;
        if (response.status() !== 302 || !location) {
            rejectUrl(new Error(`Expected a 302 from ${oauthConnectPath}, got ${response.status()}`));
            await route.fulfill({response});
            return;
        }
        resolveUrl(new URL(location));
        await route.fulfill({status: 200, contentType: 'text/html', body: '<html><body>Google consent intercepted by e2e test</body></html>'});
    });
    return () => captured;
}

/**
 * Serves Google's sign-in and consent pages from the fake Google (fake lane only), so the browser
 * can complete the whole OAuth flow: the plugin's /oauth/connect redirect is answered with the
 * fake's account chooser, and the consent form posts go to the fake, whose final 302 sends the
 * browser to the plugin's /oauth/complete with a code the fake will exchange.
 *
 * As in captureGoogleConsentRedirect, route() would not see the redirected accounts.google.com
 * request, so the redirect is resolved here. The pages stay on the Mattermost origin, which is
 * why their relative form posts (/o/oauth2/consent) are routed too.
 */
export async function routeGoogleSignInToFake(context: BrowserContext) {
    const fake = process.env.FAKE_GOOGLE_URL;
    if (!fake) {
        throw new Error('FAKE_GOOGLE_URL is not set; Google sign-in can only be routed to the fake (E2E_GOOGLE=fake).');
    }
    await context.route(`**${oauthConnectPath}`, async (route) => {
        const response = await route.fetch({maxRedirects: 0});
        const location = response.headers().location;
        if (response.status() !== 302 || !location?.startsWith(GOOGLE_AUTH_ORIGIN)) {
            await route.fulfill({response});
            return;
        }
        const consent = new URL(location);
        await route.fulfill({response: await route.fetch({url: `${fake}${consent.pathname}${consent.search}`, maxRedirects: 0})});
    });
    await context.route('**/o/oauth2/consent', async (route) => {
        await route.fulfill({response: await route.fetch({url: `${fake}/o/oauth2/consent`, maxRedirects: 0})});
    });
}

/**
 * Calls the plugin's OAuth callback with the browser session, the way Google's redirect would.
 * Returns the HTTP status and body text.
 */
export async function callOAuthComplete(
    request: APIRequestContext,
    params: {code?: string; state?: string},
): Promise<{status: number; body: string}> {
    const query = new URLSearchParams();
    if (params.code !== undefined) {
        query.set('code', params.code);
    }
    if (params.state !== undefined) {
        query.set('state', params.state);
    }
    const response = await request.get(`${oauthCompletePath}?${query.toString()}`);
    return {status: response.status(), body: (await response.text()).trim()};
}

/** A well-formed state for `userId` whose random part was never issued by the plugin. */
export function unissuedState(userId: string): string {
    return `${'x'.repeat(STATE_RANDOM_LENGTH)}_${userId}`;
}
