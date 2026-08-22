// Tesseract.js による領収書OCRと、金額・日付・医療機関名の抽出ヒューリスティック。
// OCR結果はあくまで下書きであり、利用者が確認・修正してから登録する前提。

// 同一ワーカーを使い回してページ分割モード(PSM)を切り替えると、内部状態が
// 引き継がれるためか認識結果が不安定になることを実機検証で確認した。
// そのため認識1回ごとに使い捨てのワーカーを生成する（速度より精度を優先）。
async function recognizeOnce(blob, psm, onProgress) {
  const w = await Tesseract.createWorker('jpn', 1, {
    logger: (m) => { if (onProgress) onProgress(m); },
  });
  try {
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(blob);
    return data;
  } finally {
    await w.terminate();
  }
}

// スマホ写真はEXIFの回転情報が付いたまま渡すとTesseractが正しく解析できないため、
// <img>で一度デコードしてcanvasに描き直す（モダンブラウザはこの過程でEXIF回転を
// 反映してくれる）。あわせてグレースケール化し、巨大すぎる画像のみ縮小する。
// 二値化(白黒化)は行わない — 実機の照明ムラがある写真では単純な閾値処理が
// 逆に文字を潰してしまうことを確認したため、Tesseract自身の内部処理に委ねる。
const OCR_MAX_DIMENSION = 3500;

function grayscaleInPlace(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = g; d[i + 1] = g; d[i + 2] = g;
  }
  ctx.putImageData(imgData, 0, 0);
}

async function buildBaseCanvas(fileOrBlob) {
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
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, outW, outH);
    grayscaleInPlace(ctx, outW, outH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// スマホは書類を横向きに構図を取って撮影することが多く、その場合は文書内の文字が
// 90度単位で傾いたまま写り込む（EXIF補正だけでは直らない）。
function rotateCanvas(srcCanvas, degrees) {
  if (degrees === 0) return srcCanvas;
  const swapped = degrees === 90 || degrees === 270;
  const out = document.createElement('canvas');
  out.width = swapped ? srcCanvas.height : srcCanvas.width;
  out.height = swapped ? srcCanvas.width : srcCanvas.height;
  const ctx = out.getContext('2d');
  ctx.save();
  if (degrees === 90) {
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (degrees === 180) {
    ctx.translate(out.width, out.height);
    ctx.rotate(Math.PI);
  } else if (degrees === 270) {
    ctx.translate(0, out.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.restore();
  return out;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました。'))), 'image/png');
  });
}

// 向きの判定にはTesseract標準のOSD(向き・スクリプト検出)機能を使う。
// 「認識できた文字数が多い向きを正解とみなす」方式も試したが、上下逆さま
// (180度)の場合に正しい向きとほぼ同数の文字を拾ってしまい誤判定することが
// 実機検証で判明したため、専用のOSD検出に置き換えた。
async function detectOrientation(blob) {
  const w = await Tesseract.createWorker('osd', 0, {});
  try {
    const { data } = await w.detect(blob);
    const degrees = data && typeof data.orientation_degrees === 'number' ? data.orientation_degrees : 0;
    // OSDが返すのは0/90/180/270のいずれか。想定外の値が来た場合は補正しない。
    return [0, 90, 180, 270].includes(degrees) ? degrees : 0;
  } catch (e) {
    return 0;
  } finally {
    await w.terminate();
  }
}

async function recognizeImage(fileOrBlob, onProgress) {
  const base = await buildBaseCanvas(fileOrBlob);

  if (onProgress) onProgress({ status: '向きを判定中', progress: 0 });
  const baseBlob = await canvasToPngBlob(base);
  const correctionDegrees = await detectOrientation(baseBlob);
  const corrected = rotateCanvas(base, correctionDegrees);
  const blob = correctionDegrees === 0 ? baseBlob : await canvasToPngBlob(corrected);

  // 罫線で囲まれた表組みは、標準の自動レイアウト推定(AUTO)だと内容を丸ごと
  // 読み飛ばすことがある一方、まばらな文字を拾うSPARSE_TEXTだと逆に単純な
  // 文章を見落とすことがある。両方の結果を合成し、どちらか一方でも拾えた
  // 内容を後段の金額・日付抽出に渡せるようにする。
  if (onProgress) onProgress({ status: '文字を認識中 (1/2)', progress: 0.3 });
  const autoData = await recognizeOnce(blob, Tesseract.PSM.AUTO, onProgress);
  if (onProgress) onProgress({ status: '文字を認識中 (2/2)', progress: 0.65 });
  const sparseData = await recognizeOnce(blob, Tesseract.PSM.SPARSE_TEXT, onProgress);

  if (onProgress) onProgress({ status: '文字を認識中', progress: 1 });
  return `${autoData.text || ''}\n${sparseData.text || ''}`;
}

const ERA_START = { '令和': 2018, '平成': 1988, '昭和': 1925 };

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
  m = text.match(/(20\d{2}|19\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})\s*日?/);
  if (m) {
    return `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
  }
  return '';
}

function numbersInLine(line) {
  return [...line.matchAll(/[¥￥]?\s*([0-9][0-9,]{2,})\s*円?/g)]
    .map((x) => parseInt(x[1].replace(/,/g, ''), 10));
}

// 医療費控除の対象は「実際に支払った金額」であり、保険点数等を含む「合計」欄とは
// 異なる場合がある（例: 合計550点・領収金額500円のように、合計の方が大きい数字に
// なる帳票がある）。そのため、実際の支払額を表すキーワードを優先的に探す。
// OCRでは項目名と数値が別の行に分かれて認識されることが多いため、キーワードの
// 行だけでなく次の行も合わせて探索する。
const AMOUNT_KEYWORD_TIERS = [
  /(領収金額|負担額|自己負担|お支払|お会計)/,
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

function extractFacility(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyRe = /(病院|医院|クリニック|薬局|歯科|接骨院|整骨院|診療所)/;
  for (const line of lines) {
    if (keyRe.test(line.replace(/\s+/g, ''))) return cleanJapaneseSpacing(line);
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
  if (/(病院|医院|クリニック|歯科|接骨院|整骨院|診療所)/.test(compact)) {
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

window.OCR = { recognizeImage, parseReceiptText };
