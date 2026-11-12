package utils

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEncryptDecrypt(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	plaintext := []byte(`{"access_token":"secret-access","refresh_token":"secret-refresh"}`)

	t.Run("round trip returns the original data", func(t *testing.T) {
		encrypted, err := Encrypt(key, plaintext)
		require.NoError(t, err)

		decrypted, err := Decrypt(key, encrypted)
		require.NoError(t, err)
		assert.Equal(t, plaintext, decrypted)
	})

	t.Run("ciphertext does not contain the plaintext", func(t *testing.T) {
		encrypted, err := Encrypt(key, plaintext)
		require.NoError(t, err)

		assert.NotContains(t, string(encrypted), "secret-access")
		assert.NotContains(t, string(encrypted), "secret-refresh")
	})

	t.Run("encrypting the same data twice uses a fresh nonce", func(t *testing.T) {
		first, err := Encrypt(key, plaintext)
		require.NoError(t, err)
		second, err := Encrypt(key, plaintext)
		require.NoError(t, err)

		assert.NotEqual(t, first, second)
	})

	t.Run("decrypting with a different key fails", func(t *testing.T) {
		encrypted, err := Encrypt(key, plaintext)
		require.NoError(t, err)

		_, err = Decrypt([]byte(strings.Repeat("x", 32)), encrypted)
		assert.Error(t, err)
	})

	t.Run("tampered ciphertext is rejected", func(t *testing.T) {
		encrypted, err := Encrypt(key, plaintext)
		require.NoError(t, err)

		raw, err := decode(encrypted)
		require.NoError(t, err)
		raw[len(raw)-1] ^= 0xff

		_, err = Decrypt(key, encode(raw))
		assert.Error(t, err)
	})

	t.Run("data shorter than the nonce is rejected", func(t *testing.T) {
		_, err := Decrypt(key, encode([]byte("short")))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "token too short")
	})

	t.Run("data that is not valid base64 is rejected", func(t *testing.T) {
		_, err := Decrypt(key, []byte("not base64!!"))
		assert.Error(t, err)
	})

	t.Run("invalid key size is rejected", func(t *testing.T) {
		_, err := Encrypt([]byte("short-key"), plaintext)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "could not create a cipher block")

		_, err = Decrypt([]byte("short-key"), []byte("anything"))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "could not create a cipher block")
	})
}

func TestLastN(t *testing.T) {
	for name, test := range map[string]struct {
		input    string
		n        int
		expected string
	}{
		"negative n":                  {input: "abcdef", n: -1, expected: ""},
		"zero n masks up to three":    {input: "abcdef", n: 0, expected: "***"},
		"long string is cut off":      {input: "abcdefghij", n: 4, expected: "***ghij"},
		"shorter than n is unmasked":  {input: "ab", n: 4, expected: "ab"},
		"exactly n+3 characters":      {input: "abcdefg", n: 4, expected: "***defg"},
		"fewer than three to mask":    {input: "abcde", n: 4, expected: "*bcde"},
		"empty string":                {input: "", n: 4, expected: ""},
		"secret is not fully exposed": {input: "client-secret-value", n: 4, expected: "***alue"},
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, test.expected, LastN(test.input, test.n))
		})
	}
}

func TestMarkdownToHTMLEntities(t *testing.T) {
	for name, test := range map[string]struct {
		input    string
		expected string
	}{
		"plain text is unchanged": {
			input:    "Hello world 123",
			expected: "Hello world 123",
		},
		"markdown link is escaped": {
			input:    "[click](https://evil.example)",
			expected: "&#91;click&#93;&#40;https&#58;&#47;&#47;evil&#46;example&#41;",
		},
		"inline image is escaped": {
			input:    "![img](x)",
			expected: "&#33;&#91;img&#93;&#40;x&#41;",
		},
		"emphasis and code are escaped": {
			input:    "*bold* _it_ `code` ~strike~",
			expected: "&#42;bold&#42; &#95;it&#95; &#96;code&#96; &#126;strike&#126;",
		},
		"headings, lists, tables and html are escaped": {
			input:    "# h\n- a\n+ b\n| c |\n<script>\\",
			expected: "&#35; h\n&#45; a\n&#43; b\n&#124; c &#124;\n&#60;script&#62;&#92;",
		},
		"non ascii characters are preserved": {
			input:    "héllo 世界",
			expected: "héllo 世界",
		},
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, test.expected, MarkdownToHTMLEntities(test.input))
		})
	}
}

func TestMarkdownHelpers(t *testing.T) {
	assert.Equal(t, "[file](https://example.com/f)", GetHyperlink("file", "https://example.com/f"))
	assert.Equal(t, "![icon](https://example.com/i.png)", GetInlineImage("icon", "https://example.com/i.png"))
}
