// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {Client4} from '@mattermost/client';

/** Contents the plugin uploads to Drive for a file posted by postWithFiles. */
export const postedFileContent = (name: string) => `Contents of ${name}\n`;

/** Posts a message with one text file per name, as `user`, and returns the post's ID. */
export async function postWithFiles(user: {username: string; password: string}, channelId: string, message: string, fileNames: string[]): Promise<string> {
    const client = new Client4();
    client.setUrl(process.env.PW_BASE_URL as string);
    await client.login(user.username, user.password);
    const fileIds: string[] = [];
    for (const name of fileNames) {
        const form = new FormData();
        form.append('channel_id', channelId);
        form.append('files', new Blob([postedFileContent(name)], {type: 'text/plain'}), name);
        fileIds.push(...(await client.uploadFile(form)).file_infos.map((f) => f.id));
    }
    const post = await client.createPost({channel_id: channelId, message, file_ids: fileIds} as any);
    return post.id;
}
