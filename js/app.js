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

  // ---------- 登録リスト（医療を受けた人 / 医療機関）と、OCR結果とのあいまい一致 ----------
  let patientRegistry = [];
  let facilityRegistry = [];

  // 編集距離(レーベンシュタイン距離)ベースの簡易な文字列類似度。
  // OCRは氏名の一部だけ("永田隼都"→"永田")しか拾えないことが多いため、
  // 一方が他方を包含する場合は高いスコアを与える。
  function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  // OCR結果と手入力した登録名は、見た目は同じでも文字コードが異なる
  // ことがある（全角/半角、長音記号「ー」がハイフン等の別の記号として
  // 認識される等）。比較前に正規化して表記ゆれを吸収する。
  function normalizeForMatch(str) {
    return (str || '')
      .normalize('NFKC')
      .replace(/[-‐‑‒–—―ｰ]/g, 'ー')
      .replace(/\s+/g, '');
  }

  function nameSimilarity(rawA, rawB) {
    const a = normalizeForMatch(rawA);
    const b = normalizeForMatch(rawB);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) {
      const shorter = Math.min(a.length, b.length);
      const longer = Math.max(a.length, b.length);
      return 0.7 + 0.3 * (shorter / longer);
    }
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 0;
    return 1 - levenshtein(a, b) / maxLen;
  }

  // 登録リストの中から最も近い候補を返す。上位2件の差が僅かで紛らわしい場合
  // (例: 「永田」だけでは家族内の誰か判別できない)は、誤選択を避けるため
  // あえて自動選択しない。
  function findBestMatch(query, registry, threshold = 0.5) {
    if (!query || !registry || !registry.length) return null;
    const scored = registry
      .map((name) => ({ name, score: nameSimilarity(query, name) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < threshold) return null;
    const second = scored[1];
    if (second && best.score < 1 && best.score - second.score < 0.05) return null;
    return best.name;
  }

  async function loadRegistries() {
    patientRegistry = (await AppDB.kvGet('patientRegistry')) || [];
    facilityRegistry = (await AppDB.kvGet('facilityRegistry')) || [];
  }

  function renderPatientSelect(selectedValue) {
    const sel = $('fPatient');
    sel.innerHTML = '<option value="">選択してください</option>';
    patientRegistry.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    });
    sel.value = patientRegistry.includes(selectedValue) ? selectedValue : '';
  }

  function renderFacilityDatalist() {
    const dl = $('facilityNames');
    dl.innerHTML = '';
    facilityRegistry.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      dl.appendChild(opt);
    });
  }

  // datalistはiOS Safari等で挙動が不安定なため、確実に選べる<select>も併設する。
  // 選んだら即テキスト欄に反映し、プルダウン自体は「▼ 登録済みから選択」に戻す
  // （テキスト欄がその後も自由入力できる状態を保つため）。
  function renderFacilitySelect() {
    const sel = $('fFacilitySelect');
    sel.innerHTML = '<option value="">▼ 登録済みから選択</option>';
    facilityRegistry.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    });
  }

  function renderRegistryList(listEl, registry, onDelete) {
    listEl.innerHTML = '';
    registry.forEach((name) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '削除';
      btn.addEventListener('click', () => onDelete(name));
      li.appendChild(span);
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function renderPatientRegistryUI() {
    renderRegistryList($('patientRegistryList'), patientRegistry, async (name) => {
      patientRegistry = patientRegistry.filter((n) => n !== name);
      await AppDB.kvSet('patientRegistry', patientRegistry);
      renderPatientRegistryUI();
      renderPatientSelect($('fPatient').value);
    });
  }

  function renderFacilityRegistryUI() {
    renderRegistryList($('facilityRegistryList'), facilityRegistry, async (name) => {
      facilityRegistry = facilityRegistry.filter((n) => n !== name);
      await AppDB.kvSet('facilityRegistry', facilityRegistry);
      renderFacilityRegistryUI();
      renderFacilityDatalist();
      renderFacilitySelect();
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
      const apiKey = DriveApp.getSettings().apiKey;
      const text = await OCR.recognizeImage(item.file, apiKey, (m) => {
        if (m.status && typeof m.progress === 'number') {
          progressEl.textContent = `${m.status} (${Math.round(m.progress * 100)}%): ${item.file.name}`;
        }
      });
      const parsed = OCR.parseReceiptText(text);
      // 「医療を受けた人」は登録リストからのプルダウン選択に一本化するため、
      // OCR結果は登録済みの名前と近ければ自動選択し、なければ未選択のままにする。
      const matchedPatient = findBestMatch(parsed.patientName, patientRegistry) || '';
      // 「病院・薬局などの名称」は登録リストと近ければその正式名称を採用し、
      // 一致しない場合はOCRの読み取り結果を仮入力する（登録すれば次回以降は
      // 自動選択されるようになる）。
      const matchedFacility = findBestMatch(parsed.facility, facilityRegistry) || parsed.facility || '';
      const category = matchedFacility ? OCR.guessCategory(matchedFacility) : parsed.category;
      openEditForm({
        patientName: matchedPatient,
        facility: matchedFacility,
        category,
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

    renderPatientSelect(entry.patientName || '');
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

  $('fFacilitySelect').addEventListener('change', (ev) => {
    if (ev.target.value) $('fFacility').value = ev.target.value;
    ev.target.value = ''; // 選択は反映用のワンショット操作なのでプレースホルダーに戻す
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
  function updateOpenFolderLink(folderId) {
    const link = $('openFolderLink');
    if (folderId) {
      link.href = `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  $('settingsBtn').addEventListener('click', () => {
    const s = DriveApp.getSettings();
    $('gcpClientId').value = s.clientId;
    $('gcpApiKey').value = s.apiKey;
    $('folderNameLabel').textContent = s.folderName || '未選択';
    $('autoUploadToggle').checked = s.autoUpload;
    updateOpenFolderLink(s.folderId);
    renderPatientRegistryUI();
    renderFacilityRegistryUI();
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
      if (folder) {
        $('folderNameLabel').textContent = folder.name;
        updateOpenFolderLink(folder.id);
      }
    } catch (e) {
      toast('フォルダ選択に失敗しました: ' + e.message, true);
    }
  });
  $('autoUploadToggle').addEventListener('change', (ev) => {
    DriveApp.setAutoUpload(ev.target.checked);
  });

  async function addRegistryEntry(inputEl, registry, key, render) {
    const name = inputEl.value.trim();
    if (!name) return;
    if (registry.includes(name)) { toast('すでに登録されています。'); return; }
    registry.push(name);
    await AppDB.kvSet(key, registry);
    inputEl.value = '';
    render();
  }

  $('addPatientRegistryBtn').addEventListener('click', async () => {
    await addRegistryEntry($('newPatientRegistryInput'), patientRegistry, 'patientRegistry', () => {
      renderPatientRegistryUI();
      renderPatientSelect($('fPatient').value);
    });
  });
  $('addFacilityRegistryBtn').addEventListener('click', async () => {
    await addRegistryEntry($('newFacilityRegistryInput'), facilityRegistry, 'facilityRegistry', () => {
      renderFacilityRegistryUI();
      renderFacilityDatalist();
      renderFacilitySelect();
    });
  });

  // ---------- 初期化 ----------
  (async function init() {
    try {
      await initTemplate();
    } catch (e) {
      toast(e.message, true);
    }
    await loadRegistries();
    renderPatientSelect('');
    renderFacilityDatalist();
    renderFacilitySelect();
    await renderYearSelect();
    await switchYear(currentYear);
  })();
})();
