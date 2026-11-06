// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ChannelsPage} from '@mattermost/playwright-lib';
import type {Locator} from '@playwright/test';

/**
 * Posts the Google Drive bot makes about created files (server/plugin/create.go
 * sendFileCreatedMessage): a channel post when "Share in this Channel" is ticked, otherwise a DM
 * to the creator. Both carry a message attachment whose title links to the file.
 */
export class DriveFilePosts {
    constructor(private readonly channelsPage: ChannelsPage) {}

    /** The bot post (in the current channel) for the named file. */
    fileCreatedPost(fileName: string): Locator {
        return this.channelsPage.centerView.container.getByRole('listitem').filter({hasText: fileName}).last();
    }

    /** The content of that post, without the header (author, time) that core renders around it. */
    fileCreatedPostBody(fileName: string): Locator {
        return this.fileCreatedPost(fileName).locator('.post__body');
    }

    /** The attachment title link to the named file. */
    fileLink(fileName: string): Locator {
        return this.fileCreatedPost(fileName).getByRole('link', {name: fileName});
    }

    /** The "You created a new file" text of the creator's DM (when not shared in the channel). */
    createdForYouNotice(fileName: string): Locator {
        return this.fileCreatedPost(fileName).getByText('You created a new file with following message:');
    }
}
