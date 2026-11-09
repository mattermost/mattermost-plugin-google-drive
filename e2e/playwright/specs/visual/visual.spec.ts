// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Screenshot baselines of everything the plugin renders: its interactive dialogs and its bot
// posts. Run with `npm run test:visual`; after an intended UI change, run
// `npm run test:visual-update-snapshots` and review the PNGs in visual.spec.ts-snapshots/.
// Names below are fixed (no e2e-<runId>- prefix) because they appear in the screenshots; the
// fake Google holds the files, so nothing needs cleaning up.

import type {PlaywrightExtended} from '@mattermost/playwright-lib';

import {createPrivateChannelWith} from '../../lib/channels';
import {ensureDrivePlugin} from '../../lib/drive_plugin';
import {requireGoogle, seedConnectedGoogleUser} from '../../lib/google/auth';
import {addComment, createGoogleDoc, googleDisplayName, shareWithUser} from '../../lib/google/drive';
import {googleMode} from '../../lib/google/mode';
import {resetWatchChannel, stopTestWatchChannels} from '../../lib/kv';
import {postWithFiles} from '../../lib/posts';
import {expect, test} from '../../lib/test';
import {mattermostUserFor} from '../../lib/users';
import {clipAround, routeExternalRequests, settle} from '../../lib/visual';
import {CreateFileDialog, FILE_ACCESS} from '../../pages/create_file_dialog';
import {DriveAccountPosts} from '../../pages/drive_account_posts';
import {DriveFilePosts} from '../../pages/drive_file_posts';
import {DriveNotificationPosts, ReplyToCommentDialog} from '../../pages/drive_notification_posts';
import {DRIVE_SUBCOMMANDS, DriveSlashCommand} from '../../pages/drive_slash_command';
import {openUploadAction, UPLOAD_ACTIONS, UploadAllFilesDialog, UploadFileDialog} from '../../pages/upload_dialogs';

const NOTIFICATION_TIMEOUT = 60_000;

// The share DM prints the sharer's Mattermost username, so both users get fixed ones.
const USERNAMES = {owner: 'drive.owner', collab: 'drive.collab'};

test.describe('visual', {tag: '@visual'}, () => {
    test.skip(!process.env.PW_VISUAL_BROWSER_WS, 'Baselines only match the dockerized browser (npm run test:visual).');
    test.skip(googleMode() !== 'fake', 'Visual tests run against the fake Google only.');

    test.afterEach(async () => {
        // # Stop the test's Drive watch channel, so it gets no pushes from later tests
        await stopTestWatchChannels();
    });

    /**
     * Enables the plugin against the fake Google, connects the owner, and opens a private channel
     * of the owner and the collaborator in the owner's browser.
     */
    async function openOwnerChannel(pw: PlaywrightExtended) {
        const {oauth, accounts} = requireGoogle('owner', 'collab');
        const {adminClient, team} = await pw.initSetup();
        await ensureDrivePlugin(adminClient, oauth);
        const owner = await mattermostUserFor(adminClient, accounts.owner, team, USERNAMES.owner);
        const collaborator = await mattermostUserFor(adminClient, accounts.collab, team, USERNAMES.collab);
        const channel = await createPrivateChannelWith(adminClient, team, [owner.id, collaborator.id]);
        await seedConnectedGoogleUser(owner.id, accounts.owner);

        const {page, channelsPage} = await pw.testBrowser.login(owner);
        await routeExternalRequests(page);
        await channelsPage.goto(team.name, channel.name);
        await channelsPage.toBeVisible();
        return {page, channelsPage, team, channel, owner, accounts};
    }

    /**
     * @objective Verify the create file dialog renders like the baselines, closed and with the File Access options open
     *
     * @precondition
     * Run through `npm run test:visual`, which provides the fake Google and the dockerized browser the baselines come from
     */
    test('matches baselines for the create file dialog', {tag: '@google_drive'}, async ({pw}) => {
        // # Open the create dialog for a Google Doc
        const {page, channelsPage} = await openOwnerChannel(pw);
        await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.create, 'doc');
        const dialog = new CreateFileDialog(page);
        await expect(dialog.heading('doc')).toBeVisible();
        await settle(pw, dialog.content);

        // * Verify the dialog matches the baseline
        await expect(dialog.content).toHaveScreenshot('create-file-dialog.png');

        // # Open the File Access select
        await dialog.openFileAccessOptions();
        await expect(dialog.fileAccessOption(FILE_ACCESS.anyoneEdit)).toBeVisible();
        await settle(pw, dialog.content);

        // * Verify the dialog with all seven File Access options, including the link-sharing ones, matches the baseline
        await expect(dialog.fileAccessOption(FILE_ACCESS.anyoneEdit)).toBeInViewport();
        await expect(page).toHaveScreenshot('create-file-access-options.png', {clip: await clipAround(dialog.content, dialog.fileAccessOptions)});
    });

    /**
     * @objective Verify the upload file dialog renders like the baseline with its file select open
     *
     * @precondition
     * Run through `npm run test:visual`, which provides the fake Google and the dockerized browser the baselines come from
     */
    test('matches baseline for the upload file dialog', {tag: '@google_drive'}, async ({pw}) => {
        // # Post two files and open "Upload file to Google Drive" on the post
        const {page, channelsPage, channel, owner} = await openOwnerChannel(pw);
        const postId = await postWithFiles(owner, channel.id, 'Files for the launch review', ['meeting-notes.txt', 'launch-checklist.txt']);
        await openUploadAction(channelsPage, postId, UPLOAD_ACTIONS.file);
        const dialog = new UploadFileDialog(page);
        await expect(dialog.heading).toBeVisible();

        // # Open the file select
        await dialog.openFileSelect();
        await expect(dialog.fileOptions).toHaveCount(2);
        await settle(pw, dialog.content);

        // * Verify the dialog listing both files matches the baseline
        await expect(dialog.content).toHaveScreenshot('upload-file-dialog.png');
    });

    /**
     * @objective Verify the upload all files dialog renders like the baseline
     *
     * @precondition
     * Run through `npm run test:visual`, which provides the fake Google and the dockerized browser the baselines come from
     */
    test('matches baseline for the upload all files dialog', {tag: '@google_drive'}, async ({pw}) => {
        // # Post two files and open "Upload all files to Google Drive" on the post
        const {page, channelsPage, channel, owner} = await openOwnerChannel(pw);
        const postId = await postWithFiles(owner, channel.id, 'Files for the launch review', ['meeting-notes.txt', 'launch-checklist.txt']);
        await openUploadAction(channelsPage, postId, UPLOAD_ACTIONS.allFiles);
        const dialog = new UploadAllFilesDialog(page);
        await expect(dialog.introduction).toBeVisible();
        await settle(pw, dialog.content);

        // * Verify the dialog matches the baseline
        await expect(dialog.content).toHaveScreenshot('upload-all-files-dialog.png');
    });

    /**
     * @objective Verify the Google Drive bot's post for a file created and shared in the channel renders like the baseline
     *
     * @precondition
     * Run through `npm run test:visual`, which provides the fake Google (fixed created time) and the dockerized browser the baselines come from
     */
    test('matches baseline for the file created post', {tag: '@google_drive'}, async ({pw}) => {
        // # Create a Google Doc that channel members can comment on, shared in the channel with a message
        const {page, channelsPage} = await openOwnerChannel(pw);
        await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.create, 'doc');
        const dialog = new CreateFileDialog(page);
        await expect(dialog.heading('doc')).toBeVisible();
        const fileName = 'Launch plan';
        await dialog.create({name: fileName, message: 'First draft, comments welcome', access: FILE_ACCESS.membersComment, shareInChannel: true});

        // # Wait for the bot post
        const filePosts = new DriveFilePosts(channelsPage);
        await expect(filePosts.fileLink(fileName)).toBeVisible();
        const post = filePosts.fileCreatedPostBody(fileName);
        await settle(pw, post);

        // * Verify the post matches the baseline
        await expect(post).toHaveScreenshot('file-created-post.png');
    });

    /**
     * @objective Verify the comment notification DM and the Reply to comment dialog it opens render like the baselines
     *
     * @precondition
     * Run through `npm run test:visual`, which provides the fake Google (and its push notifications) and the dockerized browser the baselines come from
     */
    test('matches baselines for the comment notification and the reply dialog', {tag: '@google_drive'}, async ({pw}) => {
        // # Share a Google Doc of the owner's with the collaborator and start the owner's notifications
        const {page, channelsPage, team, owner, accounts} = await openOwnerChannel(pw);
        await resetWatchChannel(accounts.owner, owner.id);
        const file = await createGoogleDoc(accounts.owner, 'Quarterly report');
        await shareWithUser(accounts.owner, file.id, accounts.collab.email, 'commenter');
        const notifications = new DriveNotificationPosts(channelsPage);
        await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.notifications, 'start');
        await expect(notifications.enabled).toBeVisible();

        // # Comment on the file as the collaborator and open the owner's bot DM
        await addComment(accounts.collab, file.id, 'Can we add the figures for March?');
        await new DriveAccountPosts(channelsPage).openBotDM(team.name);
        const notification = notifications.commentNotification(await googleDisplayName(accounts.collab), file.name);
        await expect(notification).toBeVisible({timeout: NOTIFICATION_TIMEOUT});
        const body = notifications.body(notification);
        await settle(pw, body);

        // * Verify the DM with the quoted comment and the Reply to comment button matches the baseline
        await expect(body).toHaveScreenshot('comment-notification-dm.png');

        // # Open the reply dialog from the DM
        await notifications.openReplyDialog(notification);
        const dialog = new ReplyToCommentDialog(page);
        await expect(dialog.heading).toBeVisible();
        await settle(pw, dialog.content);

        // * Verify the reply dialog matches the baseline
        await expect(dialog.content).toHaveScreenshot('reply-to-comment-dialog.png');
    });

    /**
     * @objective Verify the DM telling a user that someone shared a file with them renders like the baseline
     *
     * @precondition
     * Run through `npm run test:visual`, which provides the fake Google (and its push notifications) and the dockerized browser the baselines come from
     */
    test('matches baseline for the file shared notification', {tag: '@google_drive'}, async ({pw}) => {
        // # Start the owner's notifications, then create a Google Doc as the collaborator and share it with the owner
        const {channelsPage, team, owner, accounts} = await openOwnerChannel(pw);
        await resetWatchChannel(accounts.owner, owner.id);
        const notifications = new DriveNotificationPosts(channelsPage);
        await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.notifications, 'start');
        await expect(notifications.enabled).toBeVisible();
        const file = await createGoogleDoc(accounts.collab, 'Team budget');
        await shareWithUser(accounts.collab, file.id, accounts.owner.email, 'reader');

        // # Open the owner's bot DM
        await new DriveAccountPosts(channelsPage).openBotDM(team.name);
        const notification = notifications.sharedNotification(file.name);
        await expect(notification).toBeVisible({timeout: NOTIFICATION_TIMEOUT});
        const body = notifications.body(notification);
        await settle(pw, body);

        // * Verify the DM matches the baseline
        await expect(body).toHaveScreenshot('file-shared-dm.png');
    });
});
