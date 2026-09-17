import {Store, Action} from 'redux';
import {GlobalState} from 'mattermost-redux/types/store';
import {getPost} from 'mattermost-redux/selectors/entities/posts';
import {makeGetFilesForPost} from 'mattermost-redux/selectors/entities/files';

import manifest from '@/manifest';
import {PluginRegistry} from '@/types/mattermost-webapp';

import {sendEphemeralPost} from './actions';

// Mattermost keys open interactive dialogs by trigger_id and discards any dialog
// without one. Dialogs opened from the web app never round-trip the server, so
// there is no server-minted id available here.
function newTriggerID(): string {
    return `${manifest.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default class Plugin {
    public async initialize(
        registry: PluginRegistry,
        store: Store<GlobalState, Action>,
    ) {
        const getFilesForPost = makeGetFilesForPost();

        registry.registerPostDropdownMenuAction(
            'Upload file to Google Drive',
            (postID: string) => {
                const state = store.getState();
                const fileInfos = getFilesForPost(state, postID);
                if (fileInfos.length === 0) {
                    sendEphemeralPost(
                        'Selected post doesn\'t have any files to be uploaded',
                    )(store.dispatch, store.getState);
                    return;
                }
                const modal = {
                    trigger_id: newTriggerID(),
                    url: `/plugins/${manifest.id}/api/v1/upload_file`,
                    dialog: {
                        callback_id: 'upload_file',
                        title: 'Upload to Google Drive',
                        elements: [
                            {
                                display_name: 'Select the files you\'d like to upload to Google Drive',
                                type: 'select',
                                name: 'fileID',
                                options: fileInfos.map((fileInfo) => ({
                                    text: fileInfo.name,
                                    value: fileInfo.id,
                                })),
                                optional: false,
                            },
                        ],
                        submit_label: 'Submit',
                        notify_on_cancel: true,
                        state: postID,
                    },
                };

                // Open the modal
                window.openInteractiveDialog(modal);
            },
            (postID: string) => {
                const state = store.getState();
                const post = getPost(state, postID);
                if (!post) {
                    return false;
                }
                if (!post.file_ids || post.file_ids.length === 0) {
                    return false;
                }
                return true;
            },
        );

        registry.registerPostDropdownMenuAction(
            'Upload all files to Google Drive',
            (postID: string) => {
                const state = store.getState();
                const post = getPost(state, postID);
                if (post.file_ids && post.file_ids.length === 0) {
                    sendEphemeralPost(
                        'Selected post doesn\'t have any files to be uploaded',
                    )(store.dispatch, store.getState);
                    return;
                }
                const modal = {
                    trigger_id: newTriggerID(),
                    url: `/plugins/${manifest.id}/api/v1/upload_all`,
                    dialog: {
                        callback_id: 'upload_all_files',
                        title: 'Upload all files to Google Drive',
                        introduction_text: 'All files attached to this message will be uploaded to your Google Drive.',
                        elements: [],
                        submit_label: 'Submit',
                        notify_on_cancel: true,
                        state: postID,
                    },
                };

                window.openInteractiveDialog(modal);
            },
            (postID: string) => {
                const state = store.getState();
                const post = getPost(state, postID);
                if (!post) {
                    return false;
                }
                if (!post.file_ids || post.file_ids.length < 2) {
                    return false;
                }
                return true;
            },
        );
    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
        openInteractiveDialog(modal: Record<string, unknown>): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());
