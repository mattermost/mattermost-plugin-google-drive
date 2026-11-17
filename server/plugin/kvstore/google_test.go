package kvstore

import (
	"encoding/json"
	"testing"

	mattermostModel "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/mattermost/mattermost/server/public/pluginapi"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/model"
)

var appErr = &mattermostModel.AppError{Message: "kv failure"}

func setupKVStore(t *testing.T) (KVStore, *plugintest.API) {
	t.Helper()
	api := &plugintest.API{}
	t.Cleanup(func() { api.AssertExpectations(t) })
	return NewKVStore(pluginapi.NewClient(api, nil)), api
}

func noExpiry() mattermostModel.PluginKVSetOptions {
	return mattermostModel.PluginKVSetOptions{}
}

func tenSecondExpiry() mattermostModel.PluginKVSetOptions {
	return mattermostModel.PluginKVSetOptions{ExpireInSeconds: 10}
}

func TestGoogleUserToken(t *testing.T) {
	token := []byte("encrypted-token")

	t.Run("store saves the raw token under a per-user key", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user1_token", token, noExpiry()).Return(true, nil)

		require.NoError(t, kv.StoreGoogleUserToken("user1", token))
	})

	t.Run("store returns an error when the value is not saved", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user1_token", token, noExpiry()).Return(false, nil)

		assert.Error(t, kv.StoreGoogleUserToken("user1", token))
	})

	t.Run("store wraps a database error", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user1_token", token, noExpiry()).Return(false, appErr)

		err := kv.StoreGoogleUserToken("user1", token)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "database error")
	})

	t.Run("get reads the requesting user's key", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user1_token").Return(token, nil)
		api.On("KVGet", "user2_token").Return([]byte("other-token"), nil)

		stored, err := kv.GetGoogleUserToken("user1")
		require.NoError(t, err)
		assert.Equal(t, token, stored)

		stored, err = kv.GetGoogleUserToken("user2")
		require.NoError(t, err)
		assert.Equal(t, []byte("other-token"), stored)
	})

	t.Run("get returns an empty token when the user is not connected", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user1_token").Return(nil, nil)

		stored, err := kv.GetGoogleUserToken("user1")
		require.NoError(t, err)
		assert.Empty(t, stored)
	})

	t.Run("get returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user1_token").Return(nil, appErr)

		_, err := kv.GetGoogleUserToken("user1")
		assert.Error(t, err)
	})

	t.Run("delete removes the per-user key", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user1_token", []byte(nil), noExpiry()).Return(true, nil)

		require.NoError(t, kv.DeleteGoogleUserToken("user1"))
	})

	t.Run("delete returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user1_token", []byte(nil), noExpiry()).Return(false, appErr)

		assert.Error(t, kv.DeleteGoogleUserToken("user1"))
	})
}

func TestOAuthStateToken(t *testing.T) {
	const state = "abcdefghijklmno_user1"

	t.Run("store saves the state under its own value", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", state, []byte(state), noExpiry()).Return(true, nil)

		require.NoError(t, kv.StoreOAuthStateToken(state, state))
	})

	t.Run("store returns an error when the value is not saved", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", state, []byte(state), noExpiry()).Return(false, nil)

		assert.Error(t, kv.StoreOAuthStateToken(state, state))
	})

	t.Run("get returns the stored state", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", state).Return([]byte(state), nil)

		stored, err := kv.GetOAuthStateToken(state)
		require.NoError(t, err)
		assert.Equal(t, []byte(state), stored)
	})

	t.Run("get returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", state).Return(nil, appErr)

		_, err := kv.GetOAuthStateToken(state)
		assert.Error(t, err)
	})

	t.Run("delete removes the state", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", state, []byte(nil), noExpiry()).Return(true, nil)

		require.NoError(t, kv.DeleteOAuthStateToken(state))
	})

	t.Run("delete returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", state, []byte(nil), noExpiry()).Return(false, appErr)

		assert.Error(t, kv.DeleteOAuthStateToken(state))
	})
}

func TestWatchChannelData(t *testing.T) {
	data := model.WatchChannelData{
		ChannelID:  "channel1",
		ResourceID: "resource1",
		MMUserID:   "user1",
		Expiration: 1234,
		Token:      "token1",
		PageToken:  "page1",
	}
	encoded, err := json.Marshal(data)
	require.NoError(t, err)

	t.Run("store saves JSON under a per-user key", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "drive_change_channels-user1", encoded, noExpiry()).Return(true, nil)

		require.NoError(t, kv.StoreWatchChannelData("user1", data))
	})

	t.Run("store returns an error when the value is not saved", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "drive_change_channels-user1", encoded, noExpiry()).Return(false, nil)

		assert.Error(t, kv.StoreWatchChannelData("user1", data))
	})

	t.Run("get decodes the stored data", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "drive_change_channels-user1").Return(encoded, nil)

		stored, err := kv.GetWatchChannelData("user1")
		require.NoError(t, err)
		assert.Equal(t, &data, stored)
	})

	t.Run("get returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "drive_change_channels-user1").Return(nil, appErr)

		_, err := kv.GetWatchChannelData("user1")
		assert.Error(t, err)
	})

	t.Run("get returns an error when the stored data is corrupt", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "drive_change_channels-user1").Return([]byte("{not json"), nil)

		_, err := kv.GetWatchChannelData("user1")
		assert.Error(t, err)
	})

	t.Run("get using key decodes the stored data", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "drive_change_channels-user1").Return(encoded, nil)

		stored, err := kv.GetWatchChannelDataUsingKey("drive_change_channels-user1")
		require.NoError(t, err)
		assert.Equal(t, &data, stored)
	})

	t.Run("get using key returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "some-key").Return(nil, appErr)

		_, err := kv.GetWatchChannelDataUsingKey("some-key")
		assert.Error(t, err)
	})

	t.Run("list keys only returns watch channel keys", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVList", 0, 100).Return([]string{
			"drive_change_channels-user1",
			"user1_token",
			"drive_change_channels-user2",
			"last_activity-user1-file1",
		}, nil)

		keys, err := kv.ListWatchChannelDataKeys(0, 100)
		require.NoError(t, err)
		assert.Equal(t, []string{"drive_change_channels-user1", "drive_change_channels-user2"}, keys)
	})

	t.Run("list keys returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVList", 0, 100).Return(nil, appErr)

		_, err := kv.ListWatchChannelDataKeys(0, 100)
		assert.Error(t, err)
	})

	t.Run("delete removes the per-user key", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "drive_change_channels-user1", []byte(nil), noExpiry()).Return(true, nil)

		require.NoError(t, kv.DeleteWatchChannelData("user1"))
	})

	t.Run("delete returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "drive_change_channels-user1", []byte(nil), noExpiry()).Return(false, appErr)

		assert.Error(t, kv.DeleteWatchChannelData("user1"))
	})
}

func TestLastActivityForFile(t *testing.T) {
	const activityTime = "2021-01-01T00:00:00.000Z"
	encoded, err := json.Marshal(activityTime)
	require.NoError(t, err)

	t.Run("store saves the time under a per-user, per-file key", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "last_activity-user1-file1", encoded, noExpiry()).Return(true, nil)

		require.NoError(t, kv.StoreLastActivityForFile("user1", "file1", activityTime))
	})

	t.Run("store returns an error when the value is not saved", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "last_activity-user1-file1", encoded, noExpiry()).Return(false, nil)

		assert.Error(t, kv.StoreLastActivityForFile("user1", "file1", activityTime))
	})

	t.Run("store wraps a database error", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "last_activity-user1-file1", encoded, noExpiry()).Return(false, appErr)

		err := kv.StoreLastActivityForFile("user1", "file1", activityTime)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "database error")
	})

	t.Run("get returns the stored time", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "last_activity-user1-file1").Return(encoded, nil)

		stored, err := kv.GetLastActivityForFile("user1", "file1")
		require.NoError(t, err)
		assert.Equal(t, activityTime, stored)
	})

	t.Run("get returns an empty string when nothing is stored", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "last_activity-user1-file1").Return(nil, nil)

		stored, err := kv.GetLastActivityForFile("user1", "file1")
		require.NoError(t, err)
		assert.Empty(t, stored)
	})

	t.Run("get returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "last_activity-user1-file1").Return(nil, appErr)

		_, err := kv.GetLastActivityForFile("user1", "file1")
		assert.Error(t, err)
	})
}

func TestRateLimitExceeded(t *testing.T) {
	t.Run("user rate limit is stored with a ten second expiry", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user-rate_limited-drive-user1", []byte("true"), tenSecondExpiry()).Return(true, nil)

		require.NoError(t, kv.StoreUserRateLimitExceeded("drive", "user1"))
	})

	t.Run("user rate limit store returns an error when the value is not saved", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user-rate_limited-drive-user1", []byte("true"), tenSecondExpiry()).Return(false, nil)

		assert.Error(t, kv.StoreUserRateLimitExceeded("drive", "user1"))
	})

	t.Run("user rate limit is reported when set", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user-rate_limited-drive-user1").Return([]byte("true"), nil)

		exceeded, err := kv.GetUserRateLimitExceeded("drive", "user1")
		require.NoError(t, err)
		assert.True(t, exceeded)
	})

	t.Run("user rate limit is not reported once expired", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user-rate_limited-drive-user1").Return(nil, nil)

		exceeded, err := kv.GetUserRateLimitExceeded("drive", "user1")
		require.NoError(t, err)
		assert.False(t, exceeded)
	})

	t.Run("user rate limit get returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user-rate_limited-drive-user1").Return(nil, appErr)

		_, err := kv.GetUserRateLimitExceeded("drive", "user1")
		assert.Error(t, err)
	})

	t.Run("project rate limit is stored with a ten second expiry", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user-rate_limited-drive", []byte("true"), tenSecondExpiry()).Return(true, nil)

		require.NoError(t, kv.StoreProjectRateLimitExceeded("drive"))
	})

	t.Run("project rate limit store wraps a database error", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVSetWithOptions", "user-rate_limited-drive", []byte("true"), tenSecondExpiry()).Return(false, appErr)

		err := kv.StoreProjectRateLimitExceeded("drive")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "database error")
	})

	t.Run("project rate limit is reported when set", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user-rate_limited-drive").Return([]byte("true"), nil)

		exceeded, err := kv.GetProjectRateLimitExceeded("drive")
		require.NoError(t, err)
		assert.True(t, exceeded)
	})

	t.Run("project rate limit get returns an error on failure", func(t *testing.T) {
		kv, api := setupKVStore(t)
		api.On("KVGet", "user-rate_limited-drive").Return(nil, appErr)

		_, err := kv.GetProjectRateLimitExceeded("drive")
		assert.Error(t, err)
	})
}
