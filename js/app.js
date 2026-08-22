(() => {
  const DEFAULT_TEMPLATE_URL = './iryouhi_form_v3.1.xlsx';
  const DEFAULT_TEMPLATE_NAME = 'iryouhi_form_v3.1.xlsx（同梱デフォルト）';

  let currentYear = null;
  let entries = [];
  let templateMeta = null; // { name, arrayBuffer }
  let currentBlob = null;
  let currentBlobUrl = null;

  let ocrQueue = []; // { file, previewUrl }
  let processing = false;
  let activeFile = null; // 現在編集中ドラフトに紐づく画像ファイル（Drive保存用）
  let editingId = null; // 既存明細を編集中ならそのid

  const $ = (id) => document.getElementById(id);

  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('toast-error', !!isError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---------- 年度管理 ----------
  async function getYearList() {
    let list = await AppDB.kvGet('yearList');
    if (!list || !list.length) {
      list = [String(new Date().getFullYear())];
      await AppDB.kvSet('yearList', list);
    }
    return list;
  }

  async function addYear(year) {
    const list = await getYearList();
    if (!list.includes(year)) {
      list.push(year);
      list.sort();
      await AppDB.kvSet('yearList', list);
    }
    return list;
  }

  async function renderYearSelect() {
    const list = await getYearList();
    const sel = $('yearSelect');
    sel.innerHTML = '';
    for (const y of list) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y + '年';
      sel.appendChild(opt);
    }
    if (!currentYear || !list.includes(currentYear)) {
      currentYear = (await AppDB.kvGet('currentYear')) || list[list.length - 1];
      if (!list.includes(currentYear)) currentYear = list[list.length - 1];
    }
    sel.value = currentYear;
    $('yearLabel').textContent = currentYear;
  }

  async function switchYear(year) {
    currentYear = year;
    await AppDB.kvSet('currentYear', year);
    $('yearLabel').textContent = year;
    entries = await AppDB.getEntriesByYear(year);
    renderTable();
    await rebuildBlob();
  }

  // ---------- テンプレート管理 ----------
  async function initTemplate() {
    const stored = await AppDB.kvGet('template');
    if (stored && stored.arrayBuffer) {
      templateMeta = stored;
    } else {
      const res = await fetch(DEFAULT_TEMPLATE_URL);
      if (!res.ok) throw new Error('同梱テンプレートの読み込みに失敗しました。');
      const arrayBuffer = await res.arrayBuffer();
      templateMeta = { name: DEFAULT_TEMPLATE_NAME, arrayBuffer };
      await AppDB.kvSet('template', templateMeta);
    }
    $('templateStatus').textContent = `使用中テンプレート: ${templateMeta.name}`;
  }

  async function replaceTemplate(file) {
    const arrayBuffer = await file.arrayBuffer();
    const check = await XlsxPatch.validateTemplate(arrayBuffer);
    if (!check.ok) {
      const proceed = confirm(
        `テンプレートの形式チェックで警告があります:\n${check.reason}\n\nこのまま差し替えて使用しますか？`
      );
      if (!proceed) return;
    }
    templateMeta = { name: file.name, arrayBuffer };
    await AppDB.kvSet('template', templateMeta);
    $('templateStatus').textContent = `使用中テンプレート: ${templateMeta.name}`;
    toast('テンプレートを差し替えました。');
    await rebuildBlob();
  }

  // ---------- 明細テーブル / 合計 ----------
  function categoryLabel(cat) {
    if (!cat) return '';
    const labels = [];
    if (cat.shinryo) labels.push('診療');
    if (cat.iyaku) labels.push('医薬品');
    if (cat.kaigo) labels.push('介護');
    if (cat.sonota) labels.push('その他');
    return labels.join('/');
  }

  function renderTable() {
    const tbody = $('entriesTbody');
    tbody.innerHTML = '';
    let sumAmount = 0;
    let sumReimb = 0;
    entries.forEach((e, i) => {
      sumAmount += Number(e.amount) || 0;
      sumReimb += Number(e.reimbursed) || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${escapeHtml(e.patientName)}</td>
        <td>${escapeHtml(e.facility)}</td>
        <td>${categoryLabel(e.category)}</td>
        <td class="num">${Number(e.amount || 0).toLocaleString()}</td>
        <td class="num">${Number(e.reimbursed || 0).toLocaleString()}</td>
        <td>${escapeHtml(e.date || '')}</td>
        <td class="row-actions">
          <button data-act="edit" data-id="${e.id}" type="button">編集</button>
          <button data-act="del" data-id="${e.id}" type="button">削除</button>
        </td>`;
      tbody.appendChild(tr);
    });
    $('totalCount').textContent = entries.length;
    $('totalAmount').textContent = sumAmount.toLocaleString();
    $('totalReimbursed').textContent = sumReimb.toLocaleString();
    $('totalNet').textContent = (sumAmount - sumReimb).toLocaleString();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  async function rebuildBlob() {
    if (!templateMeta) return;
    try {
      currentBlob = await XlsxPatch.buildWorkbookBlob(templateMeta.arrayBuffer, entries);
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = URL.createObjectURL(currentBlob);
    } catch (e) {
      toast('エクセル生成エラー: ' + e.message, true);
    }
  }

  $('entriesTbody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'del') {
      if (!confirm('この明細を削除しますか？')) return;
      await AppDB.deleteEntry(id);
      entries = entries.filter((e) => e.id !== id);
      renderTable();
      await rebuildBlob();
    } else if (btn.dataset.act === 'edit') {
      const entry = entries.find((e) => e.id === id);
      if (entry) openEditForm(entry);
    }
  });

  // ---------- 患者名の候補 ----------
  async function addPatientNameSuggestion(name) {
    if (!name) return;
    let list = (await AppDB.kvGet('patientNames')) || [];
    if (!list.includes(name)) {
      list.push(name);
      await AppDB.kvSet('patientNames', list);
      renderPatientNames(list);
    }
  }

  function renderPatientNames(list) {
    const dl = $('patientNames');
    dl.innerHTML = '';
    list.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      dl.appendChild(opt);
    });
  }

  // ---------- 領収書取り込みキュー ----------
  function renderQueue() {
    const box = $('queueList');
    box.innerHTML = '';
    ocrQueue.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'queue-item';
      div.textContent = `待機中: ${item.file.name}`;
      if (i === 0 && processing) div.textContent = `解析中: ${item.file.name}`;
      box.appendChild(div);
    });
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    files.forEach((file) => ocrQueue.push({ file }));
    renderQueue();
    if (!processing) processNext();
  }

  async function processNext() {
    if (!ocrQueue.length) { processing = false; renderQueue(); return; }
    processing = true;
    const item = ocrQueue.shift();
    renderQueue();
    const progressEl = $('ocrProgress');
    progressEl.hidden = false;
    progressEl.textContent = `解析準備中: ${item.file.name}`;

    const previewUrl = URL.createObjectURL(item.file);
    try {
      const text = await OCR.recognizeImage(item.file, (m) => {
        if (m.status && typeof m.progress === 'number') {
          progressEl.textContent = `${m.status} (${Math.round(m.progress * 100)}%): ${item.file.name}`;
        }
      });
      const parsed = OCR.parseReceiptText(text);
      openEditForm({
        patientName: parsed.patientName,
        facility: parsed.facility,
        category: parsed.category,
        amount: parsed.amount,
        reimbursed: '',
        date: parsed.date,
      }, previewUrl, parsed.rawText, item.file);
    } catch (e) {
      toast('OCR処理に失敗しました: ' + e.message, true);
      processing = false;
      processNext();
    } finally {
      progressEl.hidden = true;
    }
  }

  // ---------- 編集フォーム ----------
  function openEditForm(entry, previewUrl, rawText, file) {
    editingId = entry.id || null;
    activeFile = file || null;

    $('fPatient').value = entry.patientName || '';
    $('fFacility').value = entry.facility || '';
    const cat = entry.category || {};
    $('fCatShinryo').checked = !!cat.shinryo;
    $('fCatIyaku').checked = !!cat.iyaku;
    $('fCatKaigo').checked = !!cat.kaigo;
    $('fCatSonota').checked = !!cat.sonota;
    $('fAmount').value = entry.amount === '' || entry.amount == null ? '' : entry.amount;
    $('fReimbursed').value = entry.reimbursed || '';
    $('fDate').value = entry.date || '';

    const img = $('previewImg');
    if (previewUrl) { img.src = previewUrl; img.hidden = false; } else { img.hidden = true; img.src = ''; }

    const details = $('rawTextDetails');
    if (rawText) { $('rawTextArea').value = rawText; details.hidden = false; } else { details.hidden = true; }

    $('editSection').hidden = false;
    $('editSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeEditForm() {
    $('editSection').hidden = true;
    $('entryForm').reset();
    $('previewImg').hidden = true;
    editingId = null;
    activeFile = null;
  }

  $('entryForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const category = {
      shinryo: $('fCatShinryo').checked,
      iyaku: $('fCatIyaku').checked,
      kaigo: $('fCatKaigo').checked,
      sonota: $('fCatSonota').checked,
    };
    if (!category.shinryo && !category.iyaku && !category.kaigo && !category.sonota) {
      if (!confirm('医療費の区分が未選択です。このまま登録しますか？')) return;
    }
    const entryData = {
      year: currentYear,
      patientName: $('fPatient').value.trim(),
      facility: $('fFacility').value.trim(),
      category,
      amount: $('fAmount').value === '' ? '' : Number($('fAmount').value),
      reimbursed: $('fReimbursed').value === '' ? '' : Number($('fReimbursed').value),
      date: $('fDate').value.trim(),
      updatedAt: Date.now(),
    };

    if (editingId) {
      entryData.id = editingId;
      const idx = entries.findIndex((e) => e.id === editingId);
      const createdAt = idx >= 0 ? entries[idx].createdAt : Date.now();
      entryData.createdAt = createdAt;
      await AppDB.updateEntry(entryData);
      if (idx >= 0) entries[idx] = entryData; else entries.push(entryData);
    } else {
      entryData.createdAt = Date.now();
      const id = await AppDB.addEntry(entryData);
      entryData.id = id;
      entries.push(entryData);
    }

    await addPatientNameSuggestion(entryData.patientName);
    renderTable();
    await rebuildBlob();

    // Google Driveへの自動アップロード（画像がある場合のみ）
    if (activeFile && DriveApp.getSettings().autoUpload && DriveApp.isConfigured()) {
      const y = entryData.year;
      const fname = `${entryData.date || 'unknown'}_${entryData.facility || 'receipt'}_${entryData.id}.jpg`;
      DriveApp.uploadReceiptForYear(y, activeFile, fname)
        .then(() => toast('領収書画像をGoogle Driveに保存しました。'))
        .catch((e) => toast('Drive保存に失敗しました: ' + e.message, true));
    }

    closeEditForm();
    if (ocrQueue.length) { processing = true; processNext(); } else { processing = false; renderQueue(); }
  });

  $('cancelEditBtn').addEventListener('click', () => {
    closeEditForm();
    if (ocrQueue.length) processNext();
  });

  $('manualAddBtn').addEventListener('click', () => {
    openEditForm({ patientName: '', facility: '', category: {}, amount: '', reimbursed: '', date: '' });
  });

  $('cameraInput').addEventListener('change', (ev) => { handleFiles(ev.target.files); ev.target.value = ''; });
  $('galleryInput').addEventListener('change', (ev) => { handleFiles(ev.target.files); ev.target.value = ''; });

  // ---------- 年度切り替え ----------
  $('yearSelect').addEventListener('change', (ev) => switchYear(ev.target.value));
  $('addYearBtn').addEventListener('click', async () => {
    const input = prompt('追加する年度を西暦で入力してください（例: 2027）', String(new Date().getFullYear()));
    if (!input) return;
    const year = input.trim();
    if (!/^\d{4}$/.test(year)) { toast('4桁の西暦で入力してください。', true); return; }
    await addYear(year);
    await renderYearSelect();
    $('yearSelect').value = year;
    await switchYear(year);
  });

  // ---------- テンプレート差し替え ----------
  $('templateInput').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    await replaceTemplate(file);
  });

  // ---------- ダウンロード ----------
  $('downloadBtn').addEventListener('click', async () => {
    if (!entries.length) { toast('明細データがありません。'); return; }
    if (!currentBlobUrl) await rebuildBlob();
    if (!currentBlobUrl) return;
    const a = document.createElement('a');
    a.href = currentBlobUrl;
    a.download = `医療費控除明細_${currentYear}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ---------- 設定モーダル ----------
  $('settingsBtn').addEventListener('click', () => {
    const s = DriveApp.getSettings();
    $('gcpClientId').value = s.clientId;
    $('gcpApiKey').value = s.apiKey;
    $('folderNameLabel').textContent = s.folderName || '未選択';
    $('autoUploadToggle').checked = s.autoUpload;
    $('settingsModal').hidden = false;
  });
  $('closeSettingsBtn').addEventListener('click', () => { $('settingsModal').hidden = true; });
  $('saveCredsBtn').addEventListener('click', () => {
    DriveApp.saveCreds($('gcpClientId').value, $('gcpApiKey').value);
    toast('認証情報を保存しました。');
  });
  $('pickFolderBtn').addEventListener('click', async () => {
    try {
      const folder = await DriveApp.pickFolder();
      if (folder) $('folderNameLabel').textContent = folder.name;
    } catch (e) {
      toast('フォルダ選択に失敗しました: ' + e.message, true);
    }
  });
  $('autoUploadToggle').addEventListener('change', (ev) => {
    DriveApp.setAutoUpload(ev.target.checked);
  });

  // ---------- 初期化 ----------
  (async function init() {
    try {
      await initTemplate();
    } catch (e) {
      toast(e.message, true);
    }
    const names = (await AppDB.kvGet('patientNames')) || [];
    renderPatientNames(names);
    await renderYearSelect();
    await switchYear(currentYear);
  })();
})();
