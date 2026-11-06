// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ChannelsPage} from '@mattermost/playwright-lib';
import type {Locator, Page} from '@playwright/test';

/** The plugin's two post menu actions (webapp/src/index.tsx). "Upload all" needs 2+ files on the post. */
export const UPLOAD_ACTIONS = {
    file: 'Upload file to Google Drive',
    allFiles: 'Upload all files to Google Drive',
} as const;

export type UploadAction = (typeof UPLOAD_ACTIONS)[keyof typeof UPLOAD_ACTIONS];

/** Opens one of the plugin's upload actions from a post's "Message actions" menu. */
export async function openUploadAction(channelsPage: ChannelsPage, postId: string, action: UploadAction) {
    const post = await channelsPage.centerView.getPostById(postId);
    await post.hover();
    await post.postMenu.actionsButton.click();
    await channelsPage.page.getByRole('menuitem', {name: action}).click();
}

/**
 * The "Upload to Google Drive" interactive dialog the webapp opens for "Upload file to Google
 * Drive": one select listing the post's files.
 */
export class UploadFileDialog {
    readonly container: Locator;

    constructor(private readonly page: Page) {
        this.container = page.getByRole('dialog');
    }

    get heading(): Locator {
        return this.container.getByRole('heading', {level: 1, name: 'Upload to Google Drive'});
    }

    /** The modal itself, without the backdrop (for screenshots). */
    get content(): Locator {
        return this.container.getByRole('document');
    }

    /** The file select. Like the create dialog's File Access select, it has no accessible name. */
    get fileSelect(): Locator {
        return this.container.getByRole('combobox');
    }

    /** The open select's file names. */
    get fileOptions(): Locator {
        return this.page.getByRole('option');
    }

    async openFileSelect() {
        await this.fileSelect.click();
    }

    /** Chooses the named file, submits and waits for the dialog to close. */
    async upload(fileName: string) {
        await this.openFileSelect();
        await this.page.getByRole('option', {name: fileName, exact: true}).click();
        await this.container.getByRole('button', {name: 'Submit'}).click();
        await this.container.waitFor({state: 'detached'});
    }
}

/** The "Upload all files to Google Drive" interactive dialog: introduction text and Submit, no fields. */
export class UploadAllFilesDialog {
    readonly container: Locator;

    constructor(page: Page) {
        this.container = page.getByRole('dialog');
    }

    get heading(): Locator {
        return this.container.getByRole('heading', {level: 1, name: 'Upload all files to Google Drive'});
    }

    get introduction(): Locator {
        return this.container.getByText('All files attached to this message will be uploaded to your Google Drive.');
    }

    /** The modal itself, without the backdrop (for screenshots). */
    get content(): Locator {
        return this.container.getByRole('document');
    }

    /** Submits and waits for the dialog to close. */
    async submit() {
        await this.container.getByRole('button', {name: 'Submit'}).click();
        await this.container.waitFor({state: 'detached'});
    }
}

/** The ephemeral posts the plugin sends after an upload (server/plugin/api.go handleFileUpload, handleAllFilesUpload). */
export class UploadPosts {
    constructor(private readonly channelsPage: ChannelsPage) {}

    private postWithText(text: string): Locator {
        return this.channelsPage.centerView.container.getByRole('listitem').filter({hasText: text}).last();
    }

    get fileUploaded(): Locator {
        return this.postWithText('Successfully uploaded file in Google Drive.');
    }

    get allFilesUploaded(): Locator {
        return this.postWithText('Successfully uploaded all files in Google Drive.');
    }
}
