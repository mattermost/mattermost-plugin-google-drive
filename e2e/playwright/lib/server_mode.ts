// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import fs from 'fs';
import path from 'path';

/**
 * Which Mattermost server the suite runs against. Global setup never starts one:
 * - `compose` (default, and CI): the disposable stack in docker-compose.yml, started with
 *   `npm run server:up` (or `npm run server:up:real` for the real-Google lane). Its Postgres is
 *   published on localhost:E2E_DB_PORT (5433) for the KV helpers.
 * - `external`: a server you already run at PW_BASE_URL (e.g. `make run-server` from
 *   mattermost-server), for fast local iteration. Tests write users, teams, posts and plugin data
 *   into its database, so use a throwaway dev database.
 */
export type ServerMode = 'compose' | 'external';

export function serverMode(): ServerMode {
    const mode = process.env.E2E_SERVER ?? 'compose';
    if (mode !== 'compose' && mode !== 'external') {
        throw new Error(`E2E_SERVER must be 'compose' or 'external', got '${mode}'.`);
    }
    return mode;
}

/** Postgres of the compose stack, published on the host (docker-compose.yml). */
export function composeDatabaseURL(): string {
    return `postgres://mmuser:mostest@localhost:${process.env.E2E_DB_PORT || '5433'}/mattermost_test`;
}

/** Control API of the compose stack's fake Google, published on the host (docker-compose.yml). */
export function composeFakeGoogleURL(): string {
    return `http://127.0.0.1:${process.env.FAKE_GOOGLE_PORT || '8080'}`;
}

/** Postgres of a mattermost-server dev setup (server/build/docker-compose.common.yml). */
export const DEFAULT_EXTERNAL_DATABASE_URL = 'postgres://mmuser:mostest@localhost:5432/mattermost_test';

export const EXTERNAL_CONFIG_BACKUP = path.join(__dirname, '..', 'logs', 'external-server-config.backup.json');

/**
 * Server settings that pw.initSetup() overwrites with test defaults but that an external dev
 * server needs to keep (its listen port and local mode). Captured in global setup, re-applied by
 * ensureDrivePlugin() after every initSetup(), so the server's config file stays correct even if a
 * run is interrupted. The full config is restored from EXTERNAL_CONFIG_BACKUP in global teardown.
 */
export function preservedServiceSettings(): Record<string, unknown> {
    const raw = process.env.E2E_PRESERVED_SERVICE_SETTINGS;
    return raw ? JSON.parse(raw) : {};
}

/**
 * Saves the server's pre-run config. Refuses to overwrite an existing backup: one is only left
 * behind when a run was interrupted or its restore failed, so the server may still have the test
 * config, and saving that over the backup would lose the original.
 */
export function saveExternalConfigBackup(config: unknown) {
    fs.mkdirSync(path.dirname(EXTERNAL_CONFIG_BACKUP), {recursive: true});
    try {
        fs.writeFileSync(EXTERNAL_CONFIG_BACKUP, JSON.stringify(config, null, 2), {flag: 'wx'});
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
        throw new Error(
            `${EXTERNAL_CONFIG_BACKUP} is left from an earlier run that did not restore the external server's config. ` +
                'Restore it (System Console or mmctl) if the server still has the test config, then delete the file and rerun.',
        );
    }
}

export function removeExternalConfigBackup() {
    fs.rmSync(EXTERNAL_CONFIG_BACKUP, {force: true});
}

export function readExternalConfigBackup(): unknown | null {
    return fs.existsSync(EXTERNAL_CONFIG_BACKUP) ? JSON.parse(fs.readFileSync(EXTERNAL_CONFIG_BACKUP, 'utf8')) : null;
}

/**
 * Fails fast when the server is down (not started, crashed earlier in the run, or an external
 * server that isn't running), instead of every test hanging until its timeout.
 */
export async function assertServerAlive(siteURL: string) {
    try {
        const response = await fetch(`${siteURL}/api/v4/system/ping`, {signal: AbortSignal.timeout(10_000)});
        if (response.ok) {
            return;
        }
        throw new Error(`HTTP ${response.status}`);
    } catch (err) {
        const hint =
            serverMode() === 'external'
                ? 'Start it (e.g. `make run-server` in mattermost-server) or check PW_BASE_URL.'
                : 'Start it with `npm run server:up` (or `make e2e-env-up` from the repo root). If it crashed, see `npm run server:logs`.';
        throw new Error(`Mattermost at ${siteURL} is not responding (${String(err)}). ${hint}`);
    }
}

/** True when something answers on the fake Google's control API. */
export async function fakeGoogleIsRunning(url: string): Promise<boolean> {
    return fetch(`${url}/__control/health`, {signal: AbortSignal.timeout(2_000)})
        .then((r) => r.ok)
        .catch(() => false);
}
