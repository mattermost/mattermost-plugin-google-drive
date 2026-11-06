package utils

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestDecryptE2ECryptoVector pins the token encryption format the Playwright e2e suite relies on
// to seed connected users directly into the plugin KV store. The vector is produced by
// e2e/lib/crypto.ts (CRYPTO_TEST_VECTOR); keep the two in sync.
func TestDecryptE2ECryptoVector(t *testing.T) {
	const (
		key        = "e2e-test-encryption-key-32-chars"
		plaintext  = `{"access_token":"e2e-access","token_type":"Bearer","refresh_token":"e2e-refresh","expiry":"0001-01-01T00:00:00Z"}`
		ciphertext = "AAECAwQFBgcICQoLncbKzMtD26R5aNPUrd8-x_dBwQyaBBBrn7mLx2YOcEYszWCdDR7JCTVbL9yFsjKG7pbjjWqwQKFl18cyfWwWz7-3VgOFlDsdzesFqH4TjmWccaAz7ZQxPpFLBIzwRPJNZf4jrPvuYw_nADzOhZ8_dD_yVIGUbU3uWKiAZlE-qti4"
	)

	decrypted, err := Decrypt([]byte(key), []byte(ciphertext))
	require.NoError(t, err)
	require.Equal(t, plaintext, string(decrypted))
}
