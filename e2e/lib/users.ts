// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {Client4} from '@mattermost/client';
import type {Team} from '@mattermost/types/teams';
import type {UserProfile} from '@mattermost/types/users';

import type {GoogleAccount} from './google/auth';

/**
 * A Mattermost user whose email is the Google test account's address. The plugin maps Google
 * users to Mattermost users by email (sharing targets, notification actors), so this must match.
 *
 * Emails are unique per server and the Google accounts are fixed, so the user is created once and
 * reused; each call gives it a fresh password and adds it to `team`. `username` fixes the name it
 * is created with (the plugin prints it in some posts); by default it gets a random suffix.
 */
export async function mattermostUserFor(adminClient: Client4, googleAccount: GoogleAccount, team: Team, username?: string): Promise<UserProfile> {
    const password = `E2e-${Math.random().toString(36).slice(2, 10)}-Aa1!`;

    let user: UserProfile;
    try {
        user = await adminClient.getUserByEmail(googleAccount.email);
        // A system admin may set another user's password without the current one.
        await adminClient.updateUserPassword(user.id, '', password);
    } catch (err) {
        // Only a missing user is created; anything else (server down, auth) is a real failure.
        if ((err as {status_code?: number}).status_code !== 404) {
            throw err;
        }
        user = await adminClient.createUser(
            {
                email: googleAccount.email,
                username: username ?? `gdrive-${googleAccount.role}-${Math.random().toString(36).slice(2, 7)}`,
                password,
                first_name: 'Drive',
                last_name: googleAccount.role === 'owner' ? 'Owner' : 'Collaborator',
            } as UserProfile,
            '',
            '',
        );
        // Same as @mattermost/playwright-lib createNewUserProfile: no tutorial or onboarding overlays.
        await adminClient.savePreferences(user.id, [
            {user_id: user.id, category: 'tutorial_step', name: user.id, value: '999'},
            {user_id: user.id, category: 'crt_thread_pane_step', name: user.id, value: '999'},
            {user_id: user.id, category: 'onboarding_task_list', name: 'onboarding_task_list_show', value: 'false'},
            {user_id: user.id, category: 'onboarding_task_list', name: 'onboarding_task_list_open', value: 'false'},
        ]);
    }

    await adminClient.addToTeam(team.id, user.id);
    return {...user, password};
}
