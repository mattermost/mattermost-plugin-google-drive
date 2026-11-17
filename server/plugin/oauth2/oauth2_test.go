package oauth2

import (
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2/google"

	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/config"
)

func newTestConfig(t *testing.T, manifestID string) *ConfigWrapper {
	t.Helper()
	siteURL := "https://mattermost.example.com"
	cfg := GetOAuthConfig(&config.Configuration{
		GoogleOAuthClientID:     "client-id",
		GoogleOAuthClientSecret: "client-secret",
	}, &siteURL, manifestID)

	wrapper, ok := cfg.(*ConfigWrapper)
	require.True(t, ok)
	return wrapper
}

func TestGetOAuthConfig(t *testing.T) {
	wrapper := newTestConfig(t, "com.mattermost.google-drive")

	assert.Equal(t, "client-id", wrapper.oauth2Config.ClientID)
	assert.Equal(t, "client-secret", wrapper.oauth2Config.ClientSecret)
	assert.Equal(t, google.Endpoint, wrapper.oauth2Config.Endpoint)
	assert.Equal(t, "https://mattermost.example.com/plugins/com.mattermost.google-drive/oauth/complete", wrapper.oauth2Config.RedirectURL)
	assert.ElementsMatch(t, []string{
		"https://www.googleapis.com/auth/userinfo.profile",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/drive.activity",
		"https://www.googleapis.com/auth/documents",
		"https://www.googleapis.com/auth/presentations",
		"https://www.googleapis.com/auth/spreadsheets",
		"https://www.googleapis.com/auth/drive",
	}, wrapper.oauth2Config.Scopes)
}

func TestGetOAuthConfigEscapesManifestID(t *testing.T) {
	wrapper := newTestConfig(t, "id/../with spaces")

	assert.Equal(t, "https://mattermost.example.com/plugins/id%2F..%2Fwith%20spaces/oauth/complete", wrapper.oauth2Config.RedirectURL)
}

func TestAuthCodeURL(t *testing.T) {
	wrapper := newTestConfig(t, "com.mattermost.google-drive")

	authURL, err := url.Parse(wrapper.AuthCodeURL("state_123"))
	require.NoError(t, err)

	expectedAuthURL, err := url.Parse(google.Endpoint.AuthURL)
	require.NoError(t, err)
	assert.Equal(t, expectedAuthURL.Host, authURL.Host)
	assert.Equal(t, expectedAuthURL.Path, authURL.Path)

	query := authURL.Query()
	assert.Equal(t, "state_123", query.Get("state"))
	assert.Equal(t, "client-id", query.Get("client_id"))
	assert.Equal(t, "code", query.Get("response_type"))
	assert.Equal(t, "offline", query.Get("access_type"))
	assert.Equal(t, "consent", query.Get("prompt"))
	assert.Equal(t, wrapper.oauth2Config.RedirectURL, query.Get("redirect_uri"))
	assert.Empty(t, query.Get("client_secret"))
}

func TestReloadConfig(t *testing.T) {
	wrapper := newTestConfig(t, "com.mattermost.google-drive")
	redirectURL := wrapper.oauth2Config.RedirectURL

	wrapper.ReloadConfig(&config.Configuration{
		GoogleOAuthClientID:     "new-client-id",
		GoogleOAuthClientSecret: "new-client-secret",
	})

	assert.Equal(t, "new-client-id", wrapper.oauth2Config.ClientID)
	assert.Equal(t, "new-client-secret", wrapper.oauth2Config.ClientSecret)
	assert.Equal(t, redirectURL, wrapper.oauth2Config.RedirectURL)
}
