// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {postDriveWebhookStatus} from '../lib/drive_api';
import {ensureDrivePlugin} from '../lib/drive_plugin';
import {configuredGoogleAccount, requireGoogle, seedConnectedGoogleUser} from '../lib/google/auth';
import {addComment, createGoogleDoc, e2eFileName, getComment, googleDisplayName, shareWithUser, trashRunFiles} from '../lib/google/drive';
import {requireDrivePush} from '../lib/google/mode';
import {clearWatchChannel, hasWatchChannel, watchChannelToken} from '../lib/kv';
import {expect, test} from '../lib/test';
import {mattermostUserFor} from '../lib/users';
import {DriveAccountPosts} from '../pages/drive_account_posts';
import {DriveNotificationPosts, ReplyToCommentDialog} from '../pages/drive_notification_posts';
import {DRIVE_SUBCOMMANDS, DriveSlashCommand} from '../pages/drive_slash_command';

// Drive push can take a few seconds to reach the plugin, and the plugin then reads the changes
// feed and Drive Activity before posting.
const NOTIFICATION_TIMEOUT = 60_000;

test.afterEach(async () => {
    // # Move the Google files this run created to the owners' Drive trash
    for (const role of ['owner', 'collab'] as const) {
        const account = configuredGoogleAccount(role);
        if (account) {
            await trashRunFiles(account);
        }
    }
});

/**
 * @objective Verify that a comment on a user's Google Doc arrives as a Google Drive bot DM and that replying from Mattermost adds the reply to the comment thread in Google Drive
 *
 * @precondition
 * Owner and collaborator Google accounts connected; Drive push notifications reach the plugin (fake Google, or a public HTTPS SiteURL)
 */
test('notifies the owner of a comment on their Google Doc and posts the reply from Mattermost to the comment thread', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner', 'collab');
    requireDrivePush();

    // # Enable the plugin, connect the owner and share a new Google Doc with the collaborator
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);
    await clearWatchChannel(owner.id);
    const file = await createGoogleDoc(accounts.owner, e2eFileName('comments'));
    await shareWithUser(accounts.owner, file.id, accounts.collab.email, 'commenter');

    // # Log in as the owner and start activity notifications
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const notifications = new DriveNotificationPosts(channelsPage);
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.notifications, 'start');
    await expect(notifications.enabled).toBeVisible();

    // # Comment on the file as the collaborator, in Google Drive
    const commentText = `Please check the numbers ${pw.random.id()}`;
    const comment = await addComment(accounts.collab, file.id, commentText);

    // * Verify the Google Drive bot DMs the owner the comment, naming the collaborator and the file
    await new DriveAccountPosts(channelsPage).openBotDM(team.name);
    const notification = notifications.commentNotification(await googleDisplayName(accounts.collab), file.name);
    await expect(notification).toBeVisible({timeout: NOTIFICATION_TIMEOUT});
    await expect(notification).toContainText(commentText);

    // # Reply to the comment from the DM
    await notifications.openReplyDialog(notification);
    const dialog = new ReplyToCommentDialog(page);
    await expect(dialog.heading).toBeVisible();
    const replyText = `Numbers checked ${pw.random.id()}`;
    await dialog.reply(replyText);

    // * Verify the reply was added to the comment thread in Google Drive, written by the owner
    await expect
        .poll(async () => (await getComment(accounts.collab, file.id, comment.id)).replies.map((r) => r.content))
        .toContain(replyText);
});

/**
 * @objective Verify that a Google Drive bot DM tells a user when someone shares a Google Doc with them
 *
 * @precondition
 * Owner and collaborator Google accounts connected; Drive push notifications reach the plugin (fake Google, or a public HTTPS SiteURL)
 */
test('notifies a user when a collaborator shares a Google Doc with them', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner', 'collab');
    requireDrivePush();

    // # Enable the plugin and connect the owner, who will receive the share
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);
    await clearWatchChannel(owner.id);

    // # Log in as the owner and start activity notifications
    const {channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const notifications = new DriveNotificationPosts(channelsPage);
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.notifications, 'start');
    await expect(notifications.enabled).toBeVisible();

    // # Create a Google Doc as the collaborator and share it with the owner, in Google Drive
    const file = await createGoogleDoc(accounts.collab, e2eFileName('shared'));
    await shareWithUser(accounts.collab, file.id, accounts.owner.email, 'reader');

    // * Verify the Google Drive bot DMs the owner that the collaborator shared the file
    await new DriveAccountPosts(channelsPage).openBotDM(team.name);
    const notification = notifications.sharedNotification(file.name);
    await expect(notification).toBeVisible({timeout: NOTIFICATION_TIMEOUT});
    await expect(notification).toContainText(await googleDisplayName(accounts.collab));
});

/**
 * @objective Verify that activity notifications can be started and stopped once each, and that stopping removes the plugin's Drive watch channel
 *
 * @precondition
 * Owner Google account connected; Drive accepts the plugin's webhook address (fake Google, or a public HTTPS SiteURL)
 */
test('starts and stops Google Drive activity notifications and reports when they are already in that state', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner');
    requireDrivePush();

    // # Enable the plugin and connect the owner
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);
    await clearWatchChannel(owner.id);

    // # Log in as the owner and start notifications twice
    const {channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const slashCommand = new DriveSlashCommand(channelsPage);
    const notifications = new DriveNotificationPosts(channelsPage);
    await slashCommand.run(DRIVE_SUBCOMMANDS.notifications, 'start');
    await expect(notifications.enabled).toBeVisible();
    await slashCommand.run(DRIVE_SUBCOMMANDS.notifications, 'start');

    // * Verify the plugin registered a Drive watch channel and does not register a second one
    await expect(notifications.alreadyEnabled).toBeVisible();
    expect(await hasWatchChannel(owner.id)).toBe(true);

    // # Stop notifications twice
    await slashCommand.run(DRIVE_SUBCOMMANDS.notifications, 'stop');
    await expect(notifications.disabled).toBeVisible();
    await slashCommand.run(DRIVE_SUBCOMMANDS.notifications, 'stop');

    // * Verify the watch channel is gone and the plugin says notifications are not enabled
    await expect(notifications.notEnabled).toBeVisible();
    expect(await hasWatchChannel(owner.id)).toBe(false);
});

/**
 * @objective Verify that the plugin's Drive webhook rejects a push notification whose channel token does not match the user's watch channel, and accepts the right one
 *
 * @precondition
 * Owner Google account connected; Drive accepts the plugin's webhook address (fake Google, or a public HTTPS SiteURL)
 */
test('rejects a Drive push notification with the wrong channel token', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner');
    requireDrivePush();

    // # Enable the plugin, connect the owner and start notifications
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);
    await clearWatchChannel(owner.id);
    const {channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const slashCommand = new DriveSlashCommand(channelsPage);
    const notifications = new DriveNotificationPosts(channelsPage);
    await slashCommand.run(DRIVE_SUBCOMMANDS.notifications, 'start');
    await expect(notifications.enabled).toBeVisible();

    // # Send the webhook a push for the owner with a token that is not the watch channel's
    const baseUrl = adminClient.getUrl();
    const wrongTokenStatus = await postDriveWebhookStatus(baseUrl, owner.id, `not-the-channel-token-${pw.random.id()}`);

    // * Verify the plugin rejects it
    expect(wrongTokenStatus).toBe(400);

    // # Send the same push with the watch channel's token
    const rightTokenStatus = await postDriveWebhookStatus(baseUrl, owner.id, await watchChannelToken(owner.id));

    // * Verify the plugin accepts it
    expect(rightTokenStatus).toBe(200);

    // # Stop notifications
    await slashCommand.run(DRIVE_SUBCOMMANDS.notifications, 'stop');
    await expect(notifications.disabled).toBeVisible();
});
