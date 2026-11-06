// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import type {Client4} from '@mattermost/client';
import {expect} from '@playwright/test';

import manifest from '../../../plugin.json';

import {assertServerAlive, preservedServiceSettings} from './server_mode';

export const PLUGIN_ID = manifest.id;

const PLUGIN_RUNNING = 2;

// Fixed 32-character key (the plugin requires exactly 32). Tests that seed tokens encrypt with it.
export const TEST_ENCRYPTION_KEY = 'e2e-test-encryption-key-32-chars';

export type DrivePluginSettings = {
    googleOAuthClientId: string;
    googleOAuthClientSecret: string;
};

// Placeholder OAuth client for specs that never call Google. The plugin only checks that the
// values are present.
export const PLACEHOLDER_OAUTH: DrivePluginSettings = {
    googleOAuthClientId: 'e2e-placeholder.apps.googleusercontent.com',
    googleOAuthClientSecret: 'e2e-placeholder-secret',
};

export const UNCONFIGURED_OAUTH: DrivePluginSettings = {
    googleOAuthClientId: '',
    googleOAuthClientSecret: '',
};

/** Returns the single plugin bundle in the repo's dist/, failing with a fix-it message otherwise. */
export function findPluginBundle(): string {
    const distDir = path.join(__dirname, '..', '..', '..', 'dist');
    const bundles = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter((f) => f.endsWith('.tar.gz')) : [];
    if (bundles.length !== 1) {
        throw new Error(
            `Expected exactly one plugin bundle in ${distDir}, found ${bundles.length}. ` +
                "Run 'make dist' from the repository root (on macOS, with GNU tar on PATH).",
        );
    }

    const bundle = path.join(distDir, bundles[0]);
    assertSingleRootBundle(bundle);
    return bundle;
}

/**
 * Mattermost only finds plugin.json when the archive has exactly one top-level directory.
 * macOS bsdtar adds AppleDouble `._*` entries (hidden by macOS `tar -t`), which breaks that and
 * makes the upload fail with "unable to find manifest".
 */
function assertSingleRootBundle(bundle: string) {
    const tar = zlib.gunzipSync(fs.readFileSync(bundle));
    const roots = new Set<string>();
    const appleDouble: string[] = [];

    for (let offset = 0; offset + 512 <= tar.length; ) {
        const header = tar.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        if (!name) {
            break;
        }
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
        const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
        const typeFlag = String.fromCharCode(header[156]);
        const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);

        // Skip pax/GNU metadata records; they describe the next entry rather than being one.
        if (!['x', 'g', 'L', 'K'].includes(typeFlag)) {
            roots.add(fullName.split('/')[0]);
            if (path.basename(fullName).startsWith('._')) {
                appleDouble.push(fullName);
            }
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }

    if (appleDouble.length > 0 || roots.size !== 1) {
        throw new Error(
            `Plugin bundle ${path.basename(bundle)} is not a single-directory archive ` +
                `(top-level entries: ${[...roots].join(', ')}; AppleDouble entries: ${appleDouble.length}). ` +
                "Mattermost will reject it with 'unable to find manifest'. On macOS rebuild with GNU tar, " +
                'e.g. `PATH="$(brew --prefix gnu-tar)/libexec/gnubin:$PATH" make dist`.',
        );
    }
}

/** Uploads the plugin bundle (replacing any existing version). Does not enable it. */
export async function uploadPlugin(adminClient: Client4, bundlePath: string) {
    const file = new File([fs.readFileSync(bundlePath)], path.basename(bundlePath), {type: 'application/gzip'});
    await adminClient.uploadPlugin(file, true);
}

/**
 * Enables the plugin with the given OAuth settings and waits until it runs.
 *
 * Call it after pw.initSetup(): initSetup() replaces the whole server config, which wipes plugin
 * settings, plugin enable states and AllowedUntrustedInternalConnections.
 */
export async function ensureDrivePlugin(adminClient: Client4, settings: DrivePluginSettings = PLACEHOLDER_OAUTH) {
    const siteURL = process.env.PW_BASE_URL as string;
    await assertServerAlive(siteURL);

    await adminClient.patchConfig({
        ServiceSettings: {
            // External dev servers keep their own listen address and local mode (empty otherwise).
            ...preservedServiceSettings(),
            SiteURL: siteURL,
            AllowedUntrustedInternalConnections: 'localhost 127.0.0.1',
        },
        PluginSettings: {
            PluginStates: {[PLUGIN_ID]: {Enable: true}},
            Plugins: {
                [PLUGIN_ID]: {
                    googleoauthclientid: settings.googleOAuthClientId,
                    googleoauthclientsecret: settings.googleOAuthClientSecret,
                    encryptionkey: TEST_ENCRYPTION_KEY,
                    queriesperminute: 12000,
                    burstsize: 300,
                },
            },
        },
    } as any);

    await expect
        .poll(
            async () => {
                const statuses = await adminClient.getPluginStatuses();
                return statuses.find((s) => s.plugin_id === PLUGIN_ID)?.state;
            },
            {message: `plugin ${PLUGIN_ID} should be running`, timeout: 30_000},
        )
        .toBe(PLUGIN_RUNNING);
}
