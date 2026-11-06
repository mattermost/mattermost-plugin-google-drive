// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {postCreateFileStatus} from '../lib/drive_api';
import {ensureDrivePlugin, PLACEHOLDER_OAUTH, UNCONFIGURED_OAUTH} from '../lib/drive_plugin';
import {expect, test} from '../lib/test';
import {DRIVE_SUBCOMMANDS, DriveSlashCommand} from '../pages/drive_slash_command';

/**
 * @objective Verify that a system admin is only offered the setup and about subcommands while the plugin has no Google OAuth client configured
 *
 * @precondition
 * Google Drive plugin is enabled with an empty Google OAuth client ID and secret
 */
test('limits Google Drive slash command to setup and about when Google OAuth is not configured', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin without a Google OAuth client
    const {adminClient, adminUser, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, UNCONFIGURED_OAUTH);

    // # Log in as the system admin and open the subcommand suggestions
    const {channelsPage} = await pw.testBrowser.login(adminUser!);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const slashCommand = new DriveSlashCommand(channelsPage);
    await slashCommand.openSubcommandSuggestions();

    // * Verify only setup and about are suggested
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.setup)).toBeVisible();
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.about)).toBeVisible();
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.connect)).toHaveCount(0);
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.create)).toHaveCount(0);
});

/**
 * @objective Verify that a user is offered the connect, create and notifications subcommands once the plugin has a Google OAuth client configured
 */
test('offers connect, create and notifications subcommands once Google OAuth is configured', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin with a Google OAuth client
    const {adminClient, user, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, PLACEHOLDER_OAUTH);

    // # Log in as a regular user and open the subcommand suggestions
    const {channelsPage} = await pw.testBrowser.login(user);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const slashCommand = new DriveSlashCommand(channelsPage);
    await slashCommand.openSubcommandSuggestions();

    // * Verify the account and file subcommands are suggested
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.connect)).toBeVisible();
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.create)).toBeVisible();
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.notifications)).toBeVisible();

    // * Verify the admin-only setup subcommand is not suggested to a regular user
    await expect(slashCommand.subcommandSuggestion(DRIVE_SUBCOMMANDS.setup)).toHaveCount(0);
});

/**
 * @objective Verify that the plugin rejects file creation requests with 501 Not Implemented until a Google OAuth client is configured
 */
test('rejects Google Drive file creation with 501 until Google OAuth is configured', {tag: '@google_drive'}, async ({pw}) => {
    // # Enable the plugin without a Google OAuth client
    const {adminClient, userClient} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, UNCONFIGURED_OAUTH);

    // # Request a new Google Doc as a regular user
    const unconfiguredStatus = await postCreateFileStatus(userClient, 'doc');

    // * Verify the plugin reports that it is not configured
    expect(unconfiguredStatus).toBe(501);

    // # Configure a Google OAuth client and send a create request without a file type
    await ensureDrivePlugin(adminClient, PLACEHOLDER_OAUTH);
    const configuredStatus = await postCreateFileStatus(userClient);

    // * Verify the request passes the configuration check and reaches the handler, which rejects the missing file type
    expect(configuredStatus).toBe(400);
});
