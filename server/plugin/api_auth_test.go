package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	mattermostModel "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
	"google.golang.org/api/drive/v3"

	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/model"
	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/utils"
)

const validEncryptionKey = "0123456789abcdef0123456789abcdef"

// The request logger emits its "userid" and "error" context in map order, so only the message is pinned.
func expectRequestLogWarn(te *TestEnvironment, message string) {
	te.mockAPI.On("LogWarn", message, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Once()
}

func serve(te *TestEnvironment, r *http.Request) *http.Response {
	w := httptest.NewRecorder()
	te.plugin.ServeHTTP(&plugin.Context{}, w, r)
	return w.Result()
}

func TestRoutesRequireAuthentication(t *testing.T) {
	for _, route := range []struct {
		method       string
		path         string
		responseType ResponseType
	}{
		{http.MethodGet, "/oauth/connect", ResponseTypePlain},
		{http.MethodGet, "/oauth/complete?code=code&state=state", ResponseTypePlain},
		{http.MethodPost, "/api/v1/create?type=doc", ResponseTypeJSON},
		{http.MethodPost, "/api/v1/reply_dialog", ResponseTypeJSON},
		{http.MethodPost, "/api/v1/reply?fileID=f&commentID=c", ResponseTypeJSON},
		{http.MethodPost, "/api/v1/upload_file", ResponseTypeJSON},
		{http.MethodPost, "/api/v1/upload_all", ResponseTypeJSON},
	} {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			mocks := GetMockSetup(t)
			te.plugin.KVStore = mocks.MockKVStore
			te.plugin.GoogleClient = mocks.MockGoogleClient
			te.plugin.oauthConfig = mocks.MockOAuth2
			te.plugin.configuration.EncryptionKey = validEncryptionKey
			te.plugin.initializeAPI()
			te.mockAPI.On("LogWarn", "Recovered from a panic", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Maybe()

			result := serve(te, httptest.NewRequest(route.method, route.path, strings.NewReader("{}")))
			defer deferClose(result.Body)

			assert.Equal(t, http.StatusUnauthorized, result.StatusCode)
			body, err := io.ReadAll(result.Body)
			require.NoError(t, err)
			if route.responseType == ResponseTypeJSON {
				var apiErr APIErrorResponse
				require.NoError(t, json.Unmarshal(body, &apiErr))
				assert.Equal(t, APIErrorResponse{Message: "Not authorized.", StatusCode: http.StatusUnauthorized}, apiErr)
			} else {
				assert.Equal(t, "Not authorized\n", string(body))
			}
		})
	}
}

func TestAPIRoutesRequireValidConfiguration(t *testing.T) {
	paths := []string{
		"/api/v1/create?type=doc",
		"/api/v1/webhook",
		"/api/v1/reply_dialog",
		"/api/v1/reply",
		"/api/v1/upload_file",
		"/api/v1/upload_all",
	}

	for _, path := range paths {
		t.Run("rejects "+path+" without a client secret", func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			te.plugin.configuration.EncryptionKey = validEncryptionKey
			te.plugin.configuration.GoogleOAuthClientSecret = ""
			te.plugin.initializeAPI()

			r := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
			r.Header.Set("Mattermost-User-ID", "userId1")
			result := serve(te, r)
			defer deferClose(result.Body)

			assert.Equal(t, http.StatusNotImplemented, result.StatusCode)
			body, err := io.ReadAll(result.Body)
			require.NoError(t, err)
			assert.Equal(t, "This plugin is not configured.\n", string(body))
		})
	}

	for _, path := range paths {
		t.Run("lets "+path+" through with a valid configuration", func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			te.plugin.configuration.EncryptionKey = validEncryptionKey
			te.plugin.initializeAPI()

			// Without a user ID, authenticated routes stop at checkAuth and the webhook ignores the
			// request; either way the configuration check must have passed.
			r := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
			result := serve(te, r)
			defer deferClose(result.Body)

			assert.NotEqual(t, http.StatusNotImplemented, result.StatusCode)
		})
	}
}

func TestUnknownRouteReturnsNotFound(t *testing.T) {
	te := SetupTestEnvironment(t)
	defer te.Cleanup(t)
	te.plugin.initializeAPI()

	r := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	r.Header.Set("Mattermost-User-ID", "userId1")
	result := serve(te, r)
	defer deferClose(result.Body)

	assert.Equal(t, http.StatusNotFound, result.StatusCode)
}

func TestWithRecoveryHandlesPanics(t *testing.T) {
	te := SetupTestEnvironment(t)
	defer te.Cleanup(t)
	te.plugin.initializeAPI()
	te.plugin.router.HandleFunc("/panic", func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})
	te.mockAPI.On("LogWarn", "Recovered from a panic", "url", "/panic", "error", "boom", "stack", mock.AnythingOfType("string")).Once()

	assert.NotPanics(t, func() {
		result := serve(te, httptest.NewRequest(http.MethodGet, "/panic", nil))
		deferClose(result.Body)
	})
}

func TestWebhookIgnoresNonChangeNotifications(t *testing.T) {
	te := SetupTestEnvironment(t)
	defer te.Cleanup(t)
	te.plugin.configuration.EncryptionKey = validEncryptionKey
	te.plugin.initializeAPI()

	r := httptest.NewRequest(http.MethodPost, "/api/v1/webhook?userID=userId1", nil)
	r.Header.Set("X-Goog-Resource-State", "sync")
	result := serve(te, r)
	defer deferClose(result.Body)

	assert.Equal(t, http.StatusOK, result.StatusCode)
}

func TestWebhookRejectsMissingChannelToken(t *testing.T) {
	te := SetupTestEnvironment(t)
	defer te.Cleanup(t)
	mocks := GetMockSetup(t)
	te.plugin.KVStore = mocks.MockKVStore
	te.plugin.GoogleClient = mocks.MockGoogleClient
	te.plugin.configuration.EncryptionKey = validEncryptionKey
	te.plugin.initializeAPI()

	te.mockAPI.On("GetUser", "userId1").Return(&mattermostModel.User{Id: "userId1"}, nil).Once()
	mocks.MockKVStore.EXPECT().GetWatchChannelData("userId1").Return(&model.WatchChannelData{}, nil)
	te.mockAPI.On("LogError", "Invalid channel token", "userID", "userId1").Once()
	te.mockAPI.On("LogWarn", "Recovered from a panic", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Maybe()

	r := httptest.NewRequest(http.MethodPost, "/api/v1/webhook?userID=userId1", nil)
	r.Header.Set("X-Goog-Resource-State", "change")
	result := serve(te, r)
	defer deferClose(result.Body)

	assert.Equal(t, http.StatusBadRequest, result.StatusCode)
}

func TestConnectUserToGoogle(t *testing.T) {
	userID := mattermostModel.NewId()

	t.Run("stores a user-bound state and redirects to Google", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore
		te.plugin.oauthConfig = mocks.MockOAuth2

		var storedState string
		mocks.MockKVStore.EXPECT().StoreOAuthStateToken(gomock.Any(), gomock.Any()).DoAndReturn(func(key, value string) error {
			storedState = key
			assert.Equal(t, key, value)
			return nil
		})
		mocks.MockOAuth2.EXPECT().AuthCodeURL(gomock.Any()).DoAndReturn(func(state string) string {
			return "https://accounts.google.com/o/oauth2/auth?state=" + url.QueryEscape(state)
		})

		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/oauth/connect", nil)
		r.Header.Set("Mattermost-User-ID", userID)
		ctx, cancel := te.plugin.createContext(w, r)
		defer cancel()

		te.plugin.connectUserToGoogle(ctx, w, r)
		// Let the background goroutine waiting on the OAuth flow exit without DMing the user.
		te.plugin.oauthBroker.publishOAuthComplete(userID, nil, true)

		result := w.Result()
		defer deferClose(result.Body)
		assert.Equal(t, http.StatusFound, result.StatusCode)
		assert.Regexp(t, regexp.MustCompile("^[a-z0-9]{15}_"+userID+"$"), storedState)
		assert.Equal(t, "https://accounts.google.com/o/oauth2/auth?state="+url.QueryEscape(storedState), result.Header.Get("Location"))
	})

	t.Run("generates a different state for every attempt", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore
		te.plugin.oauthConfig = mocks.MockOAuth2

		var states []string
		mocks.MockKVStore.EXPECT().StoreOAuthStateToken(gomock.Any(), gomock.Any()).DoAndReturn(func(key, _ string) error {
			states = append(states, key)
			return nil
		}).Times(2)
		mocks.MockOAuth2.EXPECT().AuthCodeURL(gomock.Any()).Return("https://accounts.google.com").Times(2)

		for range 2 {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/oauth/connect", nil)
			r.Header.Set("Mattermost-User-ID", userID)
			ctx, cancel := te.plugin.createContext(w, r)
			te.plugin.connectUserToGoogle(ctx, w, r)
			cancel()
		}
		te.plugin.oauthBroker.publishOAuthComplete(userID, nil, true)

		require.Len(t, states, 2)
		assert.NotEqual(t, states[0], states[1])
	})

	t.Run("fails when the state cannot be stored", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore
		te.plugin.oauthConfig = mocks.MockOAuth2

		mocks.MockKVStore.EXPECT().StoreOAuthStateToken(gomock.Any(), gomock.Any()).Return(errors.New("kv failure"))
		expectRequestLogWarn(te, "Can't store state oauth2")

		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/oauth/connect", nil)
		r.Header.Set("Mattermost-User-ID", userID)
		ctx, cancel := te.plugin.createContext(w, r)
		defer cancel()

		te.plugin.connectUserToGoogle(ctx, w, r)

		result := w.Result()
		defer deferClose(result.Body)
		assert.Equal(t, http.StatusInternalServerError, result.StatusCode)
	})
}

func TestCompleteConnectUserToGoogleValidation(t *testing.T) {
	userID := mattermostModel.NewId()
	validState := "abcdefghijklmno_" + userID

	for name, test := range map[string]struct {
		code               string
		state              string
		expectedStatusCode int
		expectedBody       string
	}{
		"empty code": {
			code:               "",
			state:              validState,
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid authorization code",
		},
		"code of exactly 100 characters is accepted": {
			code:               strings.Repeat("c", 100),
			state:              "short_" + userID,
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid state",
		},
		"code longer than 100 characters": {
			code:               strings.Repeat("c", 101),
			state:              validState,
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid authorization code",
		},
		"state without a user id separator": {
			code:               "code",
			state:              "abcdefghijklmno" + userID,
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid state",
		},
		"state with too many separators": {
			code:               "code",
			state:              "abc_def_" + userID,
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid state",
		},
		"state with an invalid user id": {
			code:               "code",
			state:              "abcdefghijklmno_not-a-valid-id",
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid user id",
		},
		"state with a random part of the wrong length": {
			code:               "code",
			state:              "short_" + userID,
			expectedStatusCode: http.StatusBadRequest,
			expectedBody:       "invalid state",
		},
	} {
		t.Run(name, func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			mocks := GetMockSetup(t)
			te.plugin.KVStore = mocks.MockKVStore
			te.plugin.oauthConfig = mocks.MockOAuth2

			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/oauth/complete?"+url.Values{"code": {test.code}, "state": {test.state}}.Encode(), nil)
			r.Header.Set("Mattermost-User-ID", userID)
			ctx, cancel := te.plugin.createContext(w, r)
			defer cancel()

			te.plugin.completeConnectUserToGoogle(ctx, w, r)

			result := w.Result()
			defer deferClose(result.Body)
			assert.Equal(t, test.expectedStatusCode, result.StatusCode)
			body, err := io.ReadAll(result.Body)
			require.NoError(t, err)
			assert.Equal(t, test.expectedBody+"\n", string(body))
		})
	}
}

func TestCompleteConnectUserToGoogleStoresEncryptedToken(t *testing.T) {
	userID := mattermostModel.NewId()
	state := "abcdefghijklmno_" + userID
	token := &oauth2.Token{
		AccessToken:  "access-token-value",
		RefreshToken: "refresh-token-value",
		TokenType:    "Bearer",
		Expiry:       time.Now().Add(time.Hour).UTC().Round(time.Second),
	}

	te := SetupTestEnvironment(t)
	defer te.Cleanup(t)
	mocks := GetMockSetup(t)
	te.plugin.KVStore = mocks.MockKVStore
	te.plugin.oauthConfig = mocks.MockOAuth2

	var storedToken []byte
	mocks.MockKVStore.EXPECT().GetOAuthStateToken(state).Return([]byte(state), nil)
	mocks.MockKVStore.EXPECT().DeleteOAuthStateToken(state).Return(nil)
	mocks.MockOAuth2.EXPECT().Exchange(gomock.Any(), "oauthcode").Return(token, nil)
	mocks.MockKVStore.EXPECT().StoreGoogleUserToken(userID, gomock.Any()).DoAndReturn(func(_ string, encrypted []byte) error {
		storedToken = encrypted
		return nil
	})
	te.mockAPI.On("GetDirectChannel", userID, te.plugin.BotUserID).Return(&mattermostModel.Channel{Id: "channelId1"}, nil).Once()
	te.mockAPI.On("CreatePost", mock.Anything).Return(nil, nil).Once()
	te.mockAPI.On("PublishWebSocketEvent", "google_connect", mock.Anything, mock.Anything).Once()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/oauth/complete?"+url.Values{"code": {"oauthcode"}, "state": {state}}.Encode(), nil)
	r.Header.Set("Mattermost-User-ID", userID)
	ctx, cancel := te.plugin.createContext(w, r)
	defer cancel()

	te.plugin.completeConnectUserToGoogle(ctx, w, r)

	result := w.Result()
	defer deferClose(result.Body)
	require.Equal(t, http.StatusOK, result.StatusCode)

	require.NotEmpty(t, storedToken)
	assert.NotContains(t, string(storedToken), token.AccessToken)
	assert.NotContains(t, string(storedToken), token.RefreshToken)

	decrypted, err := utils.Decrypt([]byte(te.plugin.configuration.EncryptionKey), storedToken)
	require.NoError(t, err)
	var decoded oauth2.Token
	require.NoError(t, json.Unmarshal(decrypted, &decoded))
	assert.Equal(t, token.AccessToken, decoded.AccessToken)
	assert.Equal(t, token.RefreshToken, decoded.RefreshToken)
	assert.True(t, token.Expiry.Equal(decoded.Expiry))
}

func TestCompleteConnectUserToGoogleFailures(t *testing.T) {
	userID := mattermostModel.NewId()
	state := "abcdefghijklmno_" + userID

	for name, test := range map[string]struct {
		setup              func(te *TestEnvironment, mocks *MockSetup)
		expectedStatusCode int
	}{
		"stored state cannot be read": {
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockKVStore.EXPECT().GetOAuthStateToken(state).Return(nil, errors.New("kv failure"))
				expectRequestLogWarn(te, "Can't get state from store")
			},
			expectedStatusCode: http.StatusBadRequest,
		},
		"stored state does not match": {
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockKVStore.EXPECT().GetOAuthStateToken(state).Return(nil, nil)
				mocks.MockKVStore.EXPECT().DeleteOAuthStateToken(state).Return(nil)
			},
			expectedStatusCode: http.StatusBadRequest,
		},
		"code exchange fails": {
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockKVStore.EXPECT().GetOAuthStateToken(state).Return([]byte(state), nil)
				mocks.MockKVStore.EXPECT().DeleteOAuthStateToken(state).Return(nil)
				mocks.MockOAuth2.EXPECT().Exchange(gomock.Any(), "oauthcode").Return(nil, errors.New("exchange failure"))
				expectRequestLogWarn(te, "Can't exchange state")
			},
			expectedStatusCode: http.StatusInternalServerError,
		},
		"token cannot be stored": {
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockKVStore.EXPECT().GetOAuthStateToken(state).Return([]byte(state), nil)
				mocks.MockKVStore.EXPECT().DeleteOAuthStateToken(state).Return(nil)
				mocks.MockOAuth2.EXPECT().Exchange(gomock.Any(), "oauthcode").Return(&oauth2.Token{AccessToken: "access"}, nil)
				mocks.MockKVStore.EXPECT().StoreGoogleUserToken(userID, gomock.Any()).Return(errors.New("kv failure"))
				expectRequestLogWarn(te, "Can't store user token")
			},
			expectedStatusCode: http.StatusInternalServerError,
		},
	} {
		t.Run(name, func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			mocks := GetMockSetup(t)
			te.plugin.KVStore = mocks.MockKVStore
			te.plugin.oauthConfig = mocks.MockOAuth2
			test.setup(te, mocks)

			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/oauth/complete?"+url.Values{"code": {"oauthcode"}, "state": {state}}.Encode(), nil)
			r.Header.Set("Mattermost-User-ID", userID)
			ctx, cancel := te.plugin.createContext(w, r)
			defer cancel()

			te.plugin.completeConnectUserToGoogle(ctx, w, r)

			result := w.Result()
			defer deferClose(result.Body)
			assert.Equal(t, test.expectedStatusCode, result.StatusCode)
		})
	}
}

func TestOpenCommentReplyDialog(t *testing.T) {
	siteURL := "http://localhost:8065"

	for name, test := range map[string]struct {
		context            map[string]any
		setup              func(te *TestEnvironment)
		expectedStatusCode int
	}{
		"opens a dialog that posts back to the reply endpoint": {
			context: map[string]any{"commentID": "comment&1", "fileID": "file?1"},
			setup: func(te *TestEnvironment) {
				te.mockAPI.On("GetConfig").Return(&mattermostModel.Config{ServiceSettings: mattermostModel.ServiceSettings{SiteURL: &siteURL}})
				te.mockAPI.On("OpenInteractiveDialog", mock.MatchedBy(func(dialog mattermostModel.OpenDialogRequest) bool {
					return dialog.TriggerId == "trigger1" &&
						dialog.URL == siteURL+"/plugins/"+Manifest.Id+"/api/v1/reply?fileID=file%3F1&commentID=comment%261" &&
						dialog.Dialog.State == "postId1" &&
						len(dialog.Dialog.Elements) == 1 &&
						dialog.Dialog.Elements[0].Name == "message"
				})).Return(nil).Once()
			},
			expectedStatusCode: http.StatusOK,
		},
		"missing comment id": {
			context: map[string]any{"fileID": "file1"},
			setup: func(te *TestEnvironment) {
				te.mockAPI.On("LogError", "Comment ID not found in the request").Once()
			},
			expectedStatusCode: http.StatusBadRequest,
		},
		"missing file id": {
			context: map[string]any{"commentID": "comment1"},
			setup: func(te *TestEnvironment) {
				te.mockAPI.On("LogError", "File ID not found in the request").Once()
			},
			expectedStatusCode: http.StatusBadRequest,
		},
		"dialog cannot be opened": {
			context: map[string]any{"commentID": "comment1", "fileID": "file1"},
			setup: func(te *TestEnvironment) {
				te.mockAPI.On("GetConfig").Return(&mattermostModel.Config{ServiceSettings: mattermostModel.ServiceSettings{SiteURL: &siteURL}})
				te.mockAPI.On("OpenInteractiveDialog", mock.Anything).Return(&mattermostModel.AppError{Message: "failure"}).Once()
				te.mockAPI.On("LogWarn", "Failed to open interactive dialog", "err", mock.Anything).Once()
			},
			expectedStatusCode: http.StatusInternalServerError,
		},
	} {
		t.Run(name, func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			test.setup(te)

			body, err := json.Marshal(mattermostModel.PostActionIntegrationRequest{
				TriggerId: "trigger1",
				PostId:    "postId1",
				Context:   test.context,
			})
			require.NoError(t, err)

			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/api/v1/reply_dialog", bytes.NewReader(body))
			r.Header.Set("Mattermost-User-ID", "userId1")
			ctx, cancel := te.plugin.createContext(w, r)
			defer cancel()

			te.plugin.openCommentReplyDialog(ctx, w, r)

			result := w.Result()
			defer deferClose(result.Body)
			assert.Equal(t, test.expectedStatusCode, result.StatusCode)
		})
	}
}

func TestHandleCommentReplyDialog(t *testing.T) {
	for name, test := range map[string]struct {
		submission         map[string]any
		setup              func(te *TestEnvironment, mocks *MockSetup)
		expectedStatusCode int
	}{
		"replies to the comment as the user and confirms in the thread": {
			submission: map[string]any{"message": "my reply"},
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockGoogleClient.EXPECT().NewDriveService(gomock.Any(), "userId1").Return(mocks.MockGoogleDrive, nil)
				mocks.MockGoogleDrive.EXPECT().CreateReply(gomock.Any(), "file1", "comment1", &drive.Reply{Content: "my reply"}).Return(&drive.Reply{Content: "my reply"}, nil)
				te.mockAPI.On("CreatePost", &mattermostModel.Post{
					Message:   "You replied to this comment with: \n> my reply",
					ChannelId: "channelId1",
					RootId:    "postId1",
					UserId:    te.plugin.BotUserID,
				}).Return(&mattermostModel.Post{}, nil).Once()
			},
			expectedStatusCode: http.StatusOK,
		},
		"missing message": {
			submission: map[string]any{},
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				te.mockAPI.On("LogError", "Message not found in the request").Once()
			},
			expectedStatusCode: http.StatusBadRequest,
		},
		"drive service cannot be created": {
			submission: map[string]any{"message": "my reply"},
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockGoogleClient.EXPECT().NewDriveService(gomock.Any(), "userId1").Return(nil, errors.New("not connected"))
				te.mockAPI.On("LogError", "Failed to create Google Drive service", "err", mock.Anything, "userID", "userId1").Once()
			},
			expectedStatusCode: http.StatusInternalServerError,
		},
		"reply cannot be created": {
			submission: map[string]any{"message": "my reply"},
			setup: func(te *TestEnvironment, mocks *MockSetup) {
				mocks.MockGoogleClient.EXPECT().NewDriveService(gomock.Any(), "userId1").Return(mocks.MockGoogleDrive, nil)
				mocks.MockGoogleDrive.EXPECT().CreateReply(gomock.Any(), "file1", "comment1", gomock.Any()).Return(nil, errors.New("google failure"))
				te.mockAPI.On("LogError", "Failed to create comment reply", "err", mock.Anything).Once()
			},
			expectedStatusCode: http.StatusInternalServerError,
		},
	} {
		t.Run(name, func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)
			mocks := GetMockSetup(t)
			te.plugin.GoogleClient = mocks.MockGoogleClient
			test.setup(te, mocks)

			body, err := json.Marshal(mattermostModel.SubmitDialogRequest{
				ChannelId:  "channelId1",
				State:      "postId1",
				Submission: test.submission,
			})
			require.NoError(t, err)

			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/api/v1/reply?fileID=file1&commentID=comment1", bytes.NewReader(body))
			r.Header.Set("Mattermost-User-ID", "userId1")
			ctx, cancel := te.plugin.createContext(w, r)
			defer cancel()

			te.plugin.handleCommentReplyDialog(ctx, w, r)

			result := w.Result()
			defer deferClose(result.Body)
			assert.Equal(t, test.expectedStatusCode, result.StatusCode)
		})
	}
}
