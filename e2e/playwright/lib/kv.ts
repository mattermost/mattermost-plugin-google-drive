// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Direct access to the plugin's rows in PluginKeyValueStore. Mattermost has no REST or mmctl path
// to write another plugin's KV, so tests seed it in Postgres, as mattermost-server's
// specs/functional/system_console/abac/masking/masking_db_setup.ts does.

import {Client} from 'pg';

import {PLUGIN_ID, TEST_ENCRYPTION_KEY} from './drive_plugin';
import {encrypt} from './crypto';
import {GoogleAccount} from './google/auth';
import {stopDriveChannel} from './google/drive';

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
    const connectionString = process.env.E2E_DATABASE_URL;
    if (!connectionString) {
        throw new Error('E2E_DATABASE_URL is not set; it is exported by global_setup.ts.');
    }
    const db = new Client({connectionString});
    await db.connect();
    try {
        return await fn(db);
    } finally {
        await db.end();
    }
}

export async function kvGet(key: string): Promise<Buffer | null> {
    return withDb(async (db) => {
        const {rows} = await db.query('SELECT pvalue FROM pluginkeyvaluestore WHERE pluginid = $1 AND pkey = $2', [
            PLUGIN_ID,
            key,
        ]);
        return rows.length ? (rows[0].pvalue as Buffer) : null;
    });
}

export async function kvSet(key: string, value: Buffer) {
    await withDb((db) =>
        db.query(
            `INSERT INTO pluginkeyvaluestore (pluginid, pkey, pvalue, expireat) VALUES ($1, $2, $3, 0)
             ON CONFLICT (pluginid, pkey) DO UPDATE SET pvalue = EXCLUDED.pvalue, expireat = 0`,
            [PLUGIN_ID, key, value],
        ),
    );
}

export async function kvDelete(key: string) {
    await withDb((db) => db.query('DELETE FROM pluginkeyvaluestore WHERE pluginid = $1 AND pkey = $2', [PLUGIN_ID, key]));
}

export const userTokenKey = (mmUserId: string) => `${mmUserId}_token`;

export type GoogleOAuthToken = {
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expiry?: string;
};

/**
 * Stores a Google OAuth token for the user exactly as the plugin's OAuth callback would
 * (server/plugin/api.go completeConnectUserToGoogle), so the user counts as connected.
 */
export async function seedGoogleUserToken(mmUserId: string, token: GoogleOAuthToken) {
    const encrypted = encrypt(TEST_ENCRYPTION_KEY, JSON.stringify(token));
    await kvSet(userTokenKey(mmUserId), Buffer.from(encrypted, 'utf8'));
}

export async function hasGoogleUserToken(mmUserId: string): Promise<boolean> {
    return (await kvGet(userTokenKey(mmUserId))) !== null;
}

/** The plugin's Drive watch channel for the user (server/plugin/kvstore/google.go getWatchChannelDataKey). */
export const watchChannelKey = (mmUserId: string) => `drive_change_channels-${mmUserId}`;

/** The secret Drive sends back in X-Goog-Channel-Token with every push (model.WatchChannelData.Token). */
export async function watchChannelToken(mmUserId: string): Promise<string> {
    const value = await kvGet(watchChannelKey(mmUserId));
    if (!value) {
        throw new Error(`No Drive watch channel stored for user ${mmUserId}`);
    }
    return (JSON.parse(value.toString('utf8')) as {token: string}).token;
}

/** The Drive channel ID of the user's watch channel (model.WatchChannelData.ChannelID). */
export async function watchChannelId(mmUserId: string): Promise<string> {
    const value = await kvGet(watchChannelKey(mmUserId));
    if (!value) {
        throw new Error(`No Drive watch channel stored for user ${mmUserId}`);
    }
    return (JSON.parse(value.toString('utf8')) as {channel_id: string}).channel_id;
}

export async function hasWatchChannel(mmUserId: string): Promise<boolean> {
    return (await kvGet(watchChannelKey(mmUserId))) !== null;
}

/**
 * Stops the user's Drive watch channel and forgets it, as `notifications stop` does
 * (server/plugin/notifications.go stopDriveActivityNotifications), so `notifications start` registers
 * a new one and the old channel gets no more pushes. The Mattermost users for the Google accounts are
 * reused across tests, and so would their channel be. Does nothing when no channel is stored.
 */
export async function stopWatchChannel(account: GoogleAccount, mmUserId: string) {
    const value = await kvGet(watchChannelKey(mmUserId));
    if (!value) {
        return;
    }
    const channel = JSON.parse(value.toString('utf8')) as {channel_id: string; resource_id: string};
    await stopDriveChannel(account, {channelId: channel.channel_id, resourceId: channel.resource_id});
    await kvDelete(watchChannelKey(mmUserId));
}

// Users whose watch channel the current test may have started, so stopTestWatchChannels can stop
// it even when the test fails before its own `notifications stop`.
const testWatchers = new Map<string, GoogleAccount>();

/** Stops any watch channel an earlier test or run left for the user; stopTestWatchChannels stops the test's own. */
export async function resetWatchChannel(account: GoogleAccount, mmUserId: string) {
    testWatchers.set(mmUserId, account);
    await stopWatchChannel(account, mmUserId);
}

/** For afterEach: stops the watch channels of the users passed to resetWatchChannel in this test. */
export async function stopTestWatchChannels() {
    for (const [mmUserId, account] of testWatchers) {
        await stopWatchChannel(account, mmUserId);
    }
    testWatchers.clear();
}
