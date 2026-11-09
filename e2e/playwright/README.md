# Google Drive plugin e2e tests

Playwright tests for the Google Drive plugin. The same specs run against two Googles:

- **Fake Google** (default, every PR): `fake-google/` runs in the compose stack. Mattermost sends
  its outbound HTTPS through the fake's proxy, which answers for the Google hosts in
  `FAKE_GOOGLE_HOSTS` (`docker-compose.yml`) and refuses any other Google host. No accounts or
  secrets. Every request and response is checked against Google's published API specs, trimmed to
  the fields the suite uses; a violation fails the test that caused it (`lib/test.ts`).
- **Real Google** (`npm run test:real`): the test accounts in `.env.local`. Not in CI yet.

## Requirements

- Node 24 (`nvm use` picks it up from the repo's `.nvmrc`). `npm ci` refuses older versions.
- Docker. The Mattermost image is amd64 only; on Apple silicon turn on Docker Desktop's Rosetta
  emulation.
- The plugin bundle: run `make dist` in the repo root first.

## Running

```sh
nvm use
npm ci
npm run server:up        # Mattermost, Postgres and the fake Google on localhost:8065
npm test                 # fake-Google lane
npm run server:down
```

| Command | What it does |
|---|---|
| `npm test` | All specs against the fake Google, except `@visual` |
| `npm run test:real` | All specs against real Google (start the stack with `npm run server:up:real`). Tests whose credentials are missing skip locally and fail in CI |
| `npm run test:visual` | Screenshot baselines (`specs/visual/visual.spec.ts`) on their own pinned stack with a dockerized browser |
| `npm run test:visual-update-snapshots` | Regenerates the baselines; review and commit the PNGs |
| `npm run check` | Type check, ESLint, test-doc lint and the token encryption check |
| `npm run contract:check` | Reports changes in Google's published specs since `fake-google/contract/specs/` was updated (also runs daily in CI) |
| `npm run contract:update` | Regenerates `fake-google/contract/specs/` from Google and `fake-google/contract/operations.json` |
| `npm run google:auth -- owner` | Real lane only: gets a refresh token for a test account into `.env.local` |
| `npm run sweep` | Real lane only: lists leftover `e2e-` files in the test accounts' Drives; `npm run sweep -- --delete` moves them to the Drive trash |

Settings for external servers, real Google and the compose ports are in `.env.example`.

## When the contract fails

The specs in `fake-google/contract/specs/` are generated; don't edit them by hand. Change
`fake-google/contract/operations.json` (the methods, and per schema the fields the plugin sends or
the fake returns) and run `npm run contract:update`.

- **Has a field that Google does not document or `fields` does not list**: if Google documents it,
  add it to that schema's `fields`. Otherwise fix the fake (or the plugin).
- **Not covered by operations.json**: the plugin calls a new method. Add it to `methods` and
  implement it in `fake-google/server.ts`.
- **Mattermost called a host the fake does not answer for**: add the host to `FAKE_GOOGLE_HOSTS`
  in `docker-compose.yml` and route it in `fake-google/server.ts`, then recreate the stack
  (`npm run server:down && npm run server:up`) so the certificate covers it.

## Visual baselines

The committed baselines were rendered on arm64 (an Apple silicon Mac, because amd64 Chromium under
Docker Desktop's Rosetta emulation never finishes loading Mattermost). They match CI's amd64
renders with Playwright's default threshold (checked 2026-11-06). The `visual` job stays
`continue-on-error` until it has a longer track record. If it starts reporting anti-aliasing
diffs, regenerate the baselines on an amd64 machine and commit those PNGs.

## Writing tests

Follow the Mattermost Playwright conventions (mattermost-server `e2e-tests/playwright`):

- Import `test` and `expect` from `lib/test.ts`.
- No locators or raw clicks in specs: they go in page objects in `pages/`. ESLint enforces this.
- A JSDoc block with `@objective` (and `@precondition` when setup isn't the default) before each
  test, `// #` comments for actions and `// *` for checks, and `{tag: '@google_drive'}`.
  `npm run lint:test-docs` enforces this.
- Name Google files with `e2eFileName()` so cleanup finds them.
