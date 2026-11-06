// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import crypto from 'crypto';

const NONCE_BYTES = 12;

/**
 * Encrypts like server/plugin/utils/utils.go Encrypt: AES-GCM with the raw key bytes (32 bytes,
 * so AES-256), output = base64url(nonce || ciphertext || tag) WITH padding (Go's URLEncoding pads,
 * Node's 'base64url' does not).
 *
 * `nonce` is only for the fixed test vector; leave it unset otherwise.
 */
export function encrypt(key: string, plaintext: string, nonce: Buffer = crypto.randomBytes(NONCE_BYTES)): string {
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), nonce);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return padBase64(Buffer.concat([nonce, sealed]).toString('base64url'));
}

export function decrypt(key: string, encoded: string): string {
    const raw = Buffer.from(encoded, 'base64url');
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(NONCE_BYTES, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function padBase64(s: string): string {
    return s + '='.repeat((4 - (s.length % 4)) % 4);
}

/**
 * Fixed vector shared with server/plugin/utils/e2e_crypto_vector_test.go, which decrypts it with
 * the plugin's own Decrypt. `npm run check` verifies this file still produces it. If either side
 * changes format, one of the two checks fails before any e2e run.
 */
export const CRYPTO_TEST_VECTOR = {
    key: 'e2e-test-encryption-key-32-chars',
    nonceHex: '000102030405060708090a0b',
    plaintext: '{"access_token":"e2e-access","token_type":"Bearer","refresh_token":"e2e-refresh","expiry":"0001-01-01T00:00:00Z"}',
    ciphertext:
        'AAECAwQFBgcICQoLncbKzMtD26R5aNPUrd8-x_dBwQyaBBBrn7mLx2YOcEYszWCdDR7JCTVbL9yFsjKG7pbjjWqwQKFl18cyfWwWz7-3VgOFlDsdzesFqH4TjmWccaAz7ZQxPpFLBIzwRPJNZf4jrPvuYw_nADzOhZ8_dD_yVIGUbU3uWKiAZlE-qti4',
};
