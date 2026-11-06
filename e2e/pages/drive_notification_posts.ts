// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ChannelsPage} from '@mattermost/playwright-lib';
import type {Locator, Page} from '@playwright/test';

/**
 * Responses to `/google-drive notifications start|stop` (ephemeral posts) and the Google Drive
 * bot's activity DMs. Texts from server/plugin/notifications.go.
 */
export class DriveNotificationPosts {
    constructor(private readonly channelsPage: ChannelsPage) {}

    /** Last post in the current channel that contains the given text. */
    private postWithText(text: string | RegExp): Locator {
        return this.channelsPage.centerView.container.getByRole('listitem').filter({hasText: text}).last();
    }

    get enabled(): Locator {
        return this.postWithText('Successfully enabled Google Drive activity notifications.');
    }

    get alreadyEnabled(): Locator {
        return this.postWithText('Google Drive activity notifications are already enabled for you.');
    }

    get disabled(): Locator {
        return this.postWithText('Successfully disabled Google Drive activity notifications.');
    }

    get notEnabled(): Locator {
        return this.postWithText('Google Drive activity notifications are not enabled for you.');
    }

    /** Bot DM: "<author> commented on <file>", with the comment quoted and a "Reply to comment" button. */
    commentNotification(author: string, fileName: string): Locator {
        return this.postWithText(`${author} commented on`).filter({hasText: fileName});
    }

    /** Bot DM: "<sharer> shared an item with you", with the file as the attachment title. */
    sharedNotification(fileName: string): Locator {
        return this.postWithText('shared an item with you').filter({hasText: fileName});
    }

    /** The content of a notification post, without the header (author, time) that core renders around it. */
    body(notification: Locator): Locator {
        return notification.locator('.post__body');
    }

    replyButton(notification: Locator): Locator {
        return notification.getByRole('button', {name: 'Reply to comment'});
    }

    /** Clicks the notification's "Reply to comment" button, which opens ReplyToCommentDialog. */
    async openReplyDialog(notification: Locator) {
        await this.replyButton(notification).click();
    }
}

/** The "Reply to comment" interactive dialog (server/plugin/api.go openCommentReplyDialog). */
export class ReplyToCommentDialog {
    readonly container: Locator;

    constructor(page: Page) {
        this.container = page.getByRole('dialog');
    }

    get heading(): Locator {
        return this.container.getByRole('heading', {level: 1, name: 'Reply to comment'});
    }

    /** The modal itself, without the backdrop (for screenshots). */
    get content(): Locator {
        return this.container.getByRole('document');
    }

    get message(): Locator {
        return this.container.getByRole('textbox', {name: /^Message/});
    }

    /** Fills the reply, submits it and waits for the dialog to close. */
    async reply(text: string) {
        await this.message.fill(text);
        await this.container.getByRole('button', {name: 'Reply', exact: true}).click();
        await this.container.waitFor({state: 'detached'});
    }
}
