// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Helpers for specs/visual/visual.spec.ts. script/visual.sh runs them on their own compose project with
// another port, a pinned server image, and a Playwright browser in a container that shares
// Mattermost's network namespace (docker-compose.visual.yml), so screenshots match on any machine
// and in CI.
// Adapted from mattermost-plugin-jira e2e/playwright (scripts/visual.sh, tests/visual.spec.ts).

import fs from 'fs';
import path from 'path';

import type {PlaywrightExtended} from '@mattermost/playwright-lib';
import {expect, Locator, Page} from '@playwright/test';

const ASSETS = path.join(__dirname, '..', 'assets');

/** Hides core UI that overlaps plugin posts and changes between runs (toHaveScreenshot stylePath). */
export const VISUAL_STYLE_PATH = path.join(ASSETS, 'visual.css');

/** Images the browser would load from the internet, served from checked-in files instead. */
const EXTERNAL_IMAGES: Array<{match: (url: URL) => boolean; file: string}> = [
    // Drive's file-type icons (`iconLink`). The fake's proxy only applies to Mattermost, so the
    // browser would load these from Google.
    {match: (url) => url.hostname === 'drive-thirdparty.googleusercontent.com', file: 'drive_file_icon.png'},
    // The create dialog's icon (server/plugin/create.go IconURL).
    {match: (url) => url.hostname === 'www.mattermost.org' && url.pathname.endsWith('/icon.png'), file: 'dialog_icon.png'},
];

/**
 * Serves the images in EXTERNAL_IMAGES from assets/ and blocks every other request that leaves
 * the server, so screenshots never depend on the network or on artwork that changes upstream.
 */
export async function routeExternalRequests(page: Page) {
    await page.context().route(
        (url) => url.hostname !== 'localhost',
        (route) => {
            const image = EXTERNAL_IMAGES.find((i) => i.match(new URL(route.request().url())));
            if (!image) {
                return route.abort('blockedbyclient');
            }
            return route.fulfill({status: 200, contentType: 'image/png', body: fs.readFileSync(path.join(ASSETS, image.file))});
        },
    );
}

/** Waits for the page around `target` to stop changing and hides core UI that differs between runs. */
export async function settle(pw: PlaywrightExtended, target: Locator) {
    const page = target.page();
    await expect(page.locator('.LoadingScreen')).toBeHidden();
    await pw.hideDynamicChannelsContent(page);
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);

    // An element measured mid slide-in gets snapped to the wrong pixel.
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => undefined)),
        ),
    );

    // Every image in the target has loaded (file icons, avatars), so none renders as broken or blank.
    await expect
        .poll(() => target.evaluate((el) => [...el.querySelectorAll('img')].filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src)))
        .toEqual([]);

    // Bottom-anchored posts and centred modals can sit at a fractional y, which moves text by a pixel row.
    await target.evaluate((el: HTMLElement) => {
        const {x, y} = el.getBoundingClientRect();
        el.style.transform = `translate(${Math.round(x) - x}px, ${Math.round(y) - y}px)`;
    });
}

/**
 * The page area covering all the targets, rounded out to whole pixels, for a page screenshot of
 * an element plus a popup that overflows it (an open select's options).
 */
export async function clipAround(...targets: Locator[]): Promise<{x: number; y: number; width: number; height: number}> {
    const boxes = await Promise.all(targets.map(async (t) => (await t.boundingBox())!));
    const x = Math.floor(Math.min(...boxes.map((b) => b.x)));
    const y = Math.floor(Math.min(...boxes.map((b) => b.y)));
    const right = Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)));
    const bottom = Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)));
    return {x, y, width: right - x, height: bottom - y};
}
