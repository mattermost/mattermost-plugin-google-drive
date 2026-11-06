// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import path from 'path';

import {defineConfig, devices} from '@playwright/test';
import dotenv from 'dotenv';

import {VISUAL_STYLE_PATH} from './lib/visual';

dotenv.config({path: path.join(__dirname, '.env.local'), quiet: true});

// Visual runs (npm run test:visual) set PW_BASE_URL to their own stack and PW_VISUAL_BROWSER_WS
// to its dockerized browser (script/visual.sh). Without PW_VISUAL_BROWSER_WS the visual specs skip,
// because their baselines only match that browser.

// The compose stack (npm run server:up) publishes Mattermost on a fixed host port that matches its
// internal port, so SiteURL http://localhost:8065 resolves to the server from the browser and from
// inside the container (the plugin's comment-reply action posts back to an absolute SiteURL).
// @mattermost/playwright-lib reads PW_BASE_URL when it is first imported, so set it here, before
// any spec loads the library.
// In external mode (E2E_SERVER=external) set PW_BASE_URL to the running server instead.
process.env.PW_BASE_URL ??= 'http://localhost:8065';

// Identifies this run's Google Drive files (see lib/google/drive.ts e2eFileName). Set once in the
// runner; workers inherit it.
process.env.E2E_RUN_ID ??= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default defineConfig({
    testDir: './specs',
    outputDir: './results/output',

    // No platform suffix: baselines always come from the dockerized browser.
    snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',

    // One worker per server (mattermost-server e2e-tests/playwright/AGENTS.md). The Google test
    // accounts are shared too, so specs must never run concurrently.
    workers: 1,
    fullyParallel: false,

    forbidOnly: !!process.env.CI,
    retries: 0,
    timeout: 120_000,
    expect: {timeout: 15_000, toHaveScreenshot: {stylePath: VISUAL_STYLE_PATH}},

    globalSetup: require.resolve('./global_setup'),
    globalTeardown: require.resolve('./global_teardown'),

    reporter: [['list'], ['html', {outputFolder: './results/reporter', open: 'never'}]],

    use: {
        baseURL: process.env.PW_BASE_URL,
        // Traces and screenshots can capture tokens shown in the UI or sent in requests, so they
        // stay off in CI (same policy as the Boards suite).
        trace: process.env.CI ? 'off' : 'retain-on-failure',
        screenshot: process.env.CI ? 'off' : 'only-on-failure',
        // PW_SLOWMO=500 pauses that many ms between browser actions, for watching a headed run.
        launchOptions: {slowMo: Number(process.env.PW_SLOWMO ?? 0)},
        connectOptions: process.env.PW_VISUAL_BROWSER_WS ? {wsEndpoint: process.env.PW_VISUAL_BROWSER_WS} : undefined,
    },

    projects: [
        {
            name: 'chrome',
            // Fixed viewport: visual baselines depend on it.
            use: {...devices['Desktop Chrome'], viewport: {width: 1280, height: 1024}},
        },
    ],
});
