// Tesseract.js による領収書OCRと、金額・日付・医療機関名の抽出ヒューリスティック。
// OCR結果はあくまで下書きであり、利用者が確認・修正してから登録する前提。
let worker = null;

async function getWorker(onProgress) {
  if (worker) return worker;
  worker = await Tesseract.createWorker('jpn', 1, {
    logger: (m) => { if (onProgress) onProgress(m); },
  });
  // 罫線だらけの帳票は既定の自動レイアウト推定(PSM.AUTO)だと表構造の誤認識で
  // 崩れやすいため、順序を問わず文字塊を拾うSPARSE_TEXTに固定する。
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  return worker;
}

// スマホ写真はEXIFの回転情報が付いたまま渡すとTesseractが正しく解析できないため、
// <img>で一度デコードしてcanvasに描き直す（モダンブラウザはこの過程でEXIF回転を
// 反映してくれる）。あわせて、影・照明ムラの影響を減らすためグレースケール化＋
// Otsu法による二値化（白黒はっきりさせる）を行い、巨大すぎる画像のみ縮小する。
const OCR_MAX_DIMENSION = 3500;

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let varMax = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) { varMax = varBetween; threshold = t; }
  }
  return threshold;
}

function binarizeInPlace(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const threshold = otsuThreshold(gray);
  for (let p = 0; p < gray.length; p++) {
    const v = gray[p] < threshold ? 0 : 255;
    const idx = p * 4;
    d[idx] = v; d[idx + 1] = v; d[idx + 2] = v;
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
    binarizeInPlace(ctx, outW, outH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// スマホは書類を横向きに構図を取って撮影することが多く、その場合は文書内の文字が
// 90度単位で傾いたまま写り込む（EXIF補正だけでは直らない）。0/90/180/270度の
// 4パターンで認識を試し、最も信頼度(confidence)が高かった結果を採用する。
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

async function recognizeImage(fileOrBlob, onProgress) {
  const w = await getWorker(onProgress);
  const base = await buildBaseCanvas(fileOrBlob);

  const angles = [0, 90, 180, 270];
  let best = null;
  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    if (onProgress) {
      onProgress({ status: `向きを判定中 (${i + 1}/${angles.length})`, progress: i / angles.length });
    }
    const rotated = rotateCanvas(base, angle);
    const blob = await canvasToPngBlob(rotated);
    const { data } = await w.recognize(blob);
    const text = data.text || '';
    // Tesseractのconfidenceは向き違いの誤読でも高い値が付くことがあり信頼できないため、
    // 「まともに文字が認識できた量」＝空白除去後の文字数を主指標にする
    // （正しい向きほど連続した文字列として認識され、誤った向きは断片的にしか拾えない傾向がある）。
    const textLen = text.replace(/\s/g, '').length;
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
    if (!best || textLen > best.textLen || (textLen === best.textLen && confidence > best.confidence)) {
      best = { textLen, confidence, text };
    }
  }
  return best ? best.text : '';
}

const ERA_START = { '令和': 2018, '平成': 1988, '昭和': 1925 };

function extractDate(text) {
  let m = text.match(/(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const era = m[1];
    const yNum = m[2] === '元' ? 1 : parseInt(m[2], 10);
    const year = ERA_START[era] + yNum - 1;
    return `${year}/${String(m[3]).padStart(2, '0')}/${String(m[4]).padStart(2, '0')}`;
  }
  m = text.match(/(20\d{2}|19\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})\s*日?/);
  if (m) {
    return `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
  }
  return '';
}

function extractAmount(text) {
  const lines = text.split(/\r?\n/);
  const keyLineRe = /(合計|ご請求|請求金額|お会計|領収金額|総合計|お支払|小計)/;
  const candidates = [];
  for (const line of lines) {
    if (!keyLineRe.test(line)) continue;
    const nums = [...line.matchAll(/[¥￥]?\s*([0-9][0-9,]{2,})\s*円?/g)]
      .map((x) => parseInt(x[1].replace(/,/g, ''), 10));
    candidates.push(...nums);
  }
  if (candidates.length) return Math.max(...candidates);
  const allNums = [...text.matchAll(/([0-9][0-9,]{2,})/g)]
    .map((x) => parseInt(x[1].replace(/,/g, ''), 10))
    .filter((n) => n >= 100 && n <= 2000000);
  if (allNums.length) return Math.max(...allNums);
  return '';
}

function extractFacility(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyRe = /(病院|医院|クリニック|薬局|歯科|接骨院|整骨院|診療所)/;
  for (const line of lines.slice(0, 8)) {
    if (keyRe.test(line)) return line;
  }
  return lines[0] || '';
}

function guessCategory(facility) {
  if (/薬局/.test(facility)) return { shinryo: false, iyaku: true, kaigo: false, sonota: false };
  if (/介護/.test(facility)) return { shinryo: false, iyaku: false, kaigo: true, sonota: false };
  if (/(病院|医院|クリニック|歯科|接骨院|整骨院|診療所)/.test(facility)) {
    return { shinryo: true, iyaku: false, kaigo: false, sonota: false };
  }
  return { shinryo: false, iyaku: false, kaigo: false, sonota: true };
}

function parseReceiptText(text) {
  const facility = extractFacility(text);
  return {
    facility,
    amount: extractAmount(text),
    date: extractDate(text),
    category: guessCategory(facility),
    rawText: text,
  };
}

window.OCR = { recognizeImage, parseReceiptText };
