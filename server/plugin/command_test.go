package plugin

import (
	"errors"
	"fmt"
	"testing"

	mattermostModel "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/config"
)

func TestParseCommand(t *testing.T) {
	for name, test := range map[string]struct {
		input              string
		expectedCommand    string
		expectedAction     string
		expectedParameters []string
	}{
		"command only": {
			input:           "/google-drive",
			expectedCommand: "/google-drive",
		},
		"command and action": {
			input:           "/google-drive connect",
			expectedCommand: "/google-drive",
			expectedAction:  "connect",
		},
		"command, action and parameters": {
			input:              "/google-drive create doc",
			expectedCommand:    "/google-drive",
			expectedAction:     "create",
			expectedParameters: []string{"doc"},
		},
		"repeated whitespace is ignored": {
			input:              "  /google-drive   notifications \t start  ",
			expectedCommand:    "/google-drive",
			expectedAction:     "notifications",
			expectedParameters: []string{"start"},
		},
		"whitespace inside quotes is kept": {
			input:              `/google-drive create "my   file" doc`,
			expectedCommand:    "/google-drive",
			expectedAction:     "create",
			expectedParameters: []string{`"my   file"`, "doc"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			command, action, parameters := parseCommand(test.input)
			assert.Equal(t, test.expectedCommand, command)
			assert.Equal(t, test.expectedAction, action)
			assert.Equal(t, test.expectedParameters, parameters)
		})
	}
}

func TestExecuteCommand(t *testing.T) {
	args := &mattermostModel.CommandArgs{
		UserId:    "userId1",
		ChannelId: "channelId1",
		RootId:    "rootId1",
	}

	ephemeralPost := func(te *TestEnvironment, message string) *mattermostModel.Post {
		return &mattermostModel.Post{
			UserId:    te.plugin.BotUserID,
			ChannelId: args.ChannelId,
			RootId:    args.RootId,
			Message:   message,
		}
	}

	t.Run("ignores other slash commands", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		te.plugin.CommandHandlers = map[string]CommandHandleFunc{
			"help": func(*plugin.Context, *mattermostModel.CommandArgs, []string) string {
				require.Fail(t, "handler should not be called")
				return ""
			},
		}

		cmdArgs := *args
		cmdArgs.Command = "/other help"
		resp, appErr := te.plugin.ExecuteCommand(&plugin.Context{}, &cmdArgs)

		require.Nil(t, appErr)
		assert.Equal(t, &mattermostModel.CommandResponse{}, resp)
	})

	t.Run("dispatches the action with its parameters and posts the reply", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)

		var receivedParameters []string
		te.plugin.CommandHandlers = map[string]CommandHandleFunc{
			"create": func(_ *plugin.Context, _ *mattermostModel.CommandArgs, parameters []string) string {
				receivedParameters = parameters
				return "handler reply"
			},
		}
		te.mockAPI.On("SendEphemeralPost", args.UserId, ephemeralPost(te, "handler reply")).Return(&mattermostModel.Post{}).Once()

		cmdArgs := *args
		cmdArgs.Command = "/google-drive create doc"
		resp, appErr := te.plugin.ExecuteCommand(&plugin.Context{}, &cmdArgs)

		require.Nil(t, appErr)
		assert.Equal(t, &mattermostModel.CommandResponse{}, resp)
		assert.Equal(t, []string{"doc"}, receivedParameters)
	})

	t.Run("does not post when the handler returns no message", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		te.plugin.CommandHandlers = map[string]CommandHandleFunc{
			"setup": func(*plugin.Context, *mattermostModel.CommandArgs, []string) string { return "" },
		}

		cmdArgs := *args
		cmdArgs.Command = "/google-drive setup"
		_, appErr := te.plugin.ExecuteCommand(&plugin.Context{}, &cmdArgs)

		require.Nil(t, appErr)
	})

	t.Run("reports an unknown action", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		te.plugin.CommandHandlers = map[string]CommandHandleFunc{}
		te.mockAPI.On("SendEphemeralPost", args.UserId, ephemeralPost(te, "bogus is not a valid command. "+commandDescription)).Return(&mattermostModel.Post{}).Once()

		cmdArgs := *args
		cmdArgs.Command = "/google-drive bogus"
		_, appErr := te.plugin.ExecuteCommand(&plugin.Context{}, &cmdArgs)

		require.Nil(t, appErr)
	})
}

func TestHandleConnect(t *testing.T) {
	args := &mattermostModel.CommandArgs{UserId: "userId1"}

	t.Run("returns the OAuth connect link", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		siteURL := "http://localhost:8065"
		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return(nil, nil)
		te.mockAPI.On("GetConfig").Return(&mattermostModel.Config{ServiceSettings: mattermostModel.ServiceSettings{SiteURL: &siteURL}})

		message := te.plugin.handleConnect(&plugin.Context{}, args, nil)

		assert.Equal(t, fmt.Sprintf("[Click here to link your Google account.](http://localhost:8065/plugins/%s/oauth/connect)", Manifest.Id), message)
	})

	t.Run("refuses to connect an already connected account", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return([]byte("encrypted"), nil)

		message := te.plugin.handleConnect(&plugin.Context{}, args, nil)

		assert.Contains(t, message, "You have already connected your Google account")
	})

	t.Run("reports a KV store error", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return(nil, errors.New("kv failure"))

		message := te.plugin.handleConnect(&plugin.Context{}, args, nil)

		assert.Equal(t, "Encountered an error connecting to Google Drive.", message)
	})

	t.Run("reports a missing site URL", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return(nil, nil)
		te.mockAPI.On("GetConfig").Return(&mattermostModel.Config{})

		message := te.plugin.handleConnect(&plugin.Context{}, args, nil)

		assert.Equal(t, "Encountered an error connecting to Google Drive.", message)
	})
}

func TestHandleDisconnect(t *testing.T) {
	args := &mattermostModel.CommandArgs{UserId: "userId1"}

	t.Run("deletes the stored token", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return([]byte("encrypted"), nil)
		mocks.MockKVStore.EXPECT().DeleteGoogleUserToken("userId1").Return(nil)

		message := te.plugin.handleDisconnect(&plugin.Context{}, args, nil)

		assert.Equal(t, "Disconnected your Google account.", message)
	})

	t.Run("reports when no account is connected", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return(nil, nil)

		message := te.plugin.handleDisconnect(&plugin.Context{}, args, nil)

		assert.Equal(t, "There is no Google account connected to your Mattermost account.", message)
	})

	t.Run("reports an error reading the token", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return(nil, errors.New("kv failure"))
		te.mockAPI.On("LogError", "Failed to disconnect google account", "error", mock.Anything).Once()

		message := te.plugin.handleDisconnect(&plugin.Context{}, args, nil)

		assert.Equal(t, "Encountered an error disconnecting Google account.", message)
	})

	t.Run("reports an error deleting the token", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)
		mocks := GetMockSetup(t)
		te.plugin.KVStore = mocks.MockKVStore

		mocks.MockKVStore.EXPECT().GetGoogleUserToken("userId1").Return([]byte("encrypted"), nil)
		mocks.MockKVStore.EXPECT().DeleteGoogleUserToken("userId1").Return(errors.New("kv failure"))
		te.mockAPI.On("LogError", "Failed to disconnect Google account", "error", mock.Anything).Once()

		message := te.plugin.handleDisconnect(&plugin.Context{}, args, nil)

		assert.Equal(t, "Encountered an error disconnecting Google account.", message)
	})
}

func TestHandleSetupRequiresSystemAdmin(t *testing.T) {
	args := &mattermostModel.CommandArgs{UserId: "userId1"}

	for name, roles := range map[string]string{
		"regular user":          mattermostModel.SystemUserRoleId,
		"user with custom role": "system_user custom_role",
		"system user manager":   "system_user system_user_manager",
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			te := SetupTestEnvironment(t)
			defer te.Cleanup(t)

			te.mockAPI.On("GetUser", "userId1").Return(&mattermostModel.User{Id: "userId1", Roles: roles}, nil)

			message := te.plugin.handleSetup(&plugin.Context{}, args, nil)

			assert.Equal(t, "Only System Admins are allowed to set up the plugin.", message)
		})
	}

	t.Run("reports an error looking up the user", func(t *testing.T) {
		te := SetupTestEnvironment(t)
		defer te.Cleanup(t)

		te.mockAPI.On("GetUser", "userId1").Return(nil, &mattermostModel.AppError{Message: "not found"})
		te.mockAPI.On("LogWarn", "Failed to check if user is System Admin", "error", mock.Anything).Once()

		message := te.plugin.handleSetup(&plugin.Context{}, args, nil)

		assert.Equal(t, "Error checking user's permissions", message)
	})
}

func TestHandleHelp(t *testing.T) {
	te := SetupTestEnvironment(t)
	defer te.Cleanup(t)

	message := te.plugin.handleHelp(&plugin.Context{}, &mattermostModel.CommandArgs{}, nil)

	assert.Contains(t, message, "Slash Command Help")
	for _, action := range []string{"connect", "disconnect", "create", "notifications start", "notifications stop", "help", "about"} {
		assert.Contains(t, message, "`/google-drive "+action)
	}
	assert.NotContains(t, message, "|")
}

func TestGetAutocompleteData(t *testing.T) {
	subCommands := func(data *mattermostModel.AutocompleteData) map[string]*mattermostModel.AutocompleteData {
		out := map[string]*mattermostModel.AutocompleteData{}
		for _, sub := range data.SubCommands {
			out[sub.Trigger] = sub
		}
		return out
	}

	t.Run("only offers setup and about before OAuth is configured", func(t *testing.T) {
		data := getAutocompleteData(&config.Configuration{})

		subs := subCommands(data)
		assert.ElementsMatch(t, []string{"setup", "about"}, keys(subs))
		assert.Equal(t, mattermostModel.SystemAdminRoleId, subs["setup"].RoleID)
	})

	t.Run("offers all commands once OAuth is configured", func(t *testing.T) {
		data := getAutocompleteData(&config.Configuration{GoogleOAuthClientID: "id", GoogleOAuthClientSecret: "secret"})

		subs := subCommands(data)
		assert.ElementsMatch(t, []string{"connect", "disconnect", "create", "notifications", "help", "about", "setup"}, keys(subs))
		assert.Equal(t, mattermostModel.SystemAdminRoleId, subs["setup"].RoleID)
		assert.ElementsMatch(t, []string{"doc", "slide", "sheet"}, keys(subCommands(subs["create"])))
		assert.ElementsMatch(t, []string{"start", "stop"}, keys(subCommands(subs["notifications"])))
	})
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
