// 「医療費集計フォーム」テンプレート(xl/worksheets/sheet1.xml)を直接パッチする。
// SheetJS/exceljs等で読み書きすると画像・データ入力規則・シート保護が失われるため、
// ZIP内のXMLを部分的に書き換えることで元のフォーマットを完全に保持する。
const XLSX_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const DATA_START_ROW = 9;
const DATA_END_ROW = 1003;
const MARK_VALUE = '該当する';

const COLS = {
  patient: 'B',
  facility: 'C',
  shinryo: 'D',
  iyaku: 'E',
  kaigo: 'F',
  sonota: 'G',
  amount: 'H',
  reimbursed: 'I',
  date: 'J',
};

const MAX_ENTRIES = DATA_END_ROW - DATA_START_ROW + 1;

function setCellText(doc, cellEl, text) {
  if (!cellEl) return;
  while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
  if (text === '' || text == null) {
    cellEl.removeAttribute('t');
    return;
  }
  cellEl.setAttribute('t', 'inlineStr');
  const is = doc.createElementNS(XLSX_NS, 'is');
  const t = doc.createElementNS(XLSX_NS, 't');
  t.setAttribute('xml:space', 'preserve');
  t.textContent = String(text);
  is.appendChild(t);
  cellEl.appendChild(is);
}

function setCellNumber(doc, cellEl, num) {
  if (!cellEl) return;
  while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
  cellEl.removeAttribute('t');
  if (num === '' || num == null || isNaN(num)) return;
  const v = doc.createElementNS(XLSX_NS, 'v');
  v.textContent = String(num);
  cellEl.appendChild(v);
}

function findCell(doc, colLetter, row) {
  return doc.querySelector(`c[r="${colLetter}${row}"]`);
}

async function loadTemplateZip(arrayBuffer) {
  return JSZip.loadAsync(arrayBuffer);
}

// アップロードされたファイルが想定レイアウト(医療費集計フォーム)と一致するか簡易チェックする
async function validateTemplate(arrayBuffer) {
  try {
    const zip = await loadTemplateZip(arrayBuffer);
    const sheetFile = zip.file(SHEET_PATH);
    if (!sheetFile) return { ok: false, reason: 'xl/worksheets/sheet1.xml が見つかりません。' };
    const sheetXml = await sheetFile.async('string');
    const doc = new DOMParser().parseFromString(sheetXml, 'application/xml');
    if (doc.querySelector('parsererror')) return { ok: false, reason: 'シートXMLの解析に失敗しました。' };
    const requiredRefs = ['A6', 'B6', 'C6', 'D6', 'H6', 'I6', 'J6'];
    for (const ref of requiredRefs) {
      if (!doc.querySelector(`c[r="${ref}"]`)) {
        return { ok: false, reason: `想定セル(${ref})が見つかりません。レイアウトが異なる可能性があります。` };
      }
    }
    // データ入力範囲(B9:J1003)のセルが存在するか
    if (!findCell(doc, 'B', DATA_START_ROW) || !findCell(doc, 'J', DATA_END_ROW)) {
      return { ok: false, reason: 'データ入力範囲(B9:J1003)のセル構成が想定と異なります。' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'ファイルの読み込みに失敗しました: ' + e.message };
  }
}

async function buildWorkbookBlob(templateArrayBuffer, entries) {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`データ件数が上限(${MAX_ENTRIES}件)を超えています。`);
  }
  const zip = await loadTemplateZip(templateArrayBuffer);
  const sheetFile = zip.file(SHEET_PATH);
  if (!sheetFile) throw new Error('テンプレート内にxl/worksheets/sheet1.xmlが見つかりません。');
  const sheetXml = await sheetFile.async('string');
  const doc = new DOMParser().parseFromString(sheetXml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('シートXMLの解析に失敗しました。');

  entries.forEach((entry, i) => {
    const row = DATA_START_ROW + i;
    const cat = entry.category || {};
    setCellText(doc, findCell(doc, COLS.patient, row), entry.patientName || '');
    setCellText(doc, findCell(doc, COLS.facility, row), entry.facility || '');
    setCellText(doc, findCell(doc, COLS.shinryo, row), cat.shinryo ? MARK_VALUE : '');
    setCellText(doc, findCell(doc, COLS.iyaku, row), cat.iyaku ? MARK_VALUE : '');
    setCellText(doc, findCell(doc, COLS.kaigo, row), cat.kaigo ? MARK_VALUE : '');
    setCellText(doc, findCell(doc, COLS.sonota, row), cat.sonota ? MARK_VALUE : '');
    setCellNumber(doc, findCell(doc, COLS.amount, row), entry.amount === '' || entry.amount == null ? '' : Number(entry.amount));
    setCellNumber(doc, findCell(doc, COLS.reimbursed, row), entry.reimbursed ? Number(entry.reimbursed) : '');
    setCellText(doc, findCell(doc, COLS.date, row), entry.date || '');
  });

  const serialized = new XMLSerializer().serializeToString(doc);
  zip.file(SHEET_PATH, serialized);
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

window.XlsxPatch = {
  buildWorkbookBlob,
  validateTemplate,
  DATA_START_ROW,
  DATA_END_ROW,
  MAX_ENTRIES,
  COLS,
};
