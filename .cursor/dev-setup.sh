#!/usr/bin/env bash
# Gets the running stack ready for hands-on work in the browser: builds the plugin (skip with
# --no-build), creates the admin and a team, installs and enables the plugin, and points its OAuth
# client at the fake Google. Rerun it after changing the plugin, after `make e2e-env-down`, or after
# running the tests (they replace the plugin's settings). Start the stack first: make e2e-env-up.
set -euo pipefail

cd "$(dirname "$0")/.."

ADMIN_USER=sysadmin
ADMIN_PASSWORD='Sys@dmin-sample1'
TEAM=agent
PLUGIN_ID="$(jq -r .id plugin.json)"
# The plugin requires exactly 32 characters; the same key the tests use.
ENCRYPTION_KEY=e2e-test-encryption-key-32-chars

log() { echo "[dev-setup] $*"; }
compose() { (cd e2e/playwright && docker compose "$@"); }
mmctl() { compose exec -T mattermost /mattermost/bin/mmctl --local "$@"; }

if [[ "${1:-}" != "--no-build" ]]; then
    make dist
fi
bundle="$(ls -t "$PWD"/dist/*.tar.gz 2>/dev/null | head -1)"
[[ -n "$bundle" ]] || { log "No plugin bundle in dist/; run make dist." >&2; exit 1; }

if ! mmctl user search "$ADMIN_USER" >/dev/null 2>&1; then
    log "Creating $ADMIN_USER"
    mmctl user create --email "$ADMIN_USER@sample.mattermost.com" --username "$ADMIN_USER" \
        --password "$ADMIN_PASSWORD" --system-admin --email-verified >/dev/null
fi
if ! mmctl team search "$TEAM" 2>/dev/null | grep -q "^$TEAM:"; then
    log "Creating team $TEAM"
    mmctl team create --name "$TEAM" --display-name Agent >/dev/null
fi
mmctl team users add "$TEAM" "$ADMIN_USER" >/dev/null 2>&1 || true

client="$(curl -fsS "http://127.0.0.1:${FAKE_GOOGLE_PORT:-8080}/__control/accounts")"
patch="$(mktemp)"
chmod 644 "$patch" # mmctl runs as the mattermost user inside the container
jq -n --arg id "$PLUGIN_ID" --arg key "$ENCRYPTION_KEY" --argjson c "$client" '{PluginSettings: {
    PluginStates: {($id): {Enable: true}},
    Plugins: {($id): {googleoauthclientid: $c.clientId, googleoauthclientsecret: $c.clientSecret, encryptionkey: $key}}}}' > "$patch"

log "Installing $(basename "$bundle")"
compose cp "$bundle" mattermost:/tmp/plugin.tar.gz 2>/dev/null
compose cp "$patch" mattermost:/tmp/plugin-config.json 2>/dev/null
rm -f "$patch"
mmctl config patch /tmp/plugin-config.json >/dev/null
mmctl plugin add --force /tmp/plugin.tar.gz >/dev/null
mmctl plugin disable "$PLUGIN_ID" >/dev/null 2>&1 || true
mmctl plugin enable "$PLUGIN_ID" >/dev/null

log "Ready: http://localhost:8065 (log in as $ADMIN_USER / $ADMIN_PASSWORD, team $TEAM)."
log "Google accounts on the fake: $(jq -r '[.users[].email] | join(", ")' <<<"$client")."
