// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Hand-written contracts for what Discovery cannot express.
//
// Discovery never marks response fields as required, so a fake that leaves out a field the plugin
// reads would still pass the schema. These lists name those fields, per method and only for the
// request shapes the plugin sends (e.g. fields=*). Each path uses `[]` to mean "every element".
//
// The OAuth token endpoint and Drive push notifications have no Discovery document at all; their
// shapes are modelled on RFC 6749 and Google's push-notification guide, and checked against the
// real service only by the nightly lane.

type Rule = {when: (query: URLSearchParams) => boolean; paths: string[]; why: string};

const always = () => true;
const fieldsStar = (query: URLSearchParams) => query.get('fields') === '*';
const fieldsInclude = (field: string) => (query: URLSearchParams) => (query.get('fields') ?? '').split(',').includes(field);

export const REQUIRED_RESPONSE_FIELDS: Record<string, Rule[]> = {
    'drive.files.get': [{
        when: fieldsStar,
        paths: ['id', 'name', 'mimeType', 'webViewLink', 'iconLink', 'createdTime', 'modifiedTime', 'owners[].displayName'],
        why: 'file posts and notifications (create.go, notifications.go)',
    }],
    'drive.about.get': [{when: fieldsInclude('domainSharingPolicy'), paths: ['domainSharingPolicy'], why: 'create dialog sharing options (create.go)'}],
    'drive.changes.getStartPageToken': [{when: always, paths: ['startPageToken'], why: 'watch setup and webhook (notifications.go, api.go)'}],
    'drive.changes.list': [{
        when: fieldsStar,
        // changes[].file is absent on removals, which the plugin skips.
        paths: ['changes[].fileId', 'changes[].time'],
        why: 'webhook change processing (api.go handleDriveWatchNotifications)',
    }],
    'drive.changes.watch': [{
        when: always,
        paths: ['id', 'resourceId', 'expiration', 'token'],
        why: 'stored as watch channel data; the webhook compares X-Goog-Channel-Token with the echoed token',
    }],
    'drive.comments.get': [{when: fieldsStar, paths: ['id', 'author.displayName', 'content'], why: 'comment notifications (notifications.go)'}],
    'drive.replies.create': [{when: fieldsStar, paths: ['id'], why: 'reply dialog'}],
    'docs.documents.create': [{when: always, paths: ['documentId'], why: 'create handler (api.go)'}],
    'sheets.spreadsheets.create': [{when: always, paths: ['spreadsheetId'], why: 'create handler (api.go)'}],
    'slides.presentations.create': [{when: always, paths: ['presentationId'], why: 'create handler (api.go)'}],
    'driveactivity.activity.query': [{
        when: always,
        paths: ['activities[].timestamp', 'activities[].primaryActionDetail', 'activities[].actors', 'activities[].targets'],
        why: 'webhook activity processing (api.go, notifications.go)',
    }],
};

/** RFC 6749 token response fields; refresh_token only for the authorization_code grant. */
export function tokenResponseFields(grantType: string): string[] {
    const fields = ['access_token', 'token_type', 'expires_in', 'scope'];
    return grantType === 'authorization_code' ? [...fields, 'refresh_token'] : fields;
}

/** Headers Drive sends with every push notification (developers.google.com/workspace/drive/api/guides/push). */
export const PUSH_NOTIFICATION_HEADERS = [
    'x-goog-channel-id',
    'x-goog-message-number',
    'x-goog-resource-id',
    'x-goog-resource-state',
    'x-goog-resource-uri',
];

/** Paths in `paths` that are missing or null in `value`. `[]` checks every element of an array. */
export function missingPaths(value: unknown, paths: string[]): string[] {
    return paths.filter((p) => !present(value, p.split('.')));
}

function present(value: unknown, parts: string[]): boolean {
    if (parts.length === 0) {
        return value !== undefined && value !== null;
    }
    const [head, ...rest] = parts;
    const isArray = head.endsWith('[]');
    const key = isArray ? head.slice(0, -2) : head;
    if (value === null || typeof value !== 'object' || !(key in value)) {
        return false;
    }
    const child = (value as Record<string, unknown>)[key];
    if (!isArray) {
        return present(child, rest);
    }
    return Array.isArray(child) && child.every((item) => present(item, rest));
}
