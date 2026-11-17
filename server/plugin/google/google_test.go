package google

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	oauth2package "golang.org/x/oauth2"
	"golang.org/x/time/rate"
	"google.golang.org/api/googleapi"

	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/config"
	mock_store "github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/kvstore/mocks"
	mock_oauth2 "github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/oauth2/mocks"
	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/utils"
)

const testEncryptionKey = "0123456789abcdef0123456789abcdef"

func newTestClient(t *testing.T) (*Client, *mock_store.MockKVStore, *plugintest.API) {
	t.Helper()
	ctrl := gomock.NewController(t)
	kv := mock_store.NewMockKVStore(ctrl)
	api := &plugintest.API{}
	t.Cleanup(func() { api.AssertExpectations(t) })

	client := NewGoogleClient(mock_oauth2.NewMockConfig(ctrl), &config.Configuration{
		EncryptionKey:    testEncryptionKey,
		QueriesPerMinute: 60,
		BurstSize:        10,
	}, kv, api).(*Client)
	return client, kv, api
}

func TestGetGoogleUserToken(t *testing.T) {
	t.Run("decrypts the stored token", func(t *testing.T) {
		client, kv, _ := newTestClient(t)
		token := oauth2package.Token{AccessToken: "access", RefreshToken: "refresh", TokenType: "Bearer"}
		jsonToken, err := json.Marshal(token)
		require.NoError(t, err)
		encrypted, err := utils.Encrypt([]byte(testEncryptionKey), jsonToken)
		require.NoError(t, err)
		kv.EXPECT().GetGoogleUserToken("user1").Return(encrypted, nil)

		got, err := client.GetGoogleUserToken("user1")

		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, "access", got.AccessToken)
		assert.Equal(t, "refresh", got.RefreshToken)
		assert.Equal(t, "Bearer", got.TokenType)
	})

	t.Run("returns no token when the user is not connected", func(t *testing.T) {
		client, kv, _ := newTestClient(t)
		kv.EXPECT().GetGoogleUserToken("user1").Return(nil, nil)

		got, err := client.GetGoogleUserToken("user1")

		require.NoError(t, err)
		assert.Nil(t, got)
	})

	t.Run("rejects a token encrypted with a different key", func(t *testing.T) {
		client, kv, _ := newTestClient(t)
		encrypted, err := utils.Encrypt([]byte("ffffffffffffffffffffffffffffffff"), []byte(`{"access_token":"access"}`))
		require.NoError(t, err)
		kv.EXPECT().GetGoogleUserToken("user1").Return(encrypted, nil)

		got, err := client.GetGoogleUserToken("user1")

		assert.Error(t, err)
		assert.Nil(t, got)
	})

	t.Run("returns the KV store error", func(t *testing.T) {
		client, kv, _ := newTestClient(t)
		kvErr := errors.New("kv failure")
		kv.EXPECT().GetGoogleUserToken("user1").Return(nil, kvErr)

		_, err := client.GetGoogleUserToken("user1")

		assert.Equal(t, kvErr, err)
	})
}

func serviceBase(t *testing.T, service any) googleServiceBase {
	t.Helper()
	switch s := service.(type) {
	case *DriveService:
		return s.googleServiceBase
	case *DriveServiceV2:
		return s.googleServiceBase
	case *DocsService:
		return s.googleServiceBase
	case *SlidesService:
		return s.googleServiceBase
	case *SheetsService:
		return s.googleServiceBase
	case *DriveActivityService:
		return s.googleServiceBase
	}
	require.Failf(t, "unexpected service type", "%T", service)
	return googleServiceBase{}
}

func TestNewServicesRespectRateLimits(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		name        string
		serviceType string
		hasLimiter  bool
		create      func(c *Client) (any, error)
	}{
		{"drive", driveServiceType, true, func(c *Client) (any, error) { return c.NewDriveService(ctx, "user1") }},
		{"drive v2", driveServiceType, true, func(c *Client) (any, error) { return c.NewDriveV2Service(ctx, "user1") }},
		{"docs", docsServiceType, false, func(c *Client) (any, error) { return c.NewDocsService(ctx, "user1") }},
		{"slides", slidesServiceType, false, func(c *Client) (any, error) { return c.NewSlidesService(ctx, "user1") }},
		{"sheets", sheetsServiceType, false, func(c *Client) (any, error) { return c.NewSheetsService(ctx, "user1") }},
		{"drive activity", driveActivityServiceType, false, func(c *Client) (any, error) { return c.NewDriveActivityService(ctx, "user1") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Run("fails while the user is rate limited", func(t *testing.T) {
				client, kv, _ := newTestClient(t)
				kv.EXPECT().GetGoogleUserToken("user1").Return(nil, nil)
				kv.EXPECT().GetUserRateLimitExceeded(test.serviceType, "user1").Return(true, nil)

				_, err := test.create(client)

				require.Error(t, err)
				assert.Equal(t, "user rate limit exceeded for Google service: "+test.serviceType, err.Error())
			})

			t.Run("fails when the token cannot be read", func(t *testing.T) {
				client, kv, _ := newTestClient(t)
				kv.EXPECT().GetGoogleUserToken("user1").Return(nil, errors.New("kv failure"))

				_, err := test.create(client)

				assert.Error(t, err)
			})

			t.Run("returns a service when connected and not rate limited", func(t *testing.T) {
				ctrl := gomock.NewController(t)
				kv := mock_store.NewMockKVStore(ctrl)
				oauthConfig := mock_oauth2.NewMockConfig(ctrl)
				client := NewGoogleClient(oauthConfig, &config.Configuration{
					EncryptionKey:    testEncryptionKey,
					QueriesPerMinute: 60,
					BurstSize:        10,
				}, kv, &plugintest.API{}).(*Client)

				jsonToken, err := json.Marshal(oauth2package.Token{AccessToken: "access", RefreshToken: "refresh"})
				require.NoError(t, err)
				encrypted, err := utils.Encrypt([]byte(testEncryptionKey), jsonToken)
				require.NoError(t, err)
				kv.EXPECT().GetGoogleUserToken("user1").Return(encrypted, nil)
				kv.EXPECT().GetUserRateLimitExceeded(test.serviceType, "user1").Return(false, nil)
				kv.EXPECT().GetProjectRateLimitExceeded(test.serviceType).Return(false, nil)
				oauthConfig.EXPECT().TokenSource(gomock.Any(), gomock.Any()).Return(oauth2package.StaticTokenSource(&oauth2package.Token{AccessToken: "access"}))

				service, err := test.create(client)

				require.NoError(t, err)
				base := serviceBase(t, service)
				assert.Equal(t, test.serviceType, base.serviceType)
				assert.Equal(t, "user1", base.userID)
				if test.hasLimiter {
					assert.Same(t, client.driveLimiter, base.limiter)
				} else {
					assert.Nil(t, base.limiter)
				}
			})
		})
	}
}

func TestCheckKVStoreLimitExceeded(t *testing.T) {
	kvErr := errors.New("kv failure")

	for name, test := range map[string]struct {
		setup       func(kv *mock_store.MockKVStore)
		expectedErr string
	}{
		"not rate limited": {
			setup: func(kv *mock_store.MockKVStore) {
				kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(false, nil)
				kv.EXPECT().GetProjectRateLimitExceeded("drive").Return(false, nil)
			},
		},
		"user rate limited": {
			setup: func(kv *mock_store.MockKVStore) {
				kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(true, nil)
			},
			expectedErr: "user rate limit exceeded for Google service: drive",
		},
		"project rate limited": {
			setup: func(kv *mock_store.MockKVStore) {
				kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(false, nil)
				kv.EXPECT().GetProjectRateLimitExceeded("drive").Return(true, nil)
			},
			expectedErr: "project rate limit exceeded for Google service: drive",
		},
		"user lookup fails": {
			setup: func(kv *mock_store.MockKVStore) {
				kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(false, kvErr)
			},
			expectedErr: kvErr.Error(),
		},
		"project lookup fails": {
			setup: func(kv *mock_store.MockKVStore) {
				kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(false, nil)
				kv.EXPECT().GetProjectRateLimitExceeded("drive").Return(false, kvErr)
			},
			expectedErr: kvErr.Error(),
		},
	} {
		t.Run(name, func(t *testing.T) {
			kv := mock_store.NewMockKVStore(gomock.NewController(t))
			test.setup(kv)

			err := checkKVStoreLimitExceeded(kv, "drive", "user1")
			if test.expectedErr == "" {
				assert.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Equal(t, test.expectedErr, err.Error())
		})
	}
}

func rateLimitDetail(quotaLimit string) map[string]any {
	return map[string]any{
		"@type":  "type.googleapis.com/google.rpc.ErrorInfo",
		"reason": "RATE_LIMIT_EXCEEDED",
		"metadata": map[string]any{
			"quota_limit": quotaLimit,
		},
	}
}

func TestCheckForRateLimitErrors(t *testing.T) {
	for name, test := range map[string]struct {
		apiErr     error
		setup      func(kv *mock_store.MockKVStore, api *plugintest.API)
		expectJoin bool
	}{
		"non Google errors are returned unchanged": {
			apiErr: errors.New("network failure"),
			setup:  func(*mock_store.MockKVStore, *plugintest.API) {},
		},
		"Google errors unrelated to rate limits are returned unchanged": {
			apiErr: &googleapi.Error{Code: 404, Errors: []googleapi.ErrorItem{{Reason: "notFound"}}},
			setup:  func(*mock_store.MockKVStore, *plugintest.API) {},
		},
		"user rate limit is recorded for the user": {
			apiErr: &googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: ""}, {Reason: "userRateLimitExceeded"}}},
			setup: func(kv *mock_store.MockKVStore, _ *plugintest.API) {
				kv.EXPECT().StoreUserRateLimitExceeded("drive", "user1").Return(nil)
			},
		},
		"failing to record the user rate limit is reported": {
			apiErr: &googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: "userRateLimitExceeded"}}},
			setup: func(kv *mock_store.MockKVStore, _ *plugintest.API) {
				kv.EXPECT().StoreUserRateLimitExceeded("drive", "user1").Return(errors.New("kv failure"))
			},
			expectJoin: true,
		},
		"per-user quota is recorded for the user": {
			apiErr: &googleapi.Error{
				Code:    429,
				Errors:  []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}},
				Details: []any{rateLimitDetail("defaultPerMinutePerUser")},
			},
			setup: func(kv *mock_store.MockKVStore, _ *plugintest.API) {
				kv.EXPECT().StoreUserRateLimitExceeded("drive", "user1").Return(nil)
			},
		},
		"project quota is recorded for the whole project": {
			apiErr: &googleapi.Error{
				Code:    429,
				Errors:  []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}},
				Details: []any{rateLimitDetail("defaultPerMinutePerProject")},
			},
			setup: func(kv *mock_store.MockKVStore, _ *plugintest.API) {
				kv.EXPECT().StoreProjectRateLimitExceeded("drive").Return(nil)
			},
		},
		"failing to record the project rate limit is reported": {
			apiErr: &googleapi.Error{
				Code:    429,
				Errors:  []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}},
				Details: []any{rateLimitDetail("defaultPerMinutePerProject")},
			},
			setup: func(kv *mock_store.MockKVStore, _ *plugintest.API) {
				kv.EXPECT().StoreProjectRateLimitExceeded("drive").Return(errors.New("kv failure"))
			},
			expectJoin: true,
		},
		"rate limit without details is not recorded": {
			apiErr: &googleapi.Error{Code: 429, Errors: []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}}},
			setup:  func(*mock_store.MockKVStore, *plugintest.API) {},
		},
		"rate limit detail with another reason is recorded for the whole project": {
			apiErr: &googleapi.Error{
				Code:    429,
				Errors:  []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}},
				Details: []any{map[string]any{"reason": "QUOTA_EXCEEDED", "metadata": map[string]any{"quota_limit": "defaultPerMinutePerUser"}}},
			},
			setup: func(kv *mock_store.MockKVStore, _ *plugintest.API) {
				kv.EXPECT().StoreProjectRateLimitExceeded("drive").Return(nil)
			},
		},
		"unparseable details are logged and skipped": {
			apiErr: &googleapi.Error{
				Code:    429,
				Errors:  []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}},
				Details: []any{"not an object"},
			},
			setup: func(_ *mock_store.MockKVStore, api *plugintest.API) {
				api.On("LogWarn", "Failed to parse error details", "err", mock.Anything).Once()
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			client, kv, api := newTestClient(t)
			test.setup(kv, api)
			base := googleServiceBase{serviceType: driveServiceType, userID: "user1", kvstore: kv, papi: client.papi}

			err := base.checkForRateLimitErrors(test.apiErr)

			if test.expectJoin {
				require.Error(t, err)
				assert.ErrorIs(t, err, test.apiErr)
				assert.Contains(t, err.Error(), "kv failure")
				return
			}
			assert.Equal(t, test.apiErr, err)
		})
	}
}

func TestCheckRateLimits(t *testing.T) {
	t.Run("passes when not rate limited and the limiter has capacity", func(t *testing.T) {
		kv := mock_store.NewMockKVStore(gomock.NewController(t))
		kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(false, nil)
		kv.EXPECT().GetProjectRateLimitExceeded("drive").Return(false, nil)
		base := googleServiceBase{serviceType: driveServiceType, userID: "user1", kvstore: kv, limiter: rate.NewLimiter(rate.Every(time.Hour), 1)}

		assert.NoError(t, base.checkRateLimits(context.Background()))
	})

	t.Run("fails when the KV store says the user is rate limited", func(t *testing.T) {
		kv := mock_store.NewMockKVStore(gomock.NewController(t))
		kv.EXPECT().GetUserRateLimitExceeded("docs", "user1").Return(true, nil)
		base := googleServiceBase{serviceType: docsServiceType, userID: "user1", kvstore: kv}

		assert.EqualError(t, base.checkRateLimits(context.Background()), "user rate limit exceeded for Google service: docs")
	})

	t.Run("fails when the limiter cannot grant a token before the context ends", func(t *testing.T) {
		kv := mock_store.NewMockKVStore(gomock.NewController(t))
		kv.EXPECT().GetUserRateLimitExceeded("drive", "user1").Return(false, nil).Times(2)
		kv.EXPECT().GetProjectRateLimitExceeded("drive").Return(false, nil).Times(2)
		base := googleServiceBase{serviceType: driveServiceType, userID: "user1", kvstore: kv, limiter: rate.NewLimiter(rate.Every(time.Hour), 1)}

		require.NoError(t, base.checkRateLimits(context.Background()))

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancel()
		assert.Error(t, base.checkRateLimits(ctx))
	})
}

func TestReloadConfigs(t *testing.T) {
	client, _, _ := newTestClient(t)
	newOAuthConfig := mock_oauth2.NewMockConfig(gomock.NewController(t))

	client.ReloadConfigs(120, 5, newOAuthConfig)

	assert.Equal(t, newOAuthConfig, client.oauthConfig)
	assert.Equal(t, rate.Limit(2), client.driveLimiter.Limit())
	assert.Equal(t, 5, client.driveLimiter.Burst())
}
