// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import tsParser from '@typescript-eslint/parser';

// Specs hold no locators or raw page interactions: those live in page objects (pages/) or
// @mattermost/playwright-lib (mattermost-server e2e-tests/playwright/CLAUDE.OPTIONAL.md, "Page
// Object Pattern"). Rules copied from mattermost-plugin-calls e2e/.eslintrc.json.
export default [
    {
        files: ['specs/**/*.ts'],
        languageOptions: {parser: tsParser},
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'CallExpression[callee.property.name=/^(locator|getByRole|getByTestId|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle|frameLocator|waitForSelector|evaluate|evaluateHandle|waitForFunction|\\$|\\$\\$)$/]',
                    message: 'No locator or page script code in specs. Use a page object in pages/ or @mattermost/playwright-lib.',
                },
                {
                    selector: 'CallExpression[callee.property.name=/^(click|dblclick|fill|hover|press|type|check|uncheck|selectOption|setInputFiles|focus|tap)$/]',
                    message: 'No raw page interactions in specs. Use a page object method.',
                },
                {
                    selector: 'MemberExpression[property.name=/^(keyboard|mouse)$/]',
                    message: 'No raw keyboard or mouse input in specs. Use a page object method.',
                },
            ],
        },
    },
];
