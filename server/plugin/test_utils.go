package plugin

import (
	"fmt"
	"testing"

	"github.com/golang/mock/gomock"
	mattermostModel "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/mattermost/mattermost/server/public/pluginapi"

	"google.golang.org/api/docs/v1"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/driveactivity/v2"
	"google.golang.org/api/sheets/v4"
	"google.golang.org/api/slides/v1"

	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/config"
	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/model"
	"github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/utils"

	mock_pluginapi "github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/pluginapi/mocks"

	mock_google "github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/google/mocks"

	mock_store "github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/kvstore/mocks"

	mock_oauth2 "github.com/mattermost-community/mattermost-plugin-google-drive/server/plugin/oauth2/mocks"
)

type TestEnvironment struct {
	plugin  *Plugin
	mockAPI *plugintest.API
}

type MockSetup struct {
	MockKVStore       *mock_store.MockKVStore
	MockGoogleClient  *mock_google.MockClientInterface
	MockGoogleDrive   *mock_google.MockDriveInterface
	MockDriveActivity *mock_google.MockDriveActivityInterface
	MockGoogleDocs    *mock_google.MockDocsInterface
	MockGoogleSheets  *mock_google.MockSheetsInterface
	MockGoogleSlides  *mock_google.MockSlidesInterface
	MockClusterMutex  *mock_pluginapi.MockClusterMutex
	MockCluster       *mock_pluginapi.MockCluster
	MockOAuth2        *mock_oauth2.MockConfig
}

func SetupTestEnvironment(t *testing.T) *TestEnvironment {
	p := Plugin{
		BotUserID:   "bot_user_id",
		oauthBroker: NewOAuthBroker(func(event OAuthCompleteEvent) {}),
	}

	e := &TestEnvironment{
		plugin: &p,
	}
	e.ResetMocks(t)

	return e
}

func (e *TestEnvironment) Cleanup(t *testing.T) {
	t.Helper()
	e.mockAPI.AssertExpectations(t)
}

func (e *TestEnvironment) ResetMocks(t *testing.T) {
	e.mockAPI = &plugintest.API{}
	e.plugin.SetAPI(e.mockAPI)
	e.plugin.Client = pluginapi.NewClient(e.mockAPI, e.plugin.Driver)
	e.plugin.configuration = &config.Configuration{
		QueriesPerMinute:        60,
		BurstSize:               10,
		GoogleOAuthClientID:     "randomstring.apps.googleusercontent.com",
		GoogleOAuthClientSecret: "googleoauthclientsecret",
		EncryptionKey:           "encryptionkey123",
	}
}

func GetMockSetup(t *testing.T) *MockSetup {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	return newMockSetup(ctrl)
}

// GetVerifiedMockSetup keeps the controller live so expectations are checked when the test ends.
func GetVerifiedMockSetup(t *testing.T) *MockSetup {
	return newMockSetup(gomock.NewController(t))
}

func newMockSetup(ctrl *gomock.Controller) *MockSetup {
	return &MockSetup{
		MockKVStore:       mock_store.NewMockKVStore(ctrl),
		MockGoogleClient:  mock_google.NewMockClientInterface(ctrl),
		MockGoogleDrive:   mock_google.NewMockDriveInterface(ctrl),
		MockDriveActivity: mock_google.NewMockDriveActivityInterface(ctrl),
		MockGoogleDocs:    mock_google.NewMockDocsInterface(ctrl),
		MockGoogleSheets:  mock_google.NewMockSheetsInterface(ctrl),
		MockGoogleSlides:  mock_google.NewMockSlidesInterface(ctrl),
		MockClusterMutex:  mock_pluginapi.NewMockClusterMutex(ctrl),
		MockCluster:       mock_pluginapi.NewMockCluster(ctrl),
		MockOAuth2:        mock_oauth2.NewMockConfig(ctrl),
	}
}

func GetSampleChangeList() *drive.ChangeList {
	return &drive.ChangeList{
		Changes: []*drive.Change{
			{
				FileId:  "fileId1",
				Kind:    "drive#change",
				File:    GetSampleFile("fileId1"),
				DriveId: "driveId1",
				Removed: false,
				Time:    "2021-01-01T00:00:00.000Z",
			},
		},
		NewStartPageToken: "newPageToken2",
		NextPageToken:     "",
	}
}

func GetSampleDriveactivityCommentResponse() *driveactivity.QueryDriveActivityResponse {
	return &driveactivity.QueryDriveActivityResponse{
		Activities: []*driveactivity.DriveActivity{
			{
				PrimaryActionDetail: &driveactivity.ActionDetail{
					Comment: &driveactivity.Comment{
						Post: &driveactivity.Post{
							Subtype: "ADDED",
						},
					},
				},
				Actors: []*driveactivity.Actor{
					{
						User: &driveactivity.User{
							KnownUser: &driveactivity.KnownUser{
								IsCurrentUser: false,
							},
						},
					},
				},
				Targets: []*driveactivity.Target{
					{
						FileComment: &driveactivity.FileComment{
							LegacyCommentId:    "commentId1",
							LegacyDiscussionId: "commentId1",
						},
					},
				},
				Timestamp: "2021-01-02T00:00:00.000Z",
			},
		},
		NextPageToken: "",
	}
}

func GetSampleDriveactivityPermissionResponse() *driveactivity.QueryDriveActivityResponse {
	return &driveactivity.QueryDriveActivityResponse{
		Activities: []*driveactivity.DriveActivity{
			{
				PrimaryActionDetail: &driveactivity.ActionDetail{
					PermissionChange: &driveactivity.PermissionChange{},
				},
				Actors: []*driveactivity.Actor{
					{
						User: &driveactivity.User{
							KnownUser: &driveactivity.KnownUser{
								IsCurrentUser: false,
							},
						},
					},
				},
				Targets:   []*driveactivity.Target{},
				Timestamp: "2021-01-02T00:00:00.000Z",
			},
		},
		NextPageToken: "",
	}
}

func GetSampleComment(commentID string) *drive.Comment {
	return &drive.Comment{
		Content: "comment1",
		Id:      commentID,
		Author: &drive.User{
			DisplayName: "author1",
		},
	}
}

func GetSampleWatchChannelData() *model.WatchChannelData {
	return &model.WatchChannelData{
		ChannelID:  "channelId1",
		ResourceID: "resourceId1",
		MMUserID:   "userId1",
		Expiration: 0,
		Token:      "token1",
		PageToken:  "pageToken1",
	}
}

func GetSampleDoc() *docs.Document {
	return &docs.Document{
		Title:      "doc1",
		DocumentId: "docId1",
	}
}

func GetSampleSheet() *sheets.Spreadsheet {
	return &sheets.Spreadsheet{
		Properties: &sheets.SpreadsheetProperties{
			Title: "sheet1",
		},
		SpreadsheetId: "sheetId1",
	}
}

func GetSamplePresentation() *slides.Presentation {
	return &slides.Presentation{
		Title:          "presentation1",
		PresentationId: "presentationId1",
	}
}

func GetSampleFile(fileID string) *drive.File {
	return &drive.File{
		Id:             fileID,
		ViewedByMeTime: "2020-01-01T00:00:00.000Z",
		ModifiedTime:   "2021-01-01T00:00:00.000Z",
		CreatedTime:    "2021-01-01T00:00:00.000Z",
		SharingUser:    &drive.User{},
		WebViewLink:    "https://drive.google.com/file/d/fileId1/view",
		Name:           "file1",
		IconLink:       "https://drive.google.com/file/d/fileId1/view/icon",
		Owners: []*drive.User{
			{
				DisplayName: "owner1",
				PhotoLink:   "https://drive.google.com/file/d/fileId1/view/photo",
			},
		},
	}
}

func GetDMPost(botID string, comment *drive.Comment, file *drive.File, siteURL string) *mattermostModel.Post {
	return &mattermostModel.Post{
		UserId:    botID,
		ChannelId: "channelId1",
		Message:   "",
		Props: mattermostModel.StringInterface{
			"attachments": []any{
				map[string]any{
					"pretext": fmt.Sprintf("%s commented on %s %s", comment.Author.DisplayName, utils.GetInlineImage("File icon:", file.IconLink), utils.GetHyperlink(file.Name, file.WebViewLink)),
					"text":    fmt.Sprintf("%s\n> %s", "", utils.MarkdownToHTMLEntities(comment.Content)),
					"actions": []any{
						map[string]any{
							"name": "Reply to comment",
							"integration": map[string]any{
								"url": fmt.Sprintf("%s/plugins/%s/api/v1/reply_dialog", siteURL, Manifest.Id),
								"context": map[string]any{
									"commentID": comment.Id,
									"fileID":    file.Id,
								},
							},
						},
					},
				},
			},
		},
	}
}
