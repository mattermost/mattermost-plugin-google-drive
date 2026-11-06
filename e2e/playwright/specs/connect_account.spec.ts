// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    callOAuthComplete,
    captureGoogleConsentRedirect,
    DRIVE_OAUTH_SCOPES,
    GOOGLE_AUTH_ORIGIN,
    oauthCompletePath,
    routeGoogleSignInToFake,
    STATE_RANDOM_LENGTH,
    unissuedState,
} from '../lib/drive_oauth';
import {ensureDrivePlugin, PLACEHOLDER_OAUTH} from '../lib/drive_plugin';
import {requireGoogle} from '../lib/google/auth';
import {requireFakeGoogle} from '../lib/google/mode';
import {hasGoogleUserToken, seedGoogleUserToken} from '../lib/kv';
import {expect, test} from '../lib/test';
import {DriveAccountPosts} from '../pages/drive_account_posts';
import {DRIVE_SUBCOMMANDS, DriveSlashCommand} from '../pages/drive_slash_command';
import {FakeGoogleSignIn} from '../pages/fake_google_sign_in';

/**
 * @objective Verify that connecting an account redirects to Google consent with the plugin's client, callback, Drive scopes, offline access and a per-user state
 */
test('redirects to Google consent with offline access and all Drive scopes when connecting an account', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin and log in as a regular user
    const {adminClient, user, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, PLACEHOLDER_OAUTH);
    const {context, channelsPage} = await pw.testBrowser.login(user);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();

    // # Run the connect command and follow the link it returns, stopping before Google loads
    const consentRedirect = await captureGoogleConsentRedirect(context);
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.connect);
    await new DriveAccountPosts(channelsPage).clickConnectLink();
    const consentUrl = await consentRedirect();
    const params = consentUrl.searchParams;

    // * Verify the redirect targets Google's OAuth endpoint with the configured client
    expect(consentUrl.origin).toBe(GOOGLE_AUTH_ORIGIN);
    expect(consentUrl.pathname).toBe('/o/oauth2/auth');
    expect(params.get('client_id')).toBe(PLACEHOLDER_OAUTH.googleOAuthClientId);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('redirect_uri')).toBe(`${process.env.PW_BASE_URL}${oauthCompletePath}`);

    // * Verify offline access with forced consent, so Google returns a refresh token
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');

    // * Verify every Drive scope the plugin needs is requested
    expect(params.get('scope')?.split(' ').sort()).toEqual([...DRIVE_OAUTH_SCOPES].sort());

    // * Verify the state ties the request to this Mattermost user
    expect(params.get('state')).toMatch(new RegExp(`^[a-z0-9]{${STATE_RANDOM_LENGTH}}_${user.id}$`));
});

/**
 * @objective Verify that an OAuth callback with a state the plugin never issued fails the connection and the Google Drive bot reports it in a DM
 */
test('reports an unrecognised OAuth state in a Google Drive bot DM during account connection', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin and log in as a regular user
    const {adminClient, user, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, PLACEHOLDER_OAUTH);
    const {context, page, channelsPage} = await pw.testBrowser.login(user);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();

    // # Start connecting the account, stopping before Google loads
    const consentRedirect = await captureGoogleConsentRedirect(context);
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.connect);
    const accountPosts = new DriveAccountPosts(channelsPage);
    await accountPosts.clickConnectLink();
    await consentRedirect();

    // # Return to the plugin's callback with a well-formed state the plugin never issued
    const response = await callOAuthComplete(page.request, {code: 'e2e-code', state: unissuedState(user.id)});

    // * Verify the callback rejects the state
    expect(response.status).toBe(400);
    expect(response.body).toContain('invalid state token');

    // * Verify the Google Drive bot reports the failed connection in a DM
    await accountPosts.openBotDM(team.name);
    await expect(accountPosts.connectionError('invalid state token')).toBeVisible();

    // * Verify the user is still not connected
    expect(await hasGoogleUserToken(user.id)).toBe(false);
});

/**
 * @objective Verify that the OAuth callback rejects a missing authorization code and a state that belongs to a different Mattermost user
 */
test('rejects OAuth callbacks with a missing code or a state issued for a different user', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin and log in as a regular user
    const {adminClient, adminUser, user} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, PLACEHOLDER_OAUTH);
    const {page} = await pw.testBrowser.login(user);

    // # Call the OAuth callback without an authorization code
    const missingCode = await callOAuthComplete(page.request, {state: unissuedState(user.id)});

    // * Verify the callback rejects the request as a bad authorization code
    expect(missingCode.status).toBe(400);
    expect(missingCode.body).toContain('invalid authorization code');

    // # Call the OAuth callback with a state that names another user
    const otherUser = await callOAuthComplete(page.request, {code: 'e2e-code', state: unissuedState(adminUser!.id)});

    // * Verify the callback refuses to connect the account for someone else
    expect(otherUser.status).toBe(401);
    expect(otherUser.body).toContain('not authorized, incorrect user');

    // * Verify the user is still not connected
    expect(await hasGoogleUserToken(user.id)).toBe(false);
});

/**
 * @objective Verify that a connected user is told to disconnect before reconnecting, and that disconnecting removes the stored Google token
 *
 * @precondition
 * The user's Google token is seeded directly into the plugin KV store (no Google sign-in)
 */
test('asks a connected user to disconnect first and then disconnects the Google account', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin and seed a Google token for a regular user
    const {adminClient, user, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, PLACEHOLDER_OAUTH);
    await seedGoogleUserToken(user.id, {
        access_token: `e2e-access-${pw.random.id()}`,
        token_type: 'Bearer',
        refresh_token: `e2e-refresh-${pw.random.id()}`,
    });

    // # Log in and run the connect command
    const {channelsPage} = await pw.testBrowser.login(user);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const slashCommand = new DriveSlashCommand(channelsPage);
    const accountPosts = new DriveAccountPosts(channelsPage);
    await slashCommand.run(DRIVE_SUBCOMMANDS.connect);

    // * Verify the plugin says the account is already connected instead of offering a link
    await expect(accountPosts.alreadyConnected).toBeVisible();
    await expect(accountPosts.connectLink).toHaveCount(0);

    // # Disconnect the account
    await slashCommand.run(DRIVE_SUBCOMMANDS.disconnect);

    // * Verify the plugin confirms and removes the stored token
    await expect(accountPosts.disconnected).toBeVisible();
    expect(await hasGoogleUserToken(user.id)).toBe(false);

    // # Disconnect again
    await slashCommand.run(DRIVE_SUBCOMMANDS.disconnect);

    // * Verify the plugin reports that no account is connected
    await expect(accountPosts.noAccountConnected).toBeVisible();
});

/**
 * @objective Verify that signing in with Google and allowing access connects the account: the plugin exchanges the code, stores the token and welcomes the user in a Google Drive bot DM
 *
 * @precondition
 * Fake Google, whose sign-in and consent pages the browser is routed to
 */
test('connects a Google account through sign-in and consent and welcomes the user in a bot DM', {tag: '@google_drive'}, async ({pw}) => {
    requireFakeGoogle();
    const {oauth, accounts} = requireGoogle('owner');

    // # Enable the plugin with the fake's OAuth client and log in as a user with no Google account connected
    const {adminClient, user, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const {context, channelsPage} = await pw.testBrowser.login(user);
    await routeGoogleSignInToFake(context);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();

    // # Run the connect command, follow the link, pick the owner's Google account and allow access
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.connect);
    const accountPosts = new DriveAccountPosts(channelsPage);
    const signIn = new FakeGoogleSignIn(await accountPosts.openConnectLink());
    await expect(signIn.accountChooser).toBeVisible();
    await signIn.signInAndAllow(accounts.owner.email);

    // * Verify the plugin exchanges the code and stores the user's Google token
    await expect.poll(() => hasGoogleUserToken(user.id)).toBe(true);

    // * Verify the Google Drive bot welcomes the user in a DM
    await accountPosts.openBotDM(team.name);
    await expect(accountPosts.welcome).toBeVisible();
});
