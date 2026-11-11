#!/usr/bin/env bash
# Trusts the fake Google's throwaway CA system-wide and in the NSS database Chrome and Chromium read
# on Linux, so the agent's browser accepts the fake's certificate for accounts.google.com. Safe to
# rerun; does nothing until the stack has generated the certificates.
set -euo pipefail

CERT_DIR="${FAKE_GOOGLE_CERT_DIR:-/home/ubuntu/.cache/fake-google-certs}"
CA="$CERT_DIR/ca.crt"
NAME="Fake Google E2E CA"
NSSDB="sql:$HOME/.pki/nssdb"

if [[ ! -f "$CA" ]]; then
    echo "[trust-fake-ca] $CA does not exist yet; run make e2e-env-up first."
    exit 0
fi

if ! cmp -s "$CA" /usr/local/share/ca-certificates/fake-google-e2e.crt; then
    sudo cp "$CA" /usr/local/share/ca-certificates/fake-google-e2e.crt
    sudo update-ca-certificates >/dev/null
fi

mkdir -p "$HOME/.pki/nssdb"
[[ -f "$HOME/.pki/nssdb/cert9.db" ]] || certutil -d "$NSSDB" -N --empty-password
certutil -d "$NSSDB" -D -n "$NAME" >/dev/null 2>&1 || true
certutil -d "$NSSDB" -A -t "C,," -n "$NAME" -i "$CA"
echo "[trust-fake-ca] Trusted $NAME."
