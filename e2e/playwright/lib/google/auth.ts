// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Google credentials for the test accounts. With E2E_GOOGLE=fake (the default), global setup fills
// the GOOGLE_* variables below with the fake's fixed client and accounts. With E2E_GOOGLE=real they
// are real Google credentials, in one of two modes (GOOGLE_AUTH_MODE):
// - refresh_token (local development): refresh tokens from `npm run google:auth`, issued to the same
//   OAuth client the plugin is configured with. Seeded without an access token, so the plugin
//   mints access tokens itself, exercising its real refresh path.
// - dwd (CI with a Workspace org): a service account with domain-wide delegation mints access
//   tokens per user. Not implemented until the Workspace org exists.

import {test} from '@playwright/test';

import type {DrivePluginSettings} from '../drive_plugin';
import {seedGoogleUserToken} from '../kv';

import {googleEndpoints, googleMode} from './mode';

export type GoogleRole = 'owner' | 'collab';

const ROLE_ENV: Record<GoogleRole, {email: string; refreshToken: string}> = {
    owner: {email: 'GOOGLE_OWNER_EMAIL', refreshToken: 'GOOGLE_OWNER_REFRESH_TOKEN'},
    collab: {email: 'GOOGLE_COLLAB_EMAIL', refreshToken: 'GOOGLE_COLLAB_REFRESH_TOKEN'},
};

export type GoogleAccount = {role: GoogleRole; email: string; refreshToken: string};

function authMode(): 'refresh_token' | 'dwd' {
    const mode = process.env.GOOGLE_AUTH_MODE ?? 'refresh_token';
    if (mode !== 'refresh_token' && mode !== 'dwd') {
        throw new Error(`GOOGLE_AUTH_MODE must be 'refresh_token' or 'dwd', got '${mode}'.`);
    }
    return mode;
}

/** The real OAuth client from .env.local / CI secrets, or null when not configured. */
export function realOAuthSettings(): DrivePluginSettings | null {
    const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    return id && secret ? {googleOAuthClientId: id, googleOAuthClientSecret: secret} : null;
}

/** The account when configured, without skipping (for cleanup hooks). */
export function configuredGoogleAccount(role: GoogleRole): GoogleAccount | null {
    return realOAuthSettings() ? account(role) : null;
}

function account(role: GoogleRole): GoogleAccount | null {
    const email = process.env[ROLE_ENV[role].email];
    const refreshToken = process.env[ROLE_ENV[role].refreshToken];
    return email && refreshToken ? {role, email: email.toLowerCase(), refreshToken} : null;
}

/**
 * Skips the test when a credential is missing, except in a real-Google CI run (CI with
 * E2E_GOOGLE=real), where it fails: a nightly run whose secrets are missing must not go green by
 * skipping every test.
 */
function skipIfMissing(missing: boolean, message: string) {
    if (missing && process.env.CI && googleMode() === 'real') {
        throw new Error(`${message} The real-Google lane in CI needs every credential, so this fails instead of skipping.`);
    }
    test.skip(missing, message);
}

/**
 * Returns the real OAuth client and the requested Google accounts, or skips the test with a
 * message saying what to set up (fails instead in a real-Google CI run, see skipIfMissing). Call
 * at the top of every test that talks to Google.
 */
export function requireGoogle<R extends GoogleRole>(...roles: R[]): {oauth: DrivePluginSettings; accounts: Record<R, GoogleAccount>} {
    if (authMode() === 'dwd') {
        throw new Error('GOOGLE_AUTH_MODE=dwd is not implemented yet (needs the Workspace test org).');
    }

    const oauth = realOAuthSettings();
    skipIfMissing(!oauth, 'Needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (see e2e/.env.example).');

    const accounts = {} as Record<R, GoogleAccount>;
    for (const role of roles) {
        const found = account(role);
        skipIfMissing(
            !found,
            `Needs ${ROLE_ENV[role].email} and ${ROLE_ENV[role].refreshToken}; run \`npm run google:auth -- ${role}\`.`,
        );
        accounts[role] = found!;
    }
    return {oauth: oauth!, accounts};
}

/** Marks the Mattermost user as connected to the Google account, as the OAuth callback would. */
export async function seedConnectedGoogleUser(mmUserId: string, googleAccount: GoogleAccount) {
    await seedGoogleUserToken(mmUserId, {refresh_token: googleAccount.refreshToken, token_type: 'Bearer'});
}

const accessTokens = new Map<string, {token: string; expiresAt: number}>();

/** An access token for test-side Google API calls (assertions, actor actions, cleanup). */
export async function googleAccessToken(googleAccount: GoogleAccount): Promise<string> {
    const cached = accessTokens.get(googleAccount.email);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
        return cached.token;
    }

    const oauth = realOAuthSettings()!;
    const response = await fetch(googleEndpoints().token, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
            client_id: oauth.googleOAuthClientId,
            client_secret: oauth.googleOAuthClientSecret,
            refresh_token: googleAccount.refreshToken,
            grant_type: 'refresh_token',
        }),
    });
    const body = await response.json();
    if (!response.ok) {
        // invalid_grant usually means the 7-day Testing-status token expired.
        throw new Error(
            `Could not refresh the Google token for ${googleAccount.email}: ${body.error} ${body.error_description ?? ''}. ` +
                `Run \`npm run google:auth -- ${googleAccount.role}\` again.`,
        );
    }
    accessTokens.set(googleAccount.email, {token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000});
    return body.access_token;
}
