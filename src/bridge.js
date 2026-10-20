// Calls into the Tauri shell (src-tauri/src).
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export const appWindow = getCurrentWebviewWindow();

export const api = {
  init: () => invoke('window_init'),
  readDocument: (path) => invoke('read_document', { path }),
  writeDocument: (content, force = false) => invoke('write_document', { content, force }),
  checkDocument: () => invoke('check_document'),
  saveAs: (content) => invoke('save_as', { content }),
  saveImage: (name, bytes) => invoke('save_image', bytes, { headers: { 'x-file-name': encodeURIComponent(name) } }),
  importImage: (path) => invoke('import_image', { path }),
  allowImage: (path) => invoke('allow_image', { path }),
  imageDataUrl: (path) => invoke('image_data_url', { path }),
  listDir: (path) => invoke('list_dir', { path }),
  listDocuments: (root) => invoke('list_documents', { root }),
  setRoot: (path) => invoke('set_root', { path }),
  createDocument: (dir) => invoke('create_document', { dir }),
  renamePath: (path, name) => invoke('rename_path', { path, name }),
  /** Pins store paths only — the document itself is never copied. */
  listPinned: () => invoke('list_pinned'),
  pinFile: (path) => invoke('pin_file', { path }),
  unpinFile: (path) => invoke('unpin_file', { path }),
  relinkPinned: (from, to) => invoke('relink_pinned', { from, to }),
  draftWrite: (content) => invoke('draft_write', { content }),
  draftDelete: () => invoke('draft_delete'),
  setCloseGuard: (guard) => invoke('set_close_guard', { guard }),
  closeWindow: () => invoke('close_window'),
  cancelQuit: () => invoke('cancel_quit'),
  setTitle: (title) => invoke('set_title', { title }),
  confirmCloseDraft: () => invoke('confirm_close_draft'),
  confirm: (title, message, ok) => invoke('confirm', { title, message, ok }),
  pickDocuments: () => invoke('pick_documents'),
  pickFolder: () => invoke('pick_folder'),
  pickImage: () => invoke('pick_image'),
  openInNewWindow: (path) => invoke('open_in_new_window', { path }),
  newWindow: () => invoke('new_window'),
  nativeAction: (id) => invoke('native_action', { id }),
  openUrl: (url) => invoke('open_url', { url }),
  openFromUrl: (url) => invoke('open_from_url', { url }),
  reveal: (path) => invoke('reveal', { path }),
  print: () => invoke('print_page'),
  exportHtml: (html, name) => invoke('export_html', { html, name }),
  exportDocx: (bytes, name) => invoke('export_docx', bytes, { headers: { 'x-file-name': encodeURIComponent(name) } }),
  rememberPosition: (path, position) => invoke('remember_position', { path, position }),
  setSetting: (key, value) => invoke('set_setting', { key, value }),
  aiAvailable: () => invoke('ai_available'),
  aiLabel: (lines) => invoke('ai_label', { lines }),
  aiStatus: () => invoke('ai_status'),
  /** `apiKey` omitted keeps the stored key; an empty string removes it. */
  aiConfigure: (options) => invoke('ai_configure', options),
  aiComplete: (before, after) => invoke('ai_complete', { before, after }),
  aiRewrite: (text, instruction) => invoke('ai_rewrite', { text, instruction }),
  aiTest: () => invoke('ai_test'),
  voiceStatus: () => invoke('voice_status'),
  /** `apiKey` omitted keeps the stored key; an empty string removes it. */
  voiceConfigure: (options) => invoke('voice_configure', options),
  voiceStart: () => invoke('voice_start'),
  /** Stops and returns the transcript; rejects with a ready-to-show reason. */
  voiceStop: () => invoke('voice_stop'),
  voiceCancel: () => invoke('voice_cancel'),
  /** Uploads a short tone to check the key/address/model without speaking. */
  voiceTest: () => invoke('voice_test'),
  checkUpdate: (automatic) => invoke('check_update', { automatic }),
  /** {currentVersion, lastChecked, lastError, availableVersion} for 设置 › 关于. */
  updateStatus: () => invoke('update_status'),
  downloadUpdate: () => invoke('download_update'),
  restartToUpdate: () => invoke('restart_to_update'),
  fileURL: (path) => convertFileSrc(path),
  /** Listens for an event sent to this window. */
  on: (event, fn) => appWindow.listen(event, ({ payload }) => fn(payload)),
};
