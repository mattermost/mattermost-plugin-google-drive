// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {expect, Locator, Page} from '@playwright/test';

import type {DriveFileType} from '../lib/drive_api';

const TITLES: Record<DriveFileType, string> = {
    doc: 'Create a Google Doc',
    sheet: 'Create a Google Sheet',
    slide: 'Create a Google Slide',
};

/** "File Access" options (server/plugin/create.go). The `all_*` ones only appear when the Google domain allows link sharing. */
export const FILE_ACCESS = {
    private: 'Keep file private',
    membersView: 'Members of the channel can view',
    membersComment: 'Members of the channel can comment',
    membersEdit: 'Members of the channel can edit',
    anyoneView: 'Anyone with the link can view',
    anyoneComment: 'Anyone with the link can comment',
    anyoneEdit: 'Anyone with the link can edit',
} as const;

export type FileAccess = (typeof FILE_ACCESS)[keyof typeof FILE_ACCESS];

/**
 * The interactive dialog opened by `/google-drive create doc|sheet|slide`
 * (server/plugin/create.go). Rendered by core as role="dialog" with a level-1 heading.
 */
export class CreateFileDialog {
    readonly container: Locator;

    constructor(private readonly page: Page) {
        this.container = page.getByRole('dialog');
    }

    /** The modal itself, without the backdrop (for screenshots). */
    get content(): Locator {
        return this.container.getByRole('document');
    }

    heading(type: DriveFileType): Locator {
        return this.container.getByRole('heading', {level: 1, name: TITLES[type]});
    }

    get nameInput(): Locator {
        return this.container.getByRole('textbox', {name: /^Name/});
    }

    get messageInput(): Locator {
        return this.container.getByRole('textbox', {name: /^Message/});
    }

    /**
     * The File Access select. Core renders it without an accessible name (its "File Access" label
     * is not associated with the control), so it is found as the dialog's only combobox.
     */
    get fileAccessSelect(): Locator {
        return this.container.getByRole('combobox');
    }

    /** The open File Access select's options. */
    get fileAccessOptions(): Locator {
        return this.page.getByRole('listbox');
    }

    fileAccessOption(access: FileAccess): Locator {
        return this.page.getByRole('option', {name: access, exact: true});
    }

    get shareInChannelCheckbox(): Locator {
        return this.container.getByRole('checkbox', {name: /^Share in this Channel/});
    }

    get createButton(): Locator {
        return this.container.getByRole('button', {name: 'Create', exact: true});
    }

    get cancelButton(): Locator {
        return this.container.getByRole('button', {name: 'Cancel'});
    }

    async openFileAccessOptions() {
        await this.fileAccessSelect.click();
    }

    async chooseFileAccess(access: FileAccess) {
        await this.openFileAccessOptions();
        await this.fileAccessOption(access).click();
    }

    /** Fills the dialog, submits it and waits for it to close. */
    async create(options: {name: string; message?: string; access: FileAccess; shareInChannel: boolean}) {
        await this.nameInput.fill(options.name);
        if (options.message) {
            await this.messageInput.fill(options.message);
        }
        await this.chooseFileAccess(options.access);
        await this.shareInChannelCheckbox.setChecked(options.shareInChannel);
        await this.createButton.click();
        // Creating the file and setting permissions are several Google API calls.
        await expect(this.container).toHaveCount(0, {timeout: 30_000});
    }
}
