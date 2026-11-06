// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {Client4} from '@mattermost/client';
import type {Channel} from '@mattermost/types/channels';
import type {Team} from '@mattermost/types/teams';

/**
 * A private channel whose only members are the given users. The plugin's "Members of the
 * channel" sharing grants Drive access to every non-bot member by email, so tests keep the
 * membership to the Google test accounts (Town Square also holds users with fake addresses).
 */
export async function createPrivateChannelWith(adminClient: Client4, team: Team, userIds: string[]): Promise<Channel> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const channel = await adminClient.createChannel({
        team_id: team.id,
        name: `gdrive-e2e-${suffix}`,
        display_name: `Drive e2e ${suffix}`,
        type: 'P',
    } as Channel);
    for (const userId of userIds) {
        await adminClient.addToChannel(userId, channel.id);
    }
    return channel;
}
