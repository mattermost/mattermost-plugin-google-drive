package config

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func validConfiguration() *Configuration {
	return &Configuration{
		GoogleOAuthClientID:     "client-id.apps.googleusercontent.com",
		GoogleOAuthClientSecret: "client-secret",
		EncryptionKey:           strings.Repeat("k", 32),
		QueriesPerMinute:        60,
		BurstSize:               10,
	}
}

func TestIsValid(t *testing.T) {
	for name, test := range map[string]struct {
		modify      func(c *Configuration)
		expectedErr string
	}{
		"valid configuration": {
			modify: func(c *Configuration) {},
		},
		"missing client id": {
			modify:      func(c *Configuration) { c.GoogleOAuthClientID = "" },
			expectedErr: "must have a Google OAuth client id",
		},
		"client id longer than 200 characters": {
			modify:      func(c *Configuration) { c.GoogleOAuthClientID = strings.Repeat("a", 201) },
			expectedErr: "Google OAuth client id must be less than 200 characters",
		},
		"client id of exactly 200 characters": {
			modify: func(c *Configuration) { c.GoogleOAuthClientID = strings.Repeat("a", 200) },
		},
		"missing client secret": {
			modify:      func(c *Configuration) { c.GoogleOAuthClientSecret = "" },
			expectedErr: "must have a Google OAuth client secret",
		},
		"client secret longer than 100 characters": {
			modify:      func(c *Configuration) { c.GoogleOAuthClientSecret = strings.Repeat("a", 101) },
			expectedErr: "Google OAuth client secret must be less than",
		},
		"client secret of exactly 100 characters": {
			modify: func(c *Configuration) { c.GoogleOAuthClientSecret = strings.Repeat("a", 100) },
		},
		"missing encryption key": {
			modify:      func(c *Configuration) { c.EncryptionKey = "" },
			expectedErr: "must have an encryption key",
		},
		"encryption key too short": {
			modify:      func(c *Configuration) { c.EncryptionKey = strings.Repeat("k", 16) },
			expectedErr: "encryption key must be 32 characters long",
		},
		"encryption key too long": {
			modify:      func(c *Configuration) { c.EncryptionKey = strings.Repeat("k", 33) },
			expectedErr: "encryption key must be 32 characters long",
		},
		"zero queries per minute": {
			modify:      func(c *Configuration) { c.QueriesPerMinute = 0 },
			expectedErr: "queries per minute must be greater than 0",
		},
		"negative queries per minute": {
			modify:      func(c *Configuration) { c.QueriesPerMinute = -1 },
			expectedErr: "queries per minute must be greater than 0",
		},
		"zero burst size": {
			modify:      func(c *Configuration) { c.BurstSize = 0 },
			expectedErr: "burst size must be greater than 0",
		},
		"negative burst size": {
			modify:      func(c *Configuration) { c.BurstSize = -1 },
			expectedErr: "burst size must be greater than 0",
		},
	} {
		t.Run(name, func(t *testing.T) {
			c := validConfiguration()
			test.modify(c)

			err := c.IsValid()
			if test.expectedErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), test.expectedErr)
		})
	}
}

func TestSetDefaults(t *testing.T) {
	t.Run("fills in all missing values", func(t *testing.T) {
		c := &Configuration{}

		changed, err := c.SetDefaults()

		require.NoError(t, err)
		assert.True(t, changed)
		assert.Len(t, c.EncryptionKey, 32)
		assert.Equal(t, 12000, c.QueriesPerMinute)
		assert.Equal(t, 1000, c.BurstSize)
	})

	t.Run("keeps existing values", func(t *testing.T) {
		c := validConfiguration()
		original := *c

		changed, err := c.SetDefaults()

		require.NoError(t, err)
		assert.False(t, changed)
		assert.Equal(t, original, *c)
	})

	t.Run("generated encryption key is accepted by IsValid", func(t *testing.T) {
		c := validConfiguration()
		c.EncryptionKey = ""

		_, err := c.SetDefaults()
		require.NoError(t, err)

		assert.NoError(t, c.IsValid())
	})

	t.Run("generates a different encryption key each time", func(t *testing.T) {
		c1 := &Configuration{}
		c2 := &Configuration{}

		_, err := c1.SetDefaults()
		require.NoError(t, err)
		_, err = c2.SetDefaults()
		require.NoError(t, err)

		assert.NotEqual(t, c1.EncryptionKey, c2.EncryptionKey)
	})
}

func TestSanitize(t *testing.T) {
	c := &Configuration{
		GoogleOAuthClientID:     "  client-id \n",
		GoogleOAuthClientSecret: "\tclient-secret  ",
	}

	c.Sanitize()

	assert.Equal(t, "client-id", c.GoogleOAuthClientID)
	assert.Equal(t, "client-secret", c.GoogleOAuthClientSecret)
}

func TestIsOAuthConfigured(t *testing.T) {
	for name, test := range map[string]struct {
		clientID     string
		clientSecret string
		expected     bool
	}{
		"both set":       {clientID: "id", clientSecret: "secret", expected: true},
		"missing id":     {clientSecret: "secret", expected: false},
		"missing secret": {clientID: "id", expected: false},
		"neither set":    {expected: false},
	} {
		t.Run(name, func(t *testing.T) {
			c := &Configuration{GoogleOAuthClientID: test.clientID, GoogleOAuthClientSecret: test.clientSecret}
			assert.Equal(t, test.expected, c.IsOAuthConfigured())
		})
	}
}

func TestClone(t *testing.T) {
	c := validConfiguration()

	clone := c.Clone()
	require.Equal(t, c, clone)

	clone.GoogleOAuthClientID = "changed"
	assert.NotEqual(t, c.GoogleOAuthClientID, clone.GoogleOAuthClientID)
}

func TestClientConfigurationDoesNotExposeSecrets(t *testing.T) {
	assert.Empty(t, validConfiguration().ClientConfiguration())
}

func TestToMap(t *testing.T) {
	c := validConfiguration()

	out, err := c.ToMap()

	require.NoError(t, err)
	assert.Equal(t, map[string]any{
		"googleoauthclientid":     c.GoogleOAuthClientID,
		"googleoauthclientsecret": c.GoogleOAuthClientSecret,
		"encryptionkey":           c.EncryptionKey,
		"queriesperminute":        float64(c.QueriesPerMinute),
		"burstsize":               float64(c.BurstSize),
	}, out)
}
