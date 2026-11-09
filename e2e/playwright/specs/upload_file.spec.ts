// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import crypto from 'crypto';

import {ensureDrivePlugin} from '../lib/drive_plugin';
import {configuredGoogleAccount, GoogleAccount, requireGoogle, seedConnectedGoogleUser} from '../lib/google/auth';
import {e2eFileName, findFilesByNamePrefix, trashRunFiles} from '../lib/google/drive';
import {postedFileContent, postWithFiles} from '../lib/posts';
import {expect, test} from '../lib/test';
import {mattermostUserFor} from '../lib/users';
import {openUploadAction, UPLOAD_ACTIONS, UploadAllFilesDialog, UploadFileDialog, UploadPosts} from '../pages/upload_dialogs';

test.afterEach(async () => {
    // # Move the Google files this run created to the owner's Drive trash
    const owner = configuredGoogleAccount('owner');
    if (owner) {
        await trashRunFiles(owner);
    }
});

/** The run's files in the owner's Drive, with their content checksums, sorted by name. */
async function uploadedFiles(account: GoogleAccount): Promise<Array<{name: string; md5Checksum?: string}>> {
    const files = await findFilesByNamePrefix(account, `e2e-${process.env.E2E_RUN_ID}-`);
    return files.map(({name, md5Checksum}) => ({name, md5Checksum})).sort((a, b) => a.name.localeCompare(b.name));
}

/** What uploadedFiles returns for a file posted by postWithFiles and uploaded intact. */
function posted(name: string) {
    return {name, md5Checksum: crypto.createHash('md5').update(postedFileContent(name)).digest('hex')};
}

/**
 * @objective Verify that "Upload file to Google Drive" uploads only the chosen attachment of a post to the user's Drive
 *
 * @precondition
 * Google OAuth client and the owner test account connected (fake Google, or npm run google:auth -- owner)
 */
test('uploads the chosen attachment of a post to Google Drive from the post menu', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner');

    // # Enable the plugin, connect the owner and post a message with two files
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const channel = await adminClient.getChannelByName(team.id, 'town-square');
    const [chosen, other] = [`${e2eFileName('notes')}.txt`, `${e2eFileName('checklist')}.txt`];
    const postId = await postWithFiles(owner, channel.id, `Files to upload ${pw.random.id()}`, [chosen, other]);

    // # Upload one of the two files from the post menu
    await openUploadAction(channelsPage, postId, UPLOAD_ACTIONS.file);
    const dialog = new UploadFileDialog(page);
    await expect(dialog.heading).toBeVisible();
    await dialog.upload(chosen);

    // * Verify the plugin confirms the upload
    await expect(new UploadPosts(channelsPage).fileUploaded).toBeVisible();

    // * Verify only the chosen file is in the owner's Google Drive, with the posted contents
    expect(await uploadedFiles(accounts.owner)).toEqual([posted(chosen)]);
});

/**
 * @objective Verify that "Upload all files to Google Drive" uploads every attachment of a post to the user's Drive
 *
 * @precondition
 * Google OAuth client and the owner test account connected (fake Google, or npm run google:auth -- owner)
 */
test('uploads all attachments of a post to Google Drive from the post menu', {tag: '@google_drive'}, async ({pw}) => {
    const {oauth, accounts} = requireGoogle('owner');

    // # Enable the plugin, connect the owner and post a message with two files
    const {adminClient, team} = await pw.initSetup();
    await ensureDrivePlugin(adminClient, oauth);
    const owner = await mattermostUserFor(adminClient, accounts.owner, team);
    await seedConnectedGoogleUser(owner.id, accounts.owner);
    const {page, channelsPage} = await pw.testBrowser.login(owner);
    await channelsPage.goto(team.name);
    await channelsPage.toBeVisible();
    const channel = await adminClient.getChannelByName(team.id, 'town-square');
    const names = [`${e2eFileName('notes')}.txt`, `${e2eFileName('checklist')}.txt`];
    const postId = await postWithFiles(owner, channel.id, `Files to upload ${pw.random.id()}`, names);

    // # Upload all files from the post menu
    await openUploadAction(channelsPage, postId, UPLOAD_ACTIONS.allFiles);
    const dialog = new UploadAllFilesDialog(page);
    await expect(dialog.heading).toBeVisible();
    await dialog.submit();

    // * Verify the plugin confirms the upload
    await expect(new UploadPosts(channelsPage).allFilesUploaded).toBeVisible();

    // * Verify both files are in the owner's Google Drive, with the posted contents
    expect(await uploadedFiles(accounts.owner)).toEqual([...names].sort().map(posted));
});
