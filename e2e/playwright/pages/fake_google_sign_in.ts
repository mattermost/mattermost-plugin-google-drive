// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {Locator, Page} from '@playwright/test';

/**
 * The fake Google's account chooser and consent pages (fake-google/server.ts authorize, consent),
 * served in the browser by lib/drive_oauth.ts routeGoogleSignInToFake.
 */
export class FakeGoogleSignIn {
    constructor(private readonly page: Page) {}

    get accountChooser(): Locator {
        return this.page.getByRole('heading', {name: 'Choose an account'});
    }

    get consent(): Locator {
        return this.page.getByRole('heading', {name: /wants access to your Google Account$/});
    }

    /** Picks the account by email and allows the requested access. */
    async signInAndAllow(email: string) {
        await this.page.getByRole('button', {name: new RegExp(`\\(${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'i')}).click();
        await this.consent.waitFor();
        await this.page.getByRole('button', {name: 'Allow'}).click();
    }
}
