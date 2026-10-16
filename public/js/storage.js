// Guarda as peças e as gravações no próprio navegador (IndexedDB).
const DB_NAME = 'adeixa';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('scripts', { keyPath: 'id' });
        const rec = d.createObjectStore('recordings', { keyPath: 'key' });
        rec.createIndex('scriptId', 'scriptId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const listScripts = () => run('scripts', 'readonly', s => s.getAll());
export const getScript = id => run('scripts', 'readonly', s => s.get(id));
export const saveScript = script => run('scripts', 'readwrite', s => s.put({ ...script, updatedAt: Date.now() }));
export async function deleteScript(id) {
  const recs = await listRecordings(id);
  await run('recordings', 'readwrite', s => { recs.forEach(r => s.delete(r.key)); });
  await run('scripts', 'readwrite', s => s.delete(id));
}

export const recordingKey = (scriptId, blockId) => `${scriptId}:${blockId}`;
export const listRecordings = scriptId => run('recordings', 'readonly', s => s.index('scriptId').getAll(scriptId));
export const saveRecording = rec => run('recordings', 'readwrite', s => s.put({ ...rec, key: recordingKey(rec.scriptId, rec.blockId) }));
export const deleteRecording = (scriptId, blockId) => run('recordings', 'readwrite', s => s.delete(recordingKey(scriptId, blockId)));
