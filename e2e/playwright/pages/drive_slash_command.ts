// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ChannelsPage} from '@mattermost/playwright-lib';
import {expect, Locator} from '@playwright/test';

export const DRIVE_SUBCOMMANDS = {
    setup: 'setup',
    about: 'about',
    connect: 'connect',
    disconnect: 'disconnect',
    create: 'create',
    notifications: 'notifications',
    help: 'help',
} as const;

export type DriveSubcommand = (typeof DRIVE_SUBCOMMANDS)[keyof typeof DRIVE_SUBCOMMANDS];

/** The `/google-drive` slash command as typed into the channel message box. */
export class DriveSlashCommand {
    static readonly trigger = '/google-drive';

    constructor(private readonly channelsPage: ChannelsPage) {}

    private get postCreate() {
        return this.channelsPage.centerView.postCreate;
    }

    /** Types the trigger and waits for the subcommand suggestions to open. */
    async openSubcommandSuggestions() {
        await this.postCreate.writeMessage(`${DriveSlashCommand.trigger} `);
        await expect(this.postCreate.suggestionList).toBeVisible();
    }

    /** The suggestion row for a subcommand (rows start with the subcommand name). */
    subcommandSuggestion(subcommand: DriveSubcommand): Locator {
        return this.postCreate.suggestionList
            .getByRole('option')
            .filter({hasText: new RegExp(`^\\s*${subcommand}\\b`)});
    }

    /**
     * Sends `/google-drive <subcommand> [...args]` and waits for the server to finish handling it
     * (same approach as mattermost-server's demo plugin specs, sendDemoSlashCommand).
     */
    async run(subcommand: DriveSubcommand, ...args: string[]) {
        const page = this.channelsPage.page;
        const executed = page.waitForResponse(
            (r) => r.url().includes('/api/v4/commands/execute') && r.request().method() === 'POST',
        );
        await this.postCreate.input.fill([DriveSlashCommand.trigger, subcommand, ...args].join(' '));
        await this.postCreate.sendMessage();
        await executed;
    }
}
