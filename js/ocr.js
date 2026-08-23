// Google Cloud Vision API (DOCUMENT_TEXT_DETECTION) による領収書OCRと、
// 金額・日付・医療機関名・患者名の抽出ヒューリスティック。
// OCR結果はあくまで下書きであり、利用者が確認・修正してから登録する前提。
//
// ブラウザ内OCR(Tesseract.js)は罫線の多い帳票では文字化けが激しく実用に
// 耐えなかったため、クラウドのVision APIに切り替えた。Vision API自体が
// 画像の回転・EXIF補正を内部で行うため、独自の向き判定・二値化処理は不要。

const OCR_MAX_DIMENSION = 2500;

async function buildResizedCanvas(fileOrBlob) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, OCR_MAX_DIMENSION / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').drawImage(img, 0, 0, outW, outH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBase64Jpeg(canvas) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function callVisionApi(base64Content, apiKey) {
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: base64Content },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['ja'] },
      }],
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    throw new Error(`Vision APIの呼び出しに失敗しました: ${message}`);
  }
  const result = json && json.responses && json.responses[0];
  if (result && result.error) {
    throw new Error(`Vision APIエラー: ${result.error.message}`);
  }
  return (result && result.fullTextAnnotation && result.fullTextAnnotation.text) || '';
}

async function recognizeImage(fileOrBlob, apiKey, onProgress) {
  if (!apiKey) {
    throw new Error('Google CloudのAPIキーが設定されていません。設定画面から入力してください。');
  }
  if (onProgress) onProgress({ status: '画像を準備中', progress: 0 });
  const canvas = await buildResizedCanvas(fileOrBlob);
  const base64 = canvasToBase64Jpeg(canvas);

  if (onProgress) onProgress({ status: 'クラウドで文字を認識中', progress: 0.4 });
  const text = await callVisionApi(base64, apiKey);
  if (onProgress) onProgress({ status: '完了', progress: 1 });
  return text;
}

const ERA_START = { '令和': 2018, '平成': 1988, '昭和': 1925 };

const ERA_ALPHABET = { R: '令和', H: '平成', S: '昭和' };

function extractDate(text) {
  // OCRは「令和」等の熟語の間にも余分な空白を挿入することがあるため、
  // 元号の文字間にも\s*を許容する。
  let m = text.match(/(令\s*和|平\s*成|昭\s*和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const era = m[1].replace(/\s+/g, '');
    const yNum = m[2] === '元' ? 1 : parseInt(m[2], 10);
    const year = ERA_START[era] + yNum;
    return `${year}/${String(m[3]).padStart(2, '0')}/${String(m[4]).padStart(2, '0')}`;
  }
  // 病院等の帳票では「R8年7月6日」のように元号をアルファベット1文字
  // (R=令和, H=平成, S=昭和)で略記することが多い。
  m = text.match(/\b([RHS])\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/i);
  if (m) {
    const era = ERA_ALPHABET[m[1].toUpperCase()];
    const year = ERA_START[era] + parseInt(m[2], 10);
    return `${year}/${String(m[3]).padStart(2, '0')}/${String(m[4]).padStart(2, '0')}`;
  }
  m = text.match(/(20\d{2}|19\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})\s*日?/);
  if (m) {
    return `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
  }
  return '';
}

function numbersInLine(line) {
  // 診療報酬の「点数」(例: 1086点)は金額(円)ではないため、数字の直後に
  // 「点」が続く場合は候補から除外する。
  return [...line.matchAll(/[¥￥]?\s*([0-9][0-9,]{2,})(?!\s*点)\s*円?/g)]
    .map((x) => parseInt(x[1].replace(/,/g, ''), 10));
}

// 医療費控除の対象は「実際に支払った金額」であり、保険点数等を含む「合計」欄とは
// 異なる場合がある（例: 合計550点・領収金額500円のように、合計の方が大きい数字に
// なる帳票がある）。そのため、実際の支払額を表すキーワードを優先的に探す。
// OCRでは項目名と数値が別の行に分かれて認識されることが多いため、キーワードの
// 行だけでなく次の行も合わせて探索する。
const AMOUNT_KEYWORD_TIERS = [
  /(領収金額|領収額|負担額|自己負担|お支払|お会計)/,
  /(請求金額|ご請求)/,
  /(合計|総合計|小計)/,
];

function extractAmount(text) {
  // Tesseractは日本語の文字間に余分な空白を挿入することが多く、
  // 「領収金額」が「領収 金額」のように分かれて認識されるため、
  // キーワード判定は空白を除去した文字列に対して行う。
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, '')).filter(Boolean);

  for (const keyRe of AMOUNT_KEYWORD_TIERS) {
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      if (!keyRe.test(lines[i])) continue;
      let nums = numbersInLine(lines[i]);
      if (!nums.length && i + 1 < lines.length) nums = numbersInLine(lines[i + 1]);
      candidates.push(...nums);
    }
    if (candidates.length) return Math.max(...candidates);
  }

  // キーワード行が見つからない場合、文中の適当な数字列(患者番号・電話番号・
  // 保険者番号等)を金額と誤認識するリスクが非常に高いため、無条件のフォール
  // バックは行わない。「¥」「円」など通貨記号が伴う数字に限り最終候補とする。
  const currencyMarked = [...text.matchAll(/[¥￥]\s*([0-9][0-9,]{2,})|([0-9][0-9,]{2,})\s*円/g)]
    .map((x) => parseInt((x[1] || x[2]).replace(/,/g, ''), 10))
    .filter((n) => n >= 100 && n <= 2000000);
  if (currencyMarked.length) return Math.max(...currencyMarked);
  return '';
}

// Tesseractは日本語の文字間に余分な空白を挿入することが多いため、
// 和文字どうしに挟まれた空白だけを取り除いて表示用に整形する
// （英数字と和文字の間の空白は本来の区切りの可能性があるため残す）。
function cleanJapaneseSpacing(str) {
  return str.replace(/([぀-ヿ一-鿿])\s+(?=[぀-ヿ一-鿿])/g, '$1');
}

// 「地方独立行政法人〇〇病院機構」のような運営法人名が、実際に受診した
// 施設名(例:「大阪母子医療センター」)とは別の行に出てくる帳票がある。
// 運営法人の行にも「病院」等のキーワードが含まれ得るため、先に見つかった
// 行を無条件に採用すると運営法人名を拾ってしまう。法人格の接頭辞で始まる
// 行より、そうでない行を優先する。
const LEGAL_ENTITY_PREFIX_RE = /^((地方)?独立行政法人|医療法人(社団|財団)?|社会福祉法人|学校法人|(一般|公益)?社団法人|(一般|公益)?財団法人)/;

function extractFacility(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyRe = /(病院|医院|クリニック|薬局|歯科|接骨院|整骨院|診療所|医療センター)/;
  const matches = lines.filter((line) => keyRe.test(line.replace(/\s+/g, '')));
  if (matches.length) {
    const preferred = matches.find((line) => !LEGAL_ENTITY_PREFIX_RE.test(line.replace(/\s+/g, '')));
    return cleanJapaneseSpacing(preferred || matches[0]);
  }
  return lines[0] ? cleanJapaneseSpacing(lines[0]) : '';
}

// 「氏名」欄のラベルの後ろ数行から患者名らしき文字列を探す。
// 領収証は「患者番号／氏名」のような見出し行の下に「2288／ナガタハヤト／永田隼都　様」
// のように番号・ふりがな・漢字氏名が並ぶことが多いため、数字のみの行(患者番号)は除外し、
// カタカナのふりがなより漢字を含む候補を優先する。
function extractPatientName(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelRe = /氏\s*名/;
  // 「氏名」のうち「氏」がOCRで欠落し「名」だけの単独行として認識される
  // ことがあるため、その場合もラベル行とみなす。
  const looseLabelRe = /^名$/;
  let labelIdx = lines.findIndex((l) => labelRe.test(l));
  if (labelIdx === -1) labelIdx = lines.findIndex((l) => looseLabelRe.test(l));
  if (labelIdx === -1) return '';

  const candidates = [];
  for (let i = labelIdx; i < Math.min(labelIdx + 5, lines.length); i++) {
    // ラベル行自体は「患者番号 氏名」のように別の見出しと同居していることがあるため、
    // ラベルより前の部分は無視し、ラベルより後ろの部分だけを候補にする。
    let raw = lines[i];
    if (i === labelIdx) {
      const m = raw.match(labelRe);
      raw = m ? raw.slice(m.index + m[0].length) : '';
    }
    // 患者番号と氏名が同一行に詰めて認識される場合があるため、先頭の数字列は除去する。
    const stripped = raw.replace(/\s+/g, '').replace(/^[0-9]+/, '');
    if (!stripped) continue;
    // 「患者番号」等の見出しがOCRで断片的に崩れた場合(例:「愚者番」)でも
    // 除外できるよう、帳票の事務的な語に含まれがちな漢字を含む候補を除外する。
    if (/[患者番号発行期間請求負担割合険]/.test(stripped)) continue;
    const nameOnly = stripped.replace(/様$/, '');
    // 日本人の氏名は通常2〜6文字程度で、数字を含まない。
    if (nameOnly.length < 2 || nameOnly.length > 6) continue;
    if (/[0-9]/.test(nameOnly)) continue;
    if (!/[぀-ヿ一-鿿]/.test(nameOnly)) continue;
    candidates.push(nameOnly);
  }
  if (!candidates.length) return '';
  const kanjiCandidate = candidates.find((c) => /[一-鿿]/.test(c));
  return kanjiCandidate || candidates[0];
}

function guessCategory(facility) {
  const compact = (facility || '').replace(/\s+/g, '');
  if (/薬局/.test(compact)) return { shinryo: false, iyaku: true, kaigo: false, sonota: false };
  if (/介護/.test(compact)) return { shinryo: false, iyaku: false, kaigo: true, sonota: false };
  if (/(病院|医院|クリニック|歯科|接骨院|整骨院|診療所|医療センター)/.test(compact)) {
    return { shinryo: true, iyaku: false, kaigo: false, sonota: false };
  }
  return { shinryo: false, iyaku: false, kaigo: false, sonota: true };
}

function parseReceiptText(text) {
  const facility = extractFacility(text);
  return {
    patientName: extractPatientName(text),
    facility,
    amount: extractAmount(text),
    date: extractDate(text),
    category: guessCategory(facility),
    rawText: text,
  };
}

window.OCR = { recognizeImage, parseReceiptText, guessCategory };
