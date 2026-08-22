// Tesseract.js による領収書OCRと、金額・日付・医療機関名の抽出ヒューリスティック。
// OCR結果はあくまで下書きであり、利用者が確認・修正してから登録する前提。
let worker = null;

async function getWorker(onProgress) {
  if (worker) return worker;
  worker = await Tesseract.createWorker('jpn', 1, {
    logger: (m) => { if (onProgress) onProgress(m); },
  });
  return worker;
}

async function recognizeImage(fileOrBlob, onProgress) {
  const w = await getWorker(onProgress);
  const { data } = await w.recognize(fileOrBlob);
  return data.text || '';
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
