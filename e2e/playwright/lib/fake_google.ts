// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Talks to fake-google/'s /__control API. The fake runs in the compose stack (docker-compose.yml,
// `fake` profile); global setup exports FAKE_GOOGLE_URL.
//
// Mattermost reaches the fake through the fake's HTTPS proxy, which tunnels Google's real hostnames
// to it, over TLS with a throwaway CA that Go trusts through SSL_CERT_FILE (fake-google/gen-certs.sh).
// No plugin code changes are needed. Adapted from mattermost-plugin-mscalendar's fake Microsoft
// (e2e/playwright/fake-microsoft).

async function control<T>(method: string, route: string, body?: unknown): Promise<T> {
    const base = process.env.FAKE_GOOGLE_URL;
    if (!base) {
        throw new Error('FAKE_GOOGLE_URL is not set; the fake only runs with E2E_GOOGLE=fake.');
    }
    const response = await fetch(`${base}/__control/${route}`, {
        method,
        headers: {'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`Fake Google ${method} ${route} failed: ${response.status} ${await response.text()}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
}

export type FakeGoogleAccounts = {
    clientId: string;
    clientSecret: string;
    users: Array<{key: 'owner' | 'collab'; email: string; displayName: string; refreshToken: string}>;
};

export const fakeGoogle = {
    reset: () => control('POST', 'reset'),
    accounts: () => control<FakeGoogleAccounts>('GET', 'accounts'),
    /** Everything recorded so far, including `late`: violations deferred past the test that caused them. */
    violations: () => control<{value: string[]; divergences: string[]; late: string[]}>('GET', 'violations'),
    /** Returns and clears the current violations in one step. */
    takeViolations: () => control<{value: string[]; divergences: string[]}>('POST', 'violations/take'),
    /** Moves the current violations to `late`, which global teardown fails the run on. */
    deferViolations: () => control<{value: string[]; divergences: string[]}>('POST', 'violations/defer'),
    requests: async () => (await control<{value: Array<{method: string; host: string; path: string; status: number; methodId?: string}>}>('GET', 'requests')).value,
    setDomainSharingPolicy: (domainSharingPolicy: string) => control('POST', 'config', {domainSharingPolicy}),
};
