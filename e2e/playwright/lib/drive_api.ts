// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {Client4} from '@mattermost/client';

import {PLUGIN_ID} from './drive_plugin';

export type DriveFileType = 'doc' | 'sheet' | 'slide';

/**
 * Calls the plugin's create-file endpoint (the create dialog's submit URL) as the given user and
 * returns the HTTP status. Used to check the plugin's "not configured" gate. Without `type`, a
 * request that passes the gate gets the handler's own 400 ("File type not found").
 */
export async function postCreateFileStatus(userClient: Client4, type?: DriveFileType): Promise<number> {
    const url = `${userClient.getUrl()}/plugins/${PLUGIN_ID}/api/v1/create${type ? `?type=${type}` : ''}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${userClient.getToken()}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({}),
    });
    return response.status;
}

/**
 * Sends the plugin a Drive push notification for the user, the way Google delivers one
 * (POST /api/v1/webhook, no Mattermost session), and returns the HTTP status.
 */
export async function postDriveWebhookStatus(baseUrl: string, mmUserId: string, channelToken: string): Promise<number> {
    const response = await fetch(`${baseUrl}/plugins/${PLUGIN_ID}/api/v1/webhook?userID=${mmUserId}`, {
        method: 'POST',
        headers: {
            'X-Goog-Resource-State': 'change',
            'X-Goog-Channel-Token': channelToken,
        },
    });
    return response.status;
}
