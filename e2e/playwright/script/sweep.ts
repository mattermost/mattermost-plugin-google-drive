// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Lists (or with --delete, moves to the Drive trash) files left behind by e2e runs in the test accounts' Drives:
// anything whose name starts with `e2e-` (exact, case-sensitive), e.g. from a run that was interrupted before its cleanup hook ran.
//
//   npm run sweep             # list
//   npm run sweep -- --delete # delete

import path from 'path';

import dotenv from 'dotenv';

dotenv.config({path: path.join(__dirname, '..', '.env.local'), quiet: true});

import {configuredGoogleAccount, GoogleRole} from '../lib/google/auth';
import {findFilesByNamePrefix, trashFile} from '../lib/google/drive';

async function main() {
    // Leftovers only exist in the real accounts.
    process.env.E2E_GOOGLE = 'real';
    const shouldDelete = process.argv.includes('--delete');
    for (const role of ['owner', 'collab'] as GoogleRole[]) {
        const account = configuredGoogleAccount(role);
        if (!account) {
            console.log(`${role}: not configured, skipped`);
            continue;
        }
        const files = await findFilesByNamePrefix(account, 'e2e-');
        console.log(`${role} (${account.email}): ${files.length} e2e file(s)`);
        for (const file of files) {
            console.log(`  ${file.name}`);
            if (shouldDelete) {
                await trashFile(account, file.id);
            }
        }
        if (shouldDelete && files.length) {
            console.log(`  moved ${files.length} to the Drive trash`);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
