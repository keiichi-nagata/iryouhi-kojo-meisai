// IndexedDBラッパー。テンプレート/設定はkvストア、領収書明細はentriesストアに保存する。
const DB_NAME = 'iryouhi-app';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        store.createIndex('year', 'year', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function kvGet(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function addEntry(entry) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const req = tx.objectStore('entries').add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function updateEntry(entry) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteEntry(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getEntriesByYear(year) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const idx = tx.objectStore('entries').index('year');
    const req = idx.getAll(IDBKeyRange.only(year));
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.id - b.id));
    req.onerror = () => reject(req.error);
  });
}

async function getAllYears() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const req = tx.objectStore('entries').index('year').getAllKeys();
    req.onsuccess = () => resolve([...new Set(req.result)].sort());
    req.onerror = () => reject(req.error);
  });
}

window.AppDB = { kvGet, kvSet, addEntry, updateEntry, deleteEntry, getEntriesByYear, getAllYears };
