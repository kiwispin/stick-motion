const DATABASE_NAME = 'stickmotion';
const DATABASE_VERSION = 1;
const STORE_NAME = 'projects';
const CURRENT_PROJECT_KEY = 'current';
const LEGACY_PROJECT_KEY = 'stickmotion_data';

let databasePromise = null;

function storageError(message) {
  return new Error(message);
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(storageError('IndexedDB is unavailable.'));
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || storageError('The project database could not be opened.'));
    request.onblocked = () => reject(storageError('The project database is blocked by another browser tab.'));
  });
  databasePromise.catch(() => { databasePromise = null; });
  return databasePromise;
}

function runRequest(mode, callback) {
  return openDatabase().then(database => new Promise((resolve, reject) => {
    let transaction;
    let request;
    let result;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      request = callback(store);
    } catch (error) {
      fail(error);
      return;
    }
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => fail(request.error || transaction.error || storageError('The project database request failed.'));
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    transaction.onerror = () => fail(transaction.error || storageError('The project database transaction failed.'));
    transaction.onabort = () => fail(transaction.error || storageError('The project database transaction was aborted.'));
  }));
}

export function readStoredProject() {
  return runRequest('readonly', store => store.get(CURRENT_PROJECT_KEY));
}

export function writeStoredProject(payload) {
  return runRequest('readwrite', store => store.put(payload, CURRENT_PROJECT_KEY));
}

export function readLegacyProject() {
  try {
    return localStorage.getItem(LEGACY_PROJECT_KEY);
  } catch (error) {
    console.warn('The legacy project draft could not be read.', error);
    return null;
  }
}

export function removeLegacyProject() {
  try {
    localStorage.removeItem(LEGACY_PROJECT_KEY);
  } catch (error) {
    console.warn('The legacy project draft could not be removed.', error);
  }
}
