// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ChannelsPage} from '@mattermost/playwright-lib';
import type {Locator, Page} from '@playwright/test';

export const DRIVE_BOT_USERNAME = 'google-drive';

/**
 * Responses to `/google-drive connect|disconnect` (ephemeral posts in the current channel) and
 * the Google Drive bot's account-connection DMs. Texts from server/plugin/command.go and api.go.
 */
export class DriveAccountPosts {
    constructor(private readonly channelsPage: ChannelsPage) {}

    /** Last post in the current channel that contains the given text. */
    private postWithText(text: string | RegExp): Locator {
        return this.channelsPage.centerView.container.getByRole('listitem').filter({hasText: text}).last();
    }

    get connectLink(): Locator {
        return this.channelsPage.centerView.container
            .getByRole('link', {name: 'Click here to link your Google account.'})
            .last();
    }

    /** Follows the link `/google-drive connect` posts, which starts the Google OAuth flow. */
    async clickConnectLink() {
        await this.connectLink.click();
    }

    /** Follows the connect link, which opens in a new tab, and returns that tab. */
    async openConnectLink(): Promise<Page> {
        const [tab] = await Promise.all([this.channelsPage.page.context().waitForEvent('page'), this.connectLink.click()]);
        return tab;
    }

    /** Bot DM sent once an account is connected (server/plugin/api.go completeConnectUserToGoogle). */
    get welcome(): Locator {
        return this.postWithText('Welcome to the Mattermost Google Drive Plugin!');
    }

    get alreadyConnected(): Locator {
        return this.postWithText('You have already connected your Google account.');
    }

    get disconnected(): Locator {
        return this.postWithText('Disconnected your Google account.');
    }

    get noAccountConnected(): Locator {
        return this.postWithText('There is no Google account connected to your Mattermost account.');
    }

    /** Opens the DM channel with the Google Drive bot. */
    async openBotDM(teamName: string) {
        await this.channelsPage.goto(teamName, `@${DRIVE_BOT_USERNAME}`);
        await this.channelsPage.toBeVisible();
    }

    /** Bot DM reporting a failed connection; `reason` is the error the OAuth callback returned. */
    connectionError(reason: string): Locator {
        return this.postWithText(`There was an error connecting to your Google account: ${reason}`);
    }
}
