// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {createPrivateChannelWith} from '../lib/channels';
import {ensureDrivePlugin} from '../lib/drive_plugin';
import {fakeGoogle} from '../lib/fake_google';
import {configuredGoogleAccount, requireGoogle, seedConnectedGoogleUser} from '../lib/google/auth';
import {trashRunFiles, e2eFileName, fileIdFromLink, getFile, GOOGLE_MIME_TYPES, listPermissions} from '../lib/google/drive';
import {requireFakeGoogle} from '../lib/google/mode';
import {expect, test} from '../lib/test';
import {mattermostUserFor} from '../lib/users';
import {CreateFileDialog, FILE_ACCESS} from '../pages/create_file_dialog';
import {DriveAccountPosts} from '../pages/drive_account_posts';
import {DriveFilePosts} from '../pages/drive_file_posts';
import {DRIVE_SUBCOMMANDS, DriveSlashCommand} from '../pages/drive_slash_command';

test.afterEach(async () => {
    // # Move the Google files this run created to the owner's Drive trash
    const owner = configuredGoogleAccount('owner');
    if (owner) {
        await trashRunFiles(owner);
    }
});

/**
 * @objective Verify that a Google Doc created from the slash command is shared with the other channel members as commenters and posted in the channel
 *
 * @precondition
 * Real Google OAuth client; owner and collaborator test accounts connected (npm run google:auth); a private channel whose only members are those two users
 */
test('creates a Google Doc shared with channel members as commenters and posts it in the channel', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner', 'collab');

    // # Enable the plugin with the real OAuth client and set up the owner, collaborator and their channel
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    const collaborator = await mattermostUserFor(adminClient, accounts.collab, team);
    const channel = await createPrivateChannelWith(adminClient, team, [owner.id, collaborator.id]);
    await seedConnectedGoogleUser(owner.id, accounts.owner);

    // # Log in as the owner and create a Google Doc that channel members can comment on, shared in the channel
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name, channel.name);
    await channelsPage.toBeVisible();
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.create, 'doc');
    const fileName = e2eFileName('doc');
    const dialog = new CreateFileDialog(page);
    await expect(dialog.heading('doc')).toBeVisible();
    await dialog.create({name: fileName, message: `Review notes ${pw.random.id()}`, access: FILE_ACCESS.membersComment, shareInChannel: true});

    // * Verify the Google Drive bot posts a link to the new file in the channel
    const filePosts = new DriveFilePosts(channelsPage);
    await expect(filePosts.fileLink(fileName)).toBeVisible();
    const fileId = fileIdFromLink((await filePosts.fileLink(fileName).getAttribute('href'))!);

    // * Verify Google Drive has a Google Doc with that name
    const file = await getFile(accounts.owner, fileId);
    expect(file.name).toBe(fileName);
    expect(file.mimeType).toBe(GOOGLE_MIME_TYPES.doc);

    // * Verify the collaborator was given comment access and the file is not shared publicly
    const permissions = await listPermissions(accounts.owner, fileId);
    expect(permissions).toContainEqual({type: 'user', role: 'commenter', emailAddress: accounts.collab.email});
    expect(permissions.filter((p) => p.type === 'anyone')).toHaveLength(0);
});

/**
 * @objective Verify that a private Google Sheet is shared with nobody else and its link is sent to the creator in a Google Drive bot DM
 *
 * @precondition
 * Real Google OAuth client and the owner test account connected (npm run google:auth -- owner)
 */
test('creates a private Google Sheet and sends its link to the creator in a bot DM', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner');

    // # Enable the plugin with the real OAuth client and connect the owner
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);

    // # Log in as the owner and create a private Google Sheet without sharing it in the channel
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.create, 'sheet');
    const fileName = e2eFileName('sheet');
    const dialog = new CreateFileDialog(page);
    await expect(dialog.heading('sheet')).toBeVisible();
    await dialog.create({name: fileName, message: `Budget ${pw.random.id()}`, access: FILE_ACCESS.private, shareInChannel: false});

    // * Verify the Google Drive bot sends the creator a DM linking to the new file
    await new DriveAccountPosts(channelsPage).openBotDM(team.name);
    const filePosts = new DriveFilePosts(channelsPage);
    await expect(filePosts.createdForYouNotice(fileName)).toBeVisible();
    const fileId = fileIdFromLink((await filePosts.fileLink(fileName).getAttribute('href'))!);

    // * Verify Google Drive has a Google Sheet with that name that only the owner can access
    expect((await getFile(accounts.owner, fileId)).mimeType).toBe(GOOGLE_MIME_TYPES.sheet);
    const permissions = await listPermissions(accounts.owner, fileId);
    expect(permissions).toEqual([{type: 'user', role: 'owner', emailAddress: accounts.owner.email}]);
});

/**
 * @objective Verify that a Google Slides presentation can be made viewable by anyone with the link
 *
 * @precondition
 * Real Google OAuth client and the owner test account connected; the account's Google domain allows link sharing
 */
test('creates a Google Slides presentation viewable by anyone with the link', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner');

    // # Enable the plugin with the real OAuth client and connect the owner
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);

    // # Log in as the owner and create a presentation that anyone with the link can view
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.create, 'slide');
    const fileName = e2eFileName('slide');
    const dialog = new CreateFileDialog(page);
    await expect(dialog.heading('slide')).toBeVisible();
    await dialog.create({name: fileName, access: FILE_ACCESS.anyoneView, shareInChannel: true});

    // * Verify the Google Drive bot posts a link to the new presentation in the channel
    const filePosts = new DriveFilePosts(channelsPage);
    await expect(filePosts.fileLink(fileName)).toBeVisible();
    const fileId = fileIdFromLink((await filePosts.fileLink(fileName).getAttribute('href'))!);

    // * Verify Google Drive has a presentation that anyone with the link can view
    expect((await getFile(accounts.owner, fileId)).mimeType).toBe(GOOGLE_MIME_TYPES.slide);
    expect(await listPermissions(accounts.owner, fileId)).toContainEqual({type: 'anyone', role: 'reader', emailAddress: undefined});
});

/**
 * @objective Verify that the create dialog offers no "Anyone with the link" access when the user's Google domain does not allow link sharing
 *
 * @precondition
 * Fake Google, set to report a domain sharing policy of disallowed
 */
test('hides link-sharing access options when the Google domain disallows link sharing', {tag: '@google_drive'}, async ({pw}) => {
    requireFakeGoogle();
    const {oauth, accounts} = requireGoogle('owner');

    // # Make the owner's Google domain disallow link sharing, then enable the plugin and connect the owner
    await fakeGoogle.setDomainSharingPolicy('disallowed');
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);

    // # Log in as the owner, open the create dialog for a Google Doc and open File Access
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    await new DriveSlashCommand(channelsPage).run(DRIVE_SUBCOMMANDS.create, 'doc');
    const dialog = new CreateFileDialog(page);
    await expect(dialog.heading('doc')).toBeVisible();
    await dialog.openFileAccessOptions();

    // * Verify the private and channel-member options are offered
    for (const access of [FILE_ACCESS.private, FILE_ACCESS.membersView, FILE_ACCESS.membersComment, FILE_ACCESS.membersEdit]) {
        await expect(dialog.fileAccessOption(access)).toBeVisible();
    }

    // * Verify none of the "Anyone with the link" options are offered
    for (const access of [FILE_ACCESS.anyoneView, FILE_ACCESS.anyoneComment, FILE_ACCESS.anyoneEdit]) {
        await expect(dialog.fileAccessOption(access)).toHaveCount(0);
    }
});
