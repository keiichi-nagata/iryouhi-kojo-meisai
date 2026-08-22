// Google Drive連携。OAuthクライアントIDとAPIキーは利用者がブラウザに保存する
// (このリポジトリには一切の認証情報を含めない)。スコープはdrive.fileのみを使用し、
// 本アプリが作成/選択したファイル・フォルダにのみアクセスする。
const DriveApp = (() => {
  let tokenClient = null;
  let accessToken = null;
  let pickerLoaded = false;

  function getSettings() {
    return {
      clientId: localStorage.getItem('gcp_client_id') || '',
      apiKey: localStorage.getItem('gcp_api_key') || '',
      folderId: localStorage.getItem('drive_folder_id') || '',
      folderName: localStorage.getItem('drive_folder_name') || '',
      autoUpload: localStorage.getItem('drive_auto_upload') === '1',
    };
  }

  function saveCreds(clientId, apiKey) {
    localStorage.setItem('gcp_client_id', clientId.trim());
    localStorage.setItem('gcp_api_key', apiKey.trim());
    tokenClient = null;
    accessToken = null;
  }

  function saveFolder(id, name) {
    localStorage.setItem('drive_folder_id', id);
    localStorage.setItem('drive_folder_name', name);
  }

  function setAutoUpload(enabled) {
    localStorage.setItem('drive_auto_upload', enabled ? '1' : '0');
  }

  function isConfigured() {
    const s = getSettings();
    return !!(s.clientId && s.apiKey);
  }

  function ensureToken() {
    return new Promise((resolve, reject) => {
      const { clientId } = getSettings();
      if (!clientId) return reject(new Error('Google OAuthクライアントIDが未設定です。設定画面から入力してください。'));
      if (typeof google === 'undefined' || !google.accounts) {
        return reject(new Error('Google認証ライブラリの読み込みに失敗しました。通信環境を確認してください。'));
      }
      if (accessToken) { resolve(accessToken); return; }
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: (resp) => {
            if (resp.error) { reject(resp); return; }
            accessToken = resp.access_token;
            resolve(accessToken);
          },
        });
      }
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  async function loadPicker() {
    if (pickerLoaded) return;
    await new Promise((resolve, reject) => {
      if (typeof gapi === 'undefined') { reject(new Error('Google APIライブラリの読み込みに失敗しました。')); return; }
      gapi.load('picker', resolve);
    });
    pickerLoaded = true;
  }

  async function pickFolder() {
    const token = await ensureToken();
    await loadPicker();
    const { apiKey } = getSettings();
    return new Promise((resolve, reject) => {
      try {
        const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setSelectFolderEnabled(true)
          .setIncludeFolders(true)
          .setMimeTypes('application/vnd.google-apps.folder');
        const picker = new google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(token)
          .setDeveloperKey(apiKey)
          .setTitle('領収書の保存先フォルダを選択')
          .setCallback((data) => {
            if (data.action === google.picker.Action.PICKED) {
              const doc = data.docs[0];
              saveFolder(doc.id, doc.name);
              resolve({ id: doc.id, name: doc.name });
            } else if (data.action === google.picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build();
        picker.setVisible(true);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function findOrCreateSubfolder(parentId, name) {
    const token = await ensureToken();
    const q = encodeURIComponent(
      `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (json.files && json.files.length) return json.files[0].id;
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    if (!createRes.ok) throw new Error('フォルダ作成に失敗しました: ' + (await createRes.text()));
    const created = await createRes.json();
    return created.id;
  }

  async function uploadFile(blob, filename, mimeType, parentId) {
    const token = await ensureToken();
    const metadata = { name: filename, parents: [parentId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob, filename);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw new Error('Driveアップロードに失敗しました: ' + (await res.text()));
    return res.json();
  }

  async function uploadReceiptForYear(year, blob, filename) {
    const { folderId } = getSettings();
    if (!folderId) throw new Error('保存先フォルダが未設定です。設定画面から選択してください。');
    const yearFolderId = await findOrCreateSubfolder(folderId, String(year));
    return uploadFile(blob, filename, blob.type || 'image/jpeg', yearFolderId);
  }

  return {
    getSettings, saveCreds, saveFolder, setAutoUpload, isConfigured,
    ensureToken, pickFolder, uploadReceiptForYear,
  };
})();

window.DriveApp = DriveApp;
