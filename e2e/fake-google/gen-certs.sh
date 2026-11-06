#!/bin/sh
# Creates a throwaway CA and a certificate for the Google hosts the fake answers for, then a CA
# bundle (system roots plus the throwaway CA) for Mattermost's SSL_CERT_FILE. Runs in the `certs`
# service of e2e/docker-compose.yml. Adapted from mattermost-plugin-mscalendar
# e2e/playwright/fake-microsoft/gen-certs.sh.
set -eu

# FAKE_GOOGLE_HOSTS is set in e2e/docker-compose.yml, which gives the fake the same list.
HOSTS="$FAKE_GOOGLE_HOSTS"

cd /certs

if [ -f fake.crt ] && [ -f fake.key ] && [ -f ca-bundle.crt ]; then
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout ca.key -out ca.crt \
  -subj "/CN=Fake Google E2E CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

SAN=""
for host in $HOSTS; do
  SAN="${SAN:+$SAN,}DNS:$host"
done
openssl req -newkey rsa:2048 -nodes -keyout fake.key -out fake.csr -subj "/CN=www.googleapis.com"
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n" "$SAN" > san.ext
openssl x509 -req -in fake.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -extfile san.ext -out fake.crt

cat /etc/ssl/certs/ca-certificates.crt ca.crt > ca-bundle.crt
chmod 644 ./*
