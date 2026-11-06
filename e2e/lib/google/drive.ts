// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Test-side Google Drive v3 calls (assertions and cleanup), made directly with the test account's
// token rather than through the plugin. They go to real Drive or the fake (lib/google/mode.ts).

import {googleAccessToken, GoogleAccount} from './auth';
import {googleEndpoints} from './mode';

/** Prefix every file a test creates with this, so cleanup can find leftovers. */
export function e2eFileName(label: string): string {
    return `e2e-${process.env.E2E_RUN_ID}-${label}-${Math.random().toString(36).slice(2, 7)}`;
}

async function driveRequest<T>(account: GoogleAccount, pathAndQuery: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${googleEndpoints().drive}${pathAndQuery}`, {
        ...init,
        headers: {...init.headers, Authorization: `Bearer ${await googleAccessToken(account)}`},
    });
    if (!response.ok) {
        throw new Error(`Drive ${init.method ?? 'GET'} ${pathAndQuery} failed: ${response.status} ${await response.text()}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
}

export type DrivePermission = {type: 'user' | 'group' | 'domain' | 'anyone'; role: string; emailAddress?: string};

export async function listPermissions(account: GoogleAccount, fileId: string): Promise<DrivePermission[]> {
    const body = await driveRequest<{permissions: DrivePermission[]}>(
        account,
        `/files/${fileId}/permissions?fields=permissions(type,role,emailAddress)`,
    );
    return body.permissions.map((p) => ({...p, emailAddress: p.emailAddress?.toLowerCase()}));
}

export type DriveFile = {id: string; name: string; mimeType: string};

export async function getFile(account: GoogleAccount, fileId: string): Promise<DriveFile> {
    return driveRequest<DriveFile>(account, `/files/${fileId}?fields=id,name,mimeType`);
}

/**
 * Files owned by the account whose name starts with `prefix` (case-sensitive).
 *
 * Drive's `name contains` matches word prefixes loosely (e.g. 'e2e-' also matches a personal
 * file named 'E2C8485D-…'), so the query only narrows the search and the exact prefix check is
 * done here. Never act on query results without this check.
 */
export async function findFilesByNamePrefix(account: GoogleAccount, prefix: string): Promise<DriveFile[]> {
    if (!prefix.startsWith('e2e-')) {
        throw new Error(`Refusing to search Drive for a prefix that is not an e2e prefix: ${prefix}`);
    }
    const q = `name contains '${prefix.replace(/'/g, "\\'")}' and 'me' in owners and trashed = false`;
    const body = await driveRequest<{files: DriveFile[]}>(
        account,
        `/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=100`,
    );
    return body.files.filter((f) => f.name.startsWith(prefix));
}

/**
 * Trashes `e2e-` files that an earlier, interrupted run left behind: only files created before
 * `createdBefore`, so a run never removes files a run that is still going needs. Returns their names.
 * At most 100 per call; a larger backlog clears over the next runs.
 */
export async function trashLeftoverFiles(account: GoogleAccount, createdBefore: Date): Promise<string[]> {
    const cutoff = createdBefore.toISOString();
    const q = `name contains 'e2e-' and 'me' in owners and trashed = false and createdTime < '${cutoff}'`;
    const body = await driveRequest<{files: Array<DriveFile & {createdTime: string}>}>(
        account,
        `/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,createdTime)&pageSize=100`,
    );
    // Same exact-prefix check as findFilesByNamePrefix: `name contains` matches loosely.
    const leftovers = body.files.filter((f) => f.name.startsWith('e2e-') && f.createdTime < cutoff);
    await Promise.all(leftovers.map((f) => trashFile(account, f.id)));
    return leftovers.map((f) => f.name);
}

/** Moves a file to the account's Drive trash (recoverable for 30 days), rather than deleting it permanently. */
export async function trashFile(account: GoogleAccount, fileId: string) {
    await driveRequest(account, `/files/${fileId}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({trashed: true}),
    });
}

/** Trashes every file this run created in the account's Drive. */
export async function trashRunFiles(account: GoogleAccount) {
    const files = await findFilesByNamePrefix(account, `e2e-${process.env.E2E_RUN_ID}-`);
    await Promise.all(files.map((f) => trashFile(account, f.id)));
}

/** Extracts the file ID from a Google Docs/Sheets/Slides/Drive web link (`…/d/<id>/…`). */
export function fileIdFromLink(link: string): string {
    const match = link.match(/\/d\/([\w-]+)/);
    if (!match) {
        throw new Error(`No file ID in link ${link}`);
    }
    return match[1];
}

export const GOOGLE_MIME_TYPES = {
    doc: 'application/vnd.google-apps.document',
    sheet: 'application/vnd.google-apps.spreadsheet',
    slide: 'application/vnd.google-apps.presentation',
} as const;

/** Creates an empty Google Doc in the account's Drive through the Drive API (as that user would in Drive). */
export async function createGoogleDoc(account: GoogleAccount, name: string): Promise<DriveFile> {
    return driveRequest<DriveFile>(account, '/files?fields=id,name,mimeType', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, mimeType: GOOGLE_MIME_TYPES.doc}),
    });
}

/** Shares a file with another user without Google's notification email. */
export async function shareWithUser(account: GoogleAccount, fileId: string, email: string, role: 'reader' | 'commenter' | 'writer') {
    await driveRequest(account, `/files/${fileId}/permissions?sendNotificationEmail=false`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({type: 'user', role, emailAddress: email}),
    });
}

export type DriveComment = {id: string; content: string; replies: Array<{content: string; author: {displayName: string}}>};

/** Adds a comment to a file as the account's user. */
export async function addComment(account: GoogleAccount, fileId: string, content: string): Promise<DriveComment> {
    return driveRequest<DriveComment>(account, `/files/${fileId}/comments?fields=id,content,replies(content,author(displayName))`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({content}),
    });
}

export async function getComment(account: GoogleAccount, fileId: string, commentId: string): Promise<DriveComment> {
    return driveRequest<DriveComment>(account, `/files/${fileId}/comments/${commentId}?fields=id,content,replies(content,author(displayName))`);
}

/** The account's Google display name, as Drive shows it on the user's comments and shares. */
export async function googleDisplayName(account: GoogleAccount): Promise<string> {
    return (await driveRequest<{user: {displayName: string}}>(account, '/about?fields=user(displayName)')).user.displayName;
}
