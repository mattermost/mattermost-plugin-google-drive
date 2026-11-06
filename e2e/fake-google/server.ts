// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// A small fake of the Google APIs the Drive plugin calls: OAuth (accounts.google.com consent and
// oauth2.googleapis.com/token), Drive v3 and v2, Docs, Sheets, Slides and Drive Activity, plus
// Drive push notifications to the plugin's webhook.
//
// It listens on HTTPS 443 for Mattermost, which sends all its outbound HTTPS through the fake's
// proxy on 3128 (HTTPS_PROXY in docker-compose.yml) and trusts its throwaway CA through
// SSL_CERT_FILE, so the plugin bundle under test is the normal production build. The proxy
// tunnels the Google hosts in FAKE_GOOGLE_HOSTS to the fake, refuses any other Google host as a
// contract violation (so a new endpoint fails clearly instead of reaching real Google), and passes
// everything else through. The browser and the tests reach the same routes on plain HTTP 8080,
// along with a /__control API for test setup and assertions.
//
// Every request it receives and every response it sends is checked against the contract in
// contract/ (Google's published Discovery documents plus the fields the plugin reads). Violations
// are collected; lib/test.ts fails the test that caused them, and global teardown fails the run
// on any sent outside a test.
//
// Drive behaviour the fake reproduces, checked against real Google on 2026-11-04:
// - Comments, replies and new permissions bump the file's modifiedTime (viewedByMeTime unchanged).
// - Activity targets: legacyDiscussionId is always the thread's comment ID. legacyCommentId is the
//   comment's ID for ADDED and RESOLVED, and the new reply's ID for REPLY_ADDED and REOPENED.
// - Drive Activity marks the viewer with isCurrentUser wherever they appear (actor or permission).
// - Files shared with the viewer carry sharingUser.
// - changes.list returns one entry per changed file, with its latest state: a file created and
//   then changed 3 times after the start token came back as a single entry (checked 2026-11-05).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

import {PUSH_NOTIFICATION_HEADERS, tokenResponseFields, missingPaths} from './contract/required.ts';
import {ContractValidator} from './contract/validator.ts';
import type {MethodMatch} from './contract/validator.ts';

type Json = Record<string, any>;
type Result = {status: number; body?: unknown; headers?: Record<string, string>; html?: string};

const HTTP_PORT = Number(process.env.FAKE_HTTP_PORT || 8080);
const HTTPS_PORT = Number(process.env.FAKE_HTTPS_PORT || 443);
const PROXY_PORT = Number(process.env.FAKE_PROXY_PORT || 3128);
const CERT_DIR = process.env.FAKE_CERT_DIR || '/certs';
// The Google hosts the fake answers for (its certificate covers the same list; see docker-compose.yml).
const FAKE_HOSTS = new Set((process.env.FAKE_GOOGLE_HOSTS ?? '').split(/\s+/).filter(Boolean));
const GOOGLE_DOMAIN = /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com)$/;
// The plugin registers its webhook at SiteURL (http://localhost:8065), which inside the Docker
// network is the mattermost container.
const SITE_URL = process.env.FAKE_SITE_URL || 'http://localhost:8065';
const MATTERMOST_URL = process.env.FAKE_MATTERMOST_URL || 'http://mattermost:8065';
// Visual tests (e2e/lib/visual.ts) set this: the created-file post prints the file's createdTime.
const FIXED_CREATED_TIME = process.env.FAKE_FIXED_CREATED_TIME;

const CLIENT_ID = 'fake-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'fake-client-secret';
const ACCESS_TOKEN_TTL_SECONDS = 3599;

const USERS = [
    {key: 'owner', email: 'drive-owner@fake-google.test', displayName: 'Drive Owner', permissionId: '01234567890123456789', refreshToken: 'fake-refresh-owner'},
    {key: 'collab', email: 'drive-collab@fake-google.test', displayName: 'Drive Collaborator', permissionId: '09876543210987654321', refreshToken: 'fake-refresh-collab'},
] as const;
type User = typeof USERS[number];

const MIME = {
    doc: 'application/vnd.google-apps.document',
    sheet: 'application/vnd.google-apps.spreadsheet',
    slide: 'application/vnd.google-apps.presentation',
};

type Permission = {id: string; type: string; role: string; emailAddress?: string; allowFileDiscovery?: boolean; grantedBy: string};
type Reply = {id: string; author: string; content: string; createdTime: string; modifiedTime: string; deleted: boolean; action?: string};
type Comment = {id: string; author: string; content: string; createdTime: string; modifiedTime: string; deleted: boolean; resolved: boolean; replies: Reply[]};
type FileRecord = {
    id: string;
    name: string;
    mimeType: string;
    owner: string;
    createdTime: string;
    modifiedTime: string;
    lastModifyingUser: string;
    trashed: boolean;
    size?: number;
    md5?: string;
    permissions: Permission[];
    comments: Comment[];
    viewedByMeTime: Record<string, string>;
};
type Activity = {timestamp: string; actor: string; detail: Json; target: Json};
type Change = {seq: number; fileId: string; time: string};
type Channel = {id: string; token?: string; address: string; resourceId: string; expiration?: string; user: string; messageNumber: number; stopped: boolean};
type LoggedRequest = {method: string; host: string; path: string; status: number; user?: string; methodId?: string};

const contract = new ContractValidator();

const state = {
    files: new Map<string, FileRecord>(),
    activities: new Map<string, Activity[]>(),
    changes: [] as Change[],
    nextSeq: 1,
    channels: new Map<string, Channel>(),
    codes: new Map<string, {user: string; scope: string; redirectUri: string}>(),
    accessTokens: new Map<string, {user: string; scope: string; expiresAt: number}>(),
    pendingConsent: new Map<string, URLSearchParams>(),
    domainSharingPolicy: 'allowed',
    requests: [] as LoggedRequest[],
    violations: [] as string[],
    divergences: [] as string[],
};

function reset() {
    state.files.clear();
    state.activities.clear();
    state.changes = [];
    state.nextSeq = 1;
    state.channels.clear();
    state.codes.clear();
    state.accessTokens.clear();
    state.pendingConsent.clear();
    state.domainSharingPolicy = 'allowed';
    state.requests = [];
    state.violations = [];
    state.divergences = [];
}

const now = () => new Date().toISOString();
const randomId = (length = 33) => crypto.randomBytes(48).toString('base64url').replace(/[-_]/g, '').slice(0, length);
const userByKey = (key: string) => USERS.find((u) => u.key === key) as User;
const userByEmail = (email: string) => USERS.find((u) => u.email === email.toLowerCase());
const html = (s: string) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c] as string));

function violation(message: string) {
    state.violations.push(message);
    console.warn(`CONTRACT VIOLATION: ${message}`);
}

// ---------------------------------------------------------------------------------------------
// Errors in Google's two formats: Drive's older one (errors[].reason) and the newer APIs' (status).

function driveError(status: number, reason: string, message: string, location?: string): Result {
    return {status, body: {error: {code: status, message, errors: [{message, domain: 'global', reason, ...(location ? {location, locationType: 'parameter'} : {})}]}}};
}

function apiError(status: number, grpcStatus: string, message: string): Result {
    return {status, body: {error: {code: status, message, status: grpcStatus}}};
}

function unauthenticated(): Result {
    const message = 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.';
    return {status: 401, body: {error: {code: 401, message, errors: [{message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header'}], status: 'UNAUTHENTICATED'}}};
}

// ---------------------------------------------------------------------------------------------
// OAuth: consent page (browser, accounts.google.com) and token endpoint (oauth2.googleapis.com).

const allowedRedirect = (uri: string) => /^http:\/\/localhost:\d+\/plugins\/[^/]+\/oauth\/complete$/.test(uri);

function authorize(query: URLSearchParams): Result {
    if (query.get('client_id') !== CLIENT_ID) {
        return errorPage(401, 'Error 401: invalid_client', 'The OAuth client was not found.');
    }
    const redirectUri = query.get('redirect_uri') ?? '';
    if (!allowedRedirect(redirectUri)) {
        return errorPage(400, 'Error 400: redirect_uri_mismatch', `${redirectUri} is not a registered redirect URI.`);
    }
    if (query.get('response_type') !== 'code') {
        return errorPage(400, 'Error 400: unsupported_response_type', 'Only response_type=code is supported.');
    }
    const sid = randomId(16);
    state.pendingConsent.set(sid, query);
    const accounts = USERS.map((u) => `<button type="submit" name="account" value="${u.key}">${html(u.displayName)} (${html(u.email)})</button>`).join('');
    return page('Choose an account', `<h1>Choose an account</h1><p>to continue to Mattermost Google Drive (fake)</p>
        <form method="post" action="/o/oauth2/consent"><input type="hidden" name="sid" value="${sid}">${accounts}</form>`);
}

function consent(form: URLSearchParams): Result {
    const sid = form.get('sid') ?? '';
    const query = state.pendingConsent.get(sid);
    if (!query) {
        return errorPage(400, 'Error 400: invalid_request', 'The sign-in session expired.');
    }
    const account = form.get('account');
    if (account && !form.get('decision')) {
        const scopes = (query.get('scope') ?? '').split(' ').map((s) => `<li>${html(s)}</li>`).join('');
        return page('Grant access', `<h1>Mattermost Google Drive wants access to your Google Account</h1><p>${html(userByKey(account).email)}</p><ul>${scopes}</ul>
            <form method="post" action="/o/oauth2/consent"><input type="hidden" name="sid" value="${sid}"><input type="hidden" name="account" value="${html(account)}">
            <button type="submit" name="decision" value="deny">Cancel</button><button type="submit" name="decision" value="allow">Allow</button></form>`);
    }
    state.pendingConsent.delete(sid);
    const redirect = new URL(query.get('redirect_uri')!);
    if (form.get('decision') !== 'allow' || !account) {
        redirect.searchParams.set('error', 'access_denied');
    } else {
        const code = `4/fake-${randomId(40)}`;
        state.codes.set(code, {user: account, scope: query.get('scope') ?? '', redirectUri: query.get('redirect_uri')!});
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('scope', query.get('scope') ?? '');
    }
    if (query.get('state') !== null) {
        redirect.searchParams.set('state', query.get('state')!);
    }
    return {status: 302, headers: {location: redirect.toString()}};
}

function page(title: string, body: string): Result {
    return {status: 200, html: `<!doctype html><html><head><meta charset="utf-8"><title>${html(title)} - Fake Google</title></head><body>${body}</body></html>`};
}

function errorPage(status: number, title: string, message: string): Result {
    return {status, html: `<!doctype html><html><head><title>${html(title)}</title></head><body><h1>${html(title)}</h1><p>${html(message)}</p></body></html>`};
}

function tokenEndpoint(form: URLSearchParams, authorization: string): Result {
    let clientId = form.get('client_id');
    let clientSecret = form.get('client_secret');
    if (authorization.startsWith('Basic ')) {
        const [id, secret] = Buffer.from(authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
        clientId = id;
        clientSecret = secret;
    }
    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
        return {status: 401, body: {error: 'invalid_client', error_description: 'The OAuth client was not found.'}};
    }

    const grantType = form.get('grant_type') ?? '';
    let user: string;
    let scope: string;
    let refreshToken: string | undefined;
    if (grantType === 'authorization_code') {
        const code = state.codes.get(form.get('code') ?? '');
        state.codes.delete(form.get('code') ?? '');
        if (!code || code.redirectUri !== form.get('redirect_uri')) {
            return {status: 400, body: {error: 'invalid_grant', error_description: 'Bad Request'}};
        }
        user = code.user;
        scope = code.scope;
        refreshToken = userByKey(user).refreshToken;
    } else if (grantType === 'refresh_token') {
        const found = USERS.find((u) => u.refreshToken === form.get('refresh_token'));
        if (!found) {
            return {status: 400, body: {error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}};
        }
        user = found.key;
        scope = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.activity https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid';
    } else {
        return {status: 400, body: {error: 'unsupported_grant_type', error_description: `Invalid grant_type: ${grantType}`}};
    }

    const accessToken = `ya29.fake-${randomId(60)}`;
    state.accessTokens.set(accessToken, {user, scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000});
    const body = {
        access_token: accessToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        ...(refreshToken ? {refresh_token: refreshToken} : {}),
        scope,
        token_type: 'Bearer',
        id_token: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({email: userByKey(user).email})).toString('base64url')}.`,
    };
    for (const missing of missingPaths(body, tokenResponseFields(grantType))) {
        violation(`token response (${grantType}): missing ${missing}`);
    }
    return {status: 200, body};
}

function authenticate(authorization: string): User | null {
    const token = state.accessTokens.get(authorization.replace(/^Bearer /, ''));
    return token && token.expiresAt > Date.now() ? userByKey(token.user) : null;
}

// ---------------------------------------------------------------------------------------------
// Partial responses: Google's `fields` mask, e.g. `id,name,owners(displayName),files(id)`.

type Mask = Map<string, Mask | true>;

function parseMask(fields: string): Mask {
    const root: Mask = new Map();
    let i = 0;
    const parse = (target: Mask) => {
        let name = '';
        const flush = () => {
            if (name.trim()) {
                const parts = name.trim().split('/');
                let node = target;
                parts.forEach((part, index) => {
                    if (index === parts.length - 1) {
                        if (!node.has(part)) {
                            node.set(part, true);
                        }
                    } else {
                        const next = node.get(part);
                        const child = next instanceof Map ? next : new Map();
                        node.set(part, child);
                        node = child;
                    }
                });
            }
            name = '';
        };
        while (i < fields.length) {
            const c = fields[i++];
            if (c === ',') {
                flush();
            } else if (c === '(') {
                const child: Mask = new Map();
                const key = name.trim();
                name = '';
                parse(child);
                target.set(key, child);
            } else if (c === ')') {
                flush();
                return;
            } else {
                name += c;
            }
        }
        flush();
    };
    parse(root);
    return root;
}

function applyMask(value: unknown, mask: Mask | true): unknown {
    if (mask === true || mask.has('*') || value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => applyMask(item, mask));
    }
    const out: Json = {};
    for (const [key, sub] of mask) {
        if (key in (value as Json)) {
            out[key] = applyMask((value as Json)[key], sub);
        }
    }
    return out;
}

function respond(query: URLSearchParams, full: Json, defaults: string): Result {
    return {status: 200, body: applyMask(full, parseMask(query.get('fields') || defaults))};
}

// ---------------------------------------------------------------------------------------------
// Drive resources as a given user sees them.

function driveUser(key: string, viewer: User): Json {
    const u = userByKey(key);
    return {kind: 'drive#user', displayName: u.displayName, me: u.key === viewer.key, permissionId: u.permissionId, emailAddress: u.email};
}

function roleOf(file: FileRecord, user: User): string | null {
    if (file.owner === user.key) {
        return 'owner';
    }
    const permission = file.permissions.find((p) => p.type === 'user' && p.emailAddress === user.email);
    return permission?.role ?? null;
}

function linkFor(file: FileRecord): string {
    switch (file.mimeType) {
    case MIME.doc:
        return `https://docs.google.com/document/d/${file.id}/edit?usp=drivesdk`;
    case MIME.sheet:
        return `https://docs.google.com/spreadsheets/d/${file.id}/edit?usp=drivesdk`;
    case MIME.slide:
        return `https://docs.google.com/presentation/d/${file.id}/edit?usp=drivesdk`;
    default:
        return `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`;
    }
}

function renderPermission(p: Permission): Json {
    const user = p.emailAddress ? userByEmail(p.emailAddress) : undefined;
    return {
        kind: 'drive#permission',
        id: p.id,
        type: p.type,
        role: p.role,
        ...(p.emailAddress ? {emailAddress: p.emailAddress, displayName: user?.displayName ?? p.emailAddress} : {}),
        ...(p.allowFileDiscovery === undefined ? {} : {allowFileDiscovery: p.allowFileDiscovery}),
        deleted: false,
        pendingOwner: false,
    };
}

function allPermissions(file: FileRecord): Permission[] {
    const owner = userByKey(file.owner);
    return [{id: owner.permissionId, type: 'user', role: 'owner', emailAddress: owner.email, grantedBy: owner.key}, ...file.permissions];
}

function touch(file: FileRecord, actor: string) {
    file.modifiedTime = now();
    file.lastModifyingUser = actor;
}

function renderFile(file: FileRecord, viewer: User): Json {
    const role = roleOf(file, viewer) ?? 'reader';
    const canEdit = role === 'owner' || role === 'writer';
    const isNative = file.mimeType.startsWith('application/vnd.google-apps.');
    const viewed = file.viewedByMeTime[viewer.key];
    const sharedWithViewer = file.permissions.find((p) => p.type === 'user' && p.emailAddress === viewer.email);
    return {
        kind: 'drive#file',
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        starred: false,
        trashed: file.trashed,
        explicitlyTrashed: file.trashed,
        parents: [`root-${userByKey(file.owner).permissionId}`],
        spaces: ['drive'],
        version: String(file.comments.length + file.permissions.length + 1),
        webViewLink: linkFor(file),
        iconLink: `https://drive-thirdparty.googleusercontent.com/16/type/${file.mimeType}`,
        hasThumbnail: false,
        thumbnailVersion: '0',
        viewedByMe: Boolean(viewed),
        ...(viewed ? {viewedByMeTime: viewed} : {}),
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
        modifiedByMe: file.lastModifyingUser === viewer.key,
        ...(file.lastModifyingUser === viewer.key ? {modifiedByMeTime: file.modifiedTime} : {}),
        owners: [driveUser(file.owner, viewer)],
        ...(sharedWithViewer ? {sharingUser: driveUser(sharedWithViewer.grantedBy, viewer)} : {}),
        lastModifyingUser: driveUser(file.lastModifyingUser, viewer),
        shared: file.permissions.length > 0,
        ownedByMe: file.owner === viewer.key,
        capabilities: {canComment: role !== 'reader', canEdit, canShare: canEdit, canTrash: role === 'owner', canDownload: true, canCopy: true},
        viewersCanCopyContent: true,
        copyRequiresWriterPermission: false,
        writersCanShare: true,
        ...(canEdit ? {permissions: allPermissions(file).map(renderPermission)} : {}),
        permissionIds: allPermissions(file).map((p) => p.id),
        quotaBytesUsed: isNative ? '0' : String(file.size ?? 0),
        isAppAuthorized: true,
        ...(isNative ? {} : {
            size: String(file.size ?? 0),
            md5Checksum: file.md5,
            originalFilename: file.name,
            headRevisionId: `0B-fake-${file.id.slice(0, 8)}`,
            webContentLink: `https://drive.google.com/uc?id=${file.id}&export=download`,
            ...(file.name.includes('.') ? {fileExtension: file.name.split('.').pop(), fullFileExtension: file.name.split('.').slice(1).join('.')} : {}),
        }),
    };
}

function renderComment(file: FileRecord, comment: Comment, viewer: User): Json {
    return {
        kind: 'drive#comment',
        id: comment.id,
        createdTime: comment.createdTime,
        modifiedTime: comment.modifiedTime,
        author: {kind: 'drive#user', displayName: userByKey(comment.author).displayName, me: comment.author === viewer.key},
        htmlContent: html(comment.content),
        content: comment.content,
        deleted: comment.deleted,
        resolved: comment.resolved,
        replies: comment.replies.map((r) => renderReply(r, viewer)),
    };
}

function renderReply(reply: Reply, viewer: User): Json {
    return {
        kind: 'drive#reply',
        id: reply.id,
        createdTime: reply.createdTime,
        modifiedTime: reply.modifiedTime,
        author: {kind: 'drive#user', displayName: userByKey(reply.author).displayName, me: reply.author === viewer.key},
        htmlContent: html(reply.content),
        content: reply.content,
        deleted: reply.deleted,
        ...(reply.action ? {action: reply.action} : {}),
    };
}

// ---------------------------------------------------------------------------------------------
// State changes: every one appends to the changes feed and the file's activity, then pushes.

function personName(key: string) {
    return `people/${userByKey(key).permissionId}`;
}

function driveItemTarget(file: FileRecord) {
    return {
        name: `items/${file.id}`,
        title: file.name,
        mimeType: file.mimeType,
        owner: {user: {knownUser: {personName: personName(file.owner)}}},
        driveFile: {},
    };
}

function recordChange(file: FileRecord, actor: string, detail: Json, target: Json = {driveItem: driveItemTarget(file)}) {
    const time = now();
    state.changes.push({seq: state.nextSeq++, fileId: file.id, time});
    const list = state.activities.get(file.id) ?? [];
    list.push({timestamp: time, actor, detail, target});
    state.activities.set(file.id, list);
    for (const user of USERS) {
        if (roleOf(file, user)) {
            notifyChannels(user.key);
        }
    }
}

function createFile(owner: User, name: string, mimeType: string, content?: Buffer): FileRecord {
    const time = now();
    const file: FileRecord = {
        id: `1${randomId(43)}`,
        name,
        mimeType,
        owner: owner.key,
        createdTime: FIXED_CREATED_TIME || time,
        modifiedTime: time,
        lastModifyingUser: owner.key,
        trashed: false,
        ...(content ? {size: content.length, md5: crypto.createHash('md5').update(content).digest('hex')} : {}),
        permissions: [],
        comments: [],
        // Creating a file counts as viewing it, as in Drive.
        viewedByMeTime: {[owner.key]: time},
    };
    state.files.set(file.id, file);
    recordChange(file, owner.key, {create: {new: {}}});
    return file;
}

// ---------------------------------------------------------------------------------------------
// Push notifications (developers.google.com/workspace/drive/api/guides/push).

function notifyChannels(userKey: string) {
    for (const channel of state.channels.values()) {
        if (channel.user === userKey && !channel.stopped && (!channel.expiration || Number(channel.expiration) > Date.now())) {
            void deliver(channel, 'change');
        }
    }
}

async function deliver(channel: Channel, resourceState: 'sync' | 'change') {
    channel.messageNumber++;
    const headers: Record<string, string> = {
        'x-goog-channel-id': channel.id,
        'x-goog-message-number': String(channel.messageNumber),
        'x-goog-resource-id': channel.resourceId,
        'x-goog-resource-state': resourceState,
        'x-goog-resource-uri': 'https://www.googleapis.com/drive/v3/changes?alt=json&pageToken=1',
        ...(channel.token ? {'x-goog-channel-token': channel.token} : {}),
        ...(channel.expiration ? {'x-goog-channel-expiration': new Date(Number(channel.expiration)).toUTCString()} : {}),
    };
    for (const missing of PUSH_NOTIFICATION_HEADERS.filter((h) => !headers[h])) {
        violation(`push notification: missing header ${missing}`);
    }
    const target = channel.address.startsWith(SITE_URL) ? MATTERMOST_URL + channel.address.slice(SITE_URL.length) : channel.address;
    try {
        const response = await fetch(target, {method: 'POST', headers, signal: AbortSignal.timeout(30_000)});
        state.requests.push({method: 'PUSH', host: new URL(target).host, path: new URL(target).pathname, status: response.status, user: channel.user});
    } catch (err) {
        state.requests.push({method: 'PUSH', host: target, path: '', status: 0, user: channel.user});
        console.warn(`push to ${target} failed: ${String(err)}`);
    }
}

// ---------------------------------------------------------------------------------------------
// API routes. `match` is the documented method the request was matched to.

function fileFor(id: string, user: User): FileRecord | Result {
    const file = state.files.get(id);
    if (!file || !roleOf(file, user)) {
        return driveError(404, 'notFound', `File not found: ${id}.`, 'fileId');
    }
    return file;
}

const isResult = (value: unknown): value is Result => typeof value === 'object' && value !== null && 'status' in value;

function requireFields(query: URLSearchParams): Result | null {
    if (!query.get('fields')) {
        return driveError(400, 'required', `The 'fields' parameter is required for this operation.`, 'fields');
    }
    return null;
}

function route(match: MethodMatch, user: User, query: URLSearchParams, body: Json | undefined, media: Buffer | undefined): Result {
    const p = match.pathParams;
    switch (match.id) {
    case 'drive.about.get':
        if (match.api === 'drive_v2') {
            return respond(query, {
                kind: 'drive#about',
                name: user.displayName,
                user: {kind: 'drive#user', displayName: user.displayName, isAuthenticatedUser: true, permissionId: user.permissionId, emailAddress: user.email},
                permissionId: user.permissionId,
                rootFolderId: `root-${user.permissionId}`,
                domainSharingPolicy: state.domainSharingPolicy,
                languageCode: 'en',
            }, 'kind,name,permissionId');
        }
        return requireFields(query) ?? respond(query, {
            kind: 'drive#about',
            user: driveUser(user.key, user),
            storageQuota: {limit: '16106127360', usage: '0', usageInDrive: '0', usageInDriveTrash: '0'},
            maxUploadSize: '5242880000000',
            appInstalled: false,
            canCreateDrives: false,
        }, '');

    case 'drive.changes.getStartPageToken':
        return respond(query, {kind: 'drive#startPageToken', startPageToken: String(state.nextSeq)}, 'kind,startPageToken');

    case 'drive.changes.list': {
        const from = Number(query.get('pageToken'));
        if (!Number.isInteger(from) || from < 1) {
            return driveError(400, 'invalid', `Invalid Value`, 'pageToken');
        }
        const pageSize = Number(query.get('pageSize') || 100);
        // Latest change per file the user can see, oldest first.
        const latest = new Map<string, Change>();
        for (const change of state.changes) {
            const file = state.files.get(change.fileId);
            if (change.seq >= from && file && roleOf(file, user)) {
                latest.delete(change.fileId);
                latest.set(change.fileId, change);
            }
        }
        const all = [...latest.values()];
        const page = all.slice(0, pageSize);
        const more = all.length > pageSize;
        return respond(query, {
            kind: 'drive#changeList',
            changes: page.map((c) => ({
                kind: 'drive#change',
                changeType: 'file',
                time: c.time,
                removed: false,
                fileId: c.fileId,
                file: renderFile(state.files.get(c.fileId)!, user),
            })),
            ...(more ? {nextPageToken: String(page[page.length - 1].seq + 1)} : {newStartPageToken: String(state.nextSeq)}),
        }, 'kind,nextPageToken,newStartPageToken,changes(kind,changeType,time,removed,fileId,file(kind,id,name,mimeType))');
    }

    case 'drive.changes.watch': {
        if (!body?.id || !body.address || body.type !== 'web_hook') {
            return driveError(400, 'invalid', 'Invalid channel: id, address and type web_hook are required.');
        }
        if (!String(body.address).startsWith('https://')) {
            // Real Drive rejects this ("WebHook callback must be HTTPS"). The PR lane has no public
            // HTTPS hostname, so the fake accepts it and records the divergence instead.
            state.divergences.push(`changes.watch accepted non-HTTPS address ${body.address}`);
        }
        const channel: Channel = {
            id: body.id,
            token: body.token,
            address: body.address,
            resourceId: randomId(27),
            expiration: body.expiration ? String(body.expiration) : String(Date.now() + 7 * 24 * 3600 * 1000),
            user: user.key,
            messageNumber: 0,
            stopped: false,
        };
        state.channels.set(channel.id, channel);
        // Drive confirms a new channel with a sync message, always message number 1.
        void deliver(channel, 'sync');
        return {status: 200, body: {
            kind: 'api#channel',
            id: channel.id,
            resourceId: channel.resourceId,
            resourceUri: `https://www.googleapis.com/drive/v3/changes?alt=json&pageToken=${query.get('pageToken')}`,
            ...(channel.token ? {token: channel.token} : {}),
            expiration: channel.expiration,
        }};
    }

    case 'drive.channels.stop': {
        const channel = state.channels.get(body?.id);
        if (!channel || channel.resourceId !== body?.resourceId || channel.user !== user.key) {
            return driveError(404, 'notFound', `Channel '${body?.id}' not found for project`);
        }
        channel.stopped = true;
        return {status: 204};
    }

    case 'drive.files.create': {
        if (!match.upload && !body?.mimeType) {
            return driveError(400, 'badRequest', 'Metadata-only create needs a mimeType.');
        }
        const file = createFile(user, body?.name || 'Untitled', body?.mimeType || 'application/octet-stream', media);
        return respond(query, renderFile(file, user), 'kind,id,name,mimeType');
    }

    case 'drive.files.get': {
        const file = fileFor(p.fileId, user);
        return isResult(file) ? file : respond(query, renderFile(file, user), 'kind,id,name,mimeType');
    }

    case 'drive.files.list': {
        const q = query.get('q') ?? '';
        const files = [...state.files.values()].filter((f) => roleOf(f, user) && matchesQuery(f, user, q));
        return respond(query, {kind: 'drive#fileList', incompleteSearch: false, files: files.map((f) => renderFile(f, user))},
            'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)');
    }

    case 'drive.files.update': {
        const file = fileFor(p.fileId, user);
        if (isResult(file)) {
            return file;
        }
        if (roleOf(file, user) !== 'owner' && roleOf(file, user) !== 'writer') {
            return driveError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
        }
        if (typeof body?.trashed === 'boolean') {
            file.trashed = body.trashed;
        }
        if (typeof body?.name === 'string') {
            file.name = body.name;
        }
        touch(file, user.key);
        file.viewedByMeTime[user.key] = file.modifiedTime;
        recordChange(file, user.key, body?.trashed ? {delete: {type: 'TRASH'}} : {edit: {}});
        return respond(query, renderFile(file, user), 'kind,id,name,mimeType');
    }

    case 'drive.permissions.create': {
        const file = fileFor(p.fileId, user);
        if (isResult(file)) {
            return file;
        }
        if (roleOf(file, user) !== 'owner' && roleOf(file, user) !== 'writer') {
            return driveError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
        }
        if (!body?.type || !body.role) {
            return driveError(400, 'required', 'Permission type and role are required.');
        }
        if ((body.type === 'anyone' || body.type === 'domain') && state.domainSharingPolicy === 'disallowed') {
            return driveError(403, 'shareOutNotPermitted', 'Sharing outside the domain is not permitted.');
        }
        const email = body.emailAddress?.toLowerCase();
        const target = email ? userByEmail(email) : undefined;
        if (body.type === 'user' && !email) {
            return driveError(400, 'required', 'Permission emailAddress is required for type user.');
        }
        const permission: Permission = {
            id: body.type === 'anyone' ? 'anyoneWithLink' : target?.permissionId ?? `0${randomId(19).replace(/\D/g, '1')}`,
            type: body.type,
            role: body.role,
            ...(email ? {emailAddress: email} : {}),
            ...(body.type === 'anyone' || body.type === 'domain' ? {allowFileDiscovery: Boolean(body.allowFileDiscovery)} : {}),
            grantedBy: user.key,
        };
        file.permissions = file.permissions.filter((x) => x.id !== permission.id).concat(permission);
        touch(file, user.key);
        // Drive Activity names roles differently from Drive (reader is VIEWER, writer is EDITOR).
        const activityRole = ({owner: 'OWNER', organizer: 'ORGANIZER', fileOrganizer: 'FILE_ORGANIZER', writer: 'EDITOR', commenter: 'COMMENTER', reader: 'VIEWER'} as Record<string, string>)[body.role] ?? 'ROLE_UNSPECIFIED';
        const added: Json = {role: activityRole, ...(target ? {user: {knownUser: {personName: personName(target.key)}}} : body.type === 'anyone' ? {anyone: {}} : {})};
        recordChange(file, user.key, {permissionChange: {addedPermissions: [added]}});
        return respond(query, renderPermission(permission), body.type === 'anyone' || body.type === 'domain' ? 'kind,id,type,role,allowFileDiscovery' : 'kind,id,type,role');
    }

    case 'drive.permissions.list': {
        const file = fileFor(p.fileId, user);
        return isResult(file) ? file : respond(query, {kind: 'drive#permissionList', permissions: allPermissions(file).map(renderPermission)},
            'kind,permissions(kind,id,type,role,allowFileDiscovery)');
    }

    case 'drive.comments.create': {
        const missing = requireFields(query);
        const file = fileFor(p.fileId, user);
        if (missing || isResult(file)) {
            return missing ?? file as Result;
        }
        if (roleOf(file, user) === 'reader') {
            return driveError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
        }
        const time = now();
        const comment: Comment = {id: `AAAA${randomId(10)}`, author: user.key, content: body?.content ?? '', createdTime: time, modifiedTime: time, deleted: false, resolved: false, replies: []};
        file.comments.push(comment);
        touch(file, user.key);
        recordChange(file, user.key, {comment: {post: {subtype: 'ADDED'}}}, commentTarget(file, comment.id, comment.id));
        return respond(query, renderComment(file, comment, user), '');
    }

    case 'drive.comments.get': {
        const missing = requireFields(query);
        const file = fileFor(p.fileId, user);
        if (missing || isResult(file)) {
            return missing ?? file as Result;
        }
        const comment = file.comments.find((c) => c.id === p.commentId);
        if (!comment || (comment.deleted && query.get('includeDeleted') !== 'true')) {
            return driveError(404, 'notFound', `Comment not found: ${p.commentId}.`, 'commentId');
        }
        return respond(query, renderComment(file, comment, user), '');
    }

    case 'drive.replies.create': {
        const missing = requireFields(query);
        const file = fileFor(p.fileId, user);
        if (missing || isResult(file)) {
            return missing ?? file as Result;
        }
        const comment = file.comments.find((c) => c.id === p.commentId && !c.deleted);
        if (!comment) {
            return driveError(404, 'notFound', `Comment not found: ${p.commentId}.`, 'commentId');
        }
        const time = now();
        const reply: Reply = {id: `AAAA${randomId(10)}`, author: user.key, content: body?.content ?? '', createdTime: time, modifiedTime: time, deleted: false, ...(body?.action ? {action: body.action} : {})};
        comment.replies.push(reply);
        comment.modifiedTime = time;
        if (body?.action === 'resolve') {
            comment.resolved = true;
        } else if (body?.action === 'reopen') {
            comment.resolved = false;
        }
        touch(file, user.key);
        const subtype = body?.action === 'resolve' ? 'RESOLVED' : body?.action === 'reopen' ? 'REOPENED' : 'REPLY_ADDED';
        // legacyDiscussionId is the thread; legacyCommentId is the thread for RESOLVED and the reply otherwise.
        recordChange(file, user.key, {comment: {post: {subtype}}}, commentTarget(file, subtype === 'RESOLVED' ? comment.id : reply.id, comment.id));
        return respond(query, renderReply(reply, user), '');
    }

    case 'docs.documents.create': {
        const file = createFile(user, body?.title || 'Untitled document', MIME.doc);
        return {status: 200, body: {documentId: file.id, title: file.name, revisionId: `fake-${randomId(20)}`, suggestionsViewMode: 'SUGGESTIONS_INLINE'}};
    }

    case 'sheets.spreadsheets.create': {
        const file = createFile(user, body?.properties?.title || 'Untitled spreadsheet', MIME.sheet);
        return {status: 200, body: {
            spreadsheetId: file.id,
            properties: {title: file.name, locale: 'en_US', autoRecalc: 'ON_CHANGE', timeZone: 'Etc/GMT'},
            sheets: [{properties: {sheetId: 0, title: 'Sheet1', index: 0, sheetType: 'GRID', gridProperties: {rowCount: 1000, columnCount: 26}}}],
            spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
        }};
    }

    case 'slides.presentations.create': {
        const file = createFile(user, body?.title || 'Untitled presentation', MIME.slide);
        return {status: 200, body: {
            presentationId: file.id,
            title: file.name,
            locale: 'en',
            pageSize: {width: {magnitude: 9144000, unit: 'EMU'}, height: {magnitude: 5143500, unit: 'EMU'}},
            revisionId: `fake-${randomId(20)}`,
        }};
    }

    case 'driveactivity.activity.query':
        return activityQuery(user, body ?? {});

    default:
        return driveError(501, 'notImplemented', `${match.id} is documented but the fake does not implement it.`);
    }
}

function commentTarget(file: FileRecord, commentId: string, discussionId: string): Json {
    return {
        fileComment: {
            legacyCommentId: commentId,
            legacyDiscussionId: discussionId,
            linkToDiscussion: `${linkFor(file).replace(/\?usp=drivesdk$/, '')}?disco=${discussionId}`,
            parent: driveItemTarget(file),
        },
    };
}

// Supports the query forms the tests use: name contains '...', 'me' in owners, trashed = bool, mimeType = '...'.
function matchesQuery(file: FileRecord, user: User, q: string): boolean {
    for (const clause of q.split(/\s+and\s+/i).map((c) => c.trim()).filter(Boolean)) {
        let m;
        if ((m = clause.match(/^name contains '((?:[^'\\]|\\.)*)'$/))) {
            // Drive matches word prefixes case-insensitively; the tests re-check exact prefixes.
            if (!file.name.toLowerCase().includes(m[1].replace(/\\'/g, "'").toLowerCase())) {
                return false;
            }
        } else if (/^'me' in owners$/.test(clause)) {
            if (file.owner !== user.key) {
                return false;
            }
        } else if ((m = clause.match(/^trashed\s*=\s*(true|false)$/))) {
            if (file.trashed !== (m[1] === 'true')) {
                return false;
            }
        } else if ((m = clause.match(/^mimeType\s*=\s*'([^']*)'$/))) {
            if (file.mimeType !== m[1]) {
                return false;
            }
        } else {
            violation(`files.list: the fake does not understand query clause "${clause}"`);
            return false;
        }
    }
    return true;
}

function activityQuery(user: User, body: Json): Result {
    const itemName: string = body.itemName ?? '';
    if (!itemName.startsWith('items/')) {
        return apiError(400, 'INVALID_ARGUMENT', 'itemName or ancestorName is required.');
    }
    const fileId = decodeURIComponent(itemName.slice('items/'.length));
    const file = state.files.get(fileId);
    if (!file || !roleOf(file, user)) {
        return apiError(404, 'NOT_FOUND', 'Requested entity was not found.');
    }
    let activities = [...(state.activities.get(fileId) ?? [])].reverse();
    if (body.filter) {
        const m = String(body.filter).match(/^time\s*>\s*"([^"]+)"$/);
        if (!m) {
            violation(`activity.query: the fake does not understand filter "${body.filter}"`);
            return apiError(400, 'INVALID_ARGUMENT', 'Invalid filter.');
        }
        activities = activities.filter((a) => a.timestamp > m[1]);
    }
    const offset = Number(body.pageToken || 0);
    const pageSize = Number(body.pageSize || 50);
    const page = activities.slice(offset, offset + pageSize);
    const more = activities.length > offset + pageSize;
    const me = personName(user.key);
    return {status: 200, body: {
        activities: page.map((a) => markCurrentUser({
            primaryActionDetail: a.detail,
            actors: [{user: {knownUser: {personName: personName(a.actor)}}}],
            actions: [{detail: a.detail}],
            targets: [a.target],
            timestamp: a.timestamp,
        }, me)),
        ...(more ? {nextPageToken: String(offset + pageSize)} : {}),
    }};
}

/** Drive Activity adds isCurrentUser: true to every knownUser that is the viewer. */
function markCurrentUser<T>(value: T, me: string): T {
    if (Array.isArray(value)) {
        return value.map((item) => markCurrentUser(item, me)) as T;
    }
    if (value && typeof value === 'object') {
        const out: Json = {};
        for (const [key, child] of Object.entries(value)) {
            out[key] = markCurrentUser(child, me);
        }
        if (out.personName === me) {
            out.isCurrentUser = true;
        }
        return out as T;
    }
    return value;
}

// ---------------------------------------------------------------------------------------------
// Test control API: setup and assertions that have no Google API equivalent.

function control(method: string, segments: string[], body: Json): Result {
    const [section] = segments;
    if (section === 'health') {
        return {status: 200, body: {ok: true}};
    }
    if (section === 'reset' && method === 'POST') {
        reset();
        return {status: 204};
    }
    if (section === 'accounts' && method === 'GET') {
        return {status: 200, body: {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, users: USERS}};
    }
    if (section === 'config' && method === 'POST') {
        if (body.domainSharingPolicy) {
            state.domainSharingPolicy = body.domainSharingPolicy;
        }
        return {status: 204};
    }
    if (section === 'requests') {
        if (method === 'DELETE') {
            state.requests = [];
            return {status: 204};
        }
        return {status: 200, body: {value: state.requests}};
    }
    if (section === 'violations') {
        if (method === 'DELETE') {
            state.violations = [];
            state.divergences = [];
            return {status: 204};
        }
        return {status: 200, body: {value: state.violations, divergences: state.divergences}};
    }
    return {status: 404, body: {error: `unknown control route ${method} /${segments.join('/')}`}};
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing.

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

function parseMultipart(raw: Buffer, contentType: string): {metadata?: Json; media?: Buffer} {
    const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1];
    if (!boundary) {
        return {};
    }
    const parts = raw.toString('latin1').split(`--${boundary}`).slice(1, -1);
    const out: {metadata?: Json; media?: Buffer} = {};
    parts.forEach((part, index) => {
        const separator = part.indexOf('\r\n\r\n');
        const headers = part.slice(0, separator).toLowerCase();
        const content = part.slice(separator + 4).replace(/\r\n$/, '');
        if (index === 0 && headers.includes('application/json')) {
            out.metadata = JSON.parse(Buffer.from(content, 'latin1').toString('utf8'));
        } else {
            out.media = Buffer.from(content, 'latin1');
        }
    });
    return out;
}

function send(res: http.ServerResponse, result: Result) {
    if (result.html !== undefined) {
        res.writeHead(result.status, {'content-type': 'text/html; charset=utf-8', ...result.headers});
        res.end(result.html);
        return;
    }
    if (result.body === undefined) {
        res.writeHead(result.status, result.headers);
        res.end();
        return;
    }
    res.writeHead(result.status, {'content-type': 'application/json; charset=UTF-8', ...result.headers});
    res.end(JSON.stringify(result.body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    const host = (req.headers.host ?? '').split(':')[0];
    const raw = await readBody(req);
    const contentType = req.headers['content-type'] ?? '';
    const log: LoggedRequest = {method, host, path: url.pathname, status: 0};

    let result: Result;
    try {
        if (url.pathname.startsWith('/__control/')) {
            result = control(method, url.pathname.split('/').slice(2), raw.length ? JSON.parse(raw.toString()) : {});
            send(res, result);
            return;
        }
        if (url.pathname === '/o/oauth2/auth' || url.pathname === '/o/oauth2/v2/auth') {
            result = authorize(url.searchParams);
        } else if (url.pathname === '/o/oauth2/consent' && method === 'POST') {
            result = consent(new URLSearchParams(raw.toString()));
        } else if (url.pathname === '/token' && method === 'POST') {
            result = tokenEndpoint(new URLSearchParams(raw.toString()), req.headers.authorization ?? '');
        } else {
            result = api(method, url, raw, contentType, req.headers.authorization ?? '', log);
        }
    } catch (err) {
        console.error(err);
        violation(`${method} ${url.pathname}: the fake crashed: ${String(err)}`);
        result = driveError(500, 'backendError', 'Backend Error');
    }
    log.status = result.status;
    state.requests.push(log);
    send(res, result);
}

function api(method: string, url: URL, raw: Buffer, contentType: string, authorization: string, log: LoggedRequest): Result {
    const match = contract.match(method, url.pathname);
    if (!match) {
        violation(`${method} ${url.pathname} is not covered by fake-google/contract/operations.json`);
        return driveError(404, 'notFound', 'Not Found');
    }
    log.methodId = match.id;

    let body: Json | undefined;
    let media: Buffer | undefined;
    if (match.upload && contentType.startsWith('multipart/related')) {
        ({metadata: body, media} = parseMultipart(raw, contentType));
    } else if (match.upload) {
        media = raw;
    } else if (raw.length) {
        body = JSON.parse(raw.toString('utf8'));
    }

    for (const problem of contract.validateRequest(match, url.searchParams, body)) {
        violation(problem);
    }

    const user = authenticate(authorization);
    if (!user) {
        return unauthenticated();
    }
    log.user = user.key;

    const result = route(match, user, url.searchParams, body, media);
    if (result.status !== 204) {
        for (const problem of contract.validateResponse(match, url.searchParams, result.status, result.body)) {
            violation(problem);
        }
    }
    return result;
}

const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handle(req, res).catch((err) => {
        console.error(err);
        res.writeHead(500);
        res.end();
    });
};

http.createServer(handler).listen(HTTP_PORT, () => console.log(`fake Google on http://0.0.0.0:${HTTP_PORT}`));

const certFile = path.join(CERT_DIR, 'fake.crt');
const keyFile = path.join(CERT_DIR, 'fake.key');
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    https.createServer({cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile)}, handler)
        .listen(HTTPS_PORT, () => console.log(`fake Google on https://0.0.0.0:${HTTPS_PORT}`));
} else {
    console.log(`No certificate in ${CERT_DIR}; HTTPS disabled (fine for running the fake on its own).`);
}

const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end('fake-google proxy: CONNECT only');
});
proxy.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const [host, port] = (req.url ?? '').split(':');
    let target = {host, port: Number(port) || 443};
    if (FAKE_HOSTS.has(host)) {
        target = {host: '127.0.0.1', port: HTTPS_PORT};
    } else if (GOOGLE_DOMAIN.test(host)) {
        violation(`Mattermost called ${host}, which the fake does not answer for. Add it to FAKE_GOOGLE_HOSTS in e2e/docker-compose.yml and route it in fake-google/server.ts.`);
        client.end(`HTTP/1.1 502 fake-google has no route for ${host}\r\n\r\n`);
        return;
    }
    const upstream = net.connect(target.port, target.host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
});
proxy.listen(PROXY_PORT, () => console.log(`fake Google proxy on http://0.0.0.0:${PROXY_PORT} for ${[...FAKE_HOSTS].join(', ') || 'no hosts'}`));
