/**
 * Local record store.
 * Spec: 03 功能规格 S10 / 04 §3 (IndexedDB) / 02 §7
 *
 * RED LINE: records hold scores and measurements only. No image data, ever.
 * Everything stays on this device; uninstalling removes it.
 */

const DB_NAME = 'facestroke';
const DB_VERSION = 1;
const STORE = 'records';
const LS_KEY = 'facestroke.records';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/* ------------------------------------------------------ localStorage fallback */

function lsRead() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    return [];
  }
}

function lsWrite(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list.slice(-500)));
}

/* --------------------------------------------------------------------- api */

/**
 * Persist one detection result.
 * @param {object} rec must NOT contain image data
 */
export async function addRecord(rec) {
  const clean = {
    timestamp: rec.timestamp || new Date().toISOString(),
    score: rec.score,
    zones: rec.zones || null,
    tier: rec.tier ?? null,
    modelVersions: rec.modelVersions || null,
    consentVersion: rec.consentVersion || null,
    captureMetrics: rec.captureMetrics || null,
  };
  // guard against anyone accidentally passing pixels through
  for (const v of Object.values(clean)) {
    if (v instanceof Blob || v instanceof ImageData || v instanceof ArrayBuffer) {
      throw new Error('refusing to store image-like data in a record');
    }
  }
  // the landmark freeze-frame is a data URL string, which the checks above would
  // not catch. Records must never contain image data (02 red line 1).
  const asText = JSON.stringify(clean) || '';
  if (/data:image\//.test(asText)) {
    throw new Error('refusing to store an image data URL in a record');
  }
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add(clean);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    const list = lsRead();
    list.push({ ...clean, id: list.length + 1 });
    lsWrite(list);
    return list.length;
  }
}

/** @returns {Promise<Array<object>>} oldest first */
export async function listRecords() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return lsRead();
  }
}

export async function latestRecord() {
  const all = await listRecords();
  return all.length ? all[all.length - 1] : null;
}

export async function clearAll() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* fall through to localStorage */
  }
  localStorage.removeItem(LS_KEY);
}

/** Count of stored records, used by the settings screen. */
export async function countRecords() {
  const all = await listRecords();
  return all.length;
}
