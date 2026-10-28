import assert from 'node:assert/strict';
import test from 'node:test';

const flushMicrotasks = () => new Promise(resolve => queueMicrotask(resolve));
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  assert.fail('timed out waiting for the fake IndexedDB operation');
};

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    this.listeners.get(type)?.forEach(listener => listener({ target: this }));
  }
}

class FakeTransaction {
  constructor(database, mode) {
    this.database = database;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.listeners = new Map();
    this.writes = [];
    database.transactions.push(this);
  }

  objectStore() {
    return new FakeObjectStore(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    this.listeners.get(type)?.forEach(listener => listener({ target: this }));
  }

  complete() {
    this.writes.forEach(({ key, value }) => this.database.values.set(key, value));
    this.database.events.push('transaction-complete');
    this.oncomplete?.({ target: this });
    this.dispatch('complete');
  }

  abort() {
    this.error = new Error('The fake transaction was aborted.');
    this.database.events.push('transaction-abort');
    this.onabort?.({ target: this });
    this.dispatch('abort');
  }
}

class FakeObjectStore {
  constructor(transaction) {
    this.transaction = transaction;
  }

  put(value, key) {
    const request = new FakeRequest();
    this.transaction.database.requests.push({ request, key, value, transaction: this.transaction });
    return request;
  }

  get(key) {
    const request = new FakeRequest();
    this.transaction.database.requests.push({ request, key, transaction: this.transaction });
    return request;
  }
}

class FakeDatabase {
  constructor() {
    this.values = new Map();
    this.events = [];
    this.requests = [];
    this.transactions = [];
    this.objectStoreNames = { contains: () => true };
  }

  createObjectStore() {}

  close() { this.closed = true; }

  transaction(_storeName, mode) {
    if (this.closed) throw new Error('The fake database connection is closed.');
    return new FakeTransaction(this, mode);
  }

  succeedNextRequest() {
    const operation = this.requests.shift();
    assert.ok(operation, 'expected a pending fake IndexedDB request');
    const { request, key, value, transaction } = operation;
    request.result = value === undefined ? this.values.get(key) : key;
    request.onsuccess?.({ target: request });
    request.dispatch('success');
    this.events.push('request-success');
    if (value !== undefined) transaction.writes.push({ key, value });
    return transaction;
  }

  completeNextTransaction() {
    const transaction = this.transactions.shift();
    assert.ok(transaction, 'expected a pending fake IndexedDB transaction');
    transaction.complete();
  }

  abortNextTransaction() {
    const transaction = this.transactions.shift();
    assert.ok(transaction, 'expected a pending fake IndexedDB transaction');
    transaction.abort();
  }
}

function createFakeIndexedDb(database) {
  return {
    open() {
      const request = new FakeRequest();
      queueMicrotask(() => {
        request.result = database;
        request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    }
  };
}

test('storage reopens the database after the browser closes the connection', async () => {
  const database = new FakeDatabase();
  const fake = createFakeIndexedDb(database);
  let opens = 0;
  globalThis.indexedDB = { open(...args) { opens += 1; database.closed = false; return fake.open(...args); } };
  const { writeStoredProject } = await import(`../src/storage.js?reopen-test=${Date.now()}`);
  const save = async payload => {
    const write = writeStoredProject(payload);
    await waitFor(() => database.requests.length === 1);
    database.succeedNextRequest();
    database.completeNextTransaction();
    await write;
  };

  await save('first');
  assert.equal(opens, 1);
  database.closed = true;
  database.onclose?.(); // e.g. the student cleared site data while the editor was open
  await save('after close');
  assert.equal(opens, 2);

  database.onversionchange?.(); // another tab upgrades the database
  assert.equal(database.closed, true, 'the old connection is released so the upgrade is not blocked');
  await save('after upgrade');
  assert.equal(opens, 3);
  assert.equal(database.values.get('current'), 'after upgrade');
});

test('storage waits for transaction completion and rejects an aborted transaction', async () => {
  const database = new FakeDatabase();
  globalThis.indexedDB = createFakeIndexedDb(database);
  const { readStoredProject, writeStoredProject } = await import(`../src/storage.js?delayed-test=${Date.now()}`);

  let settled = false;
  const write = writeStoredProject('durable payload').then(() => { settled = true; });
  await waitFor(() => database.requests.length === 1);
  database.succeedNextRequest();
  assert.deepEqual(database.events, ['request-success']);
  await flushMicrotasks(); // request success has fired, but completion is held.
  assert.equal(settled, false, 'request success must not be reported as durable');
  database.completeNextTransaction();
  await write;
  assert.equal(settled, true);
  assert.deepEqual(database.events.slice(0, 2), ['request-success', 'transaction-complete']);

  const read = readStoredProject();
  await waitFor(() => database.requests.length === 1);
  database.succeedNextRequest();
  database.completeNextTransaction();
  assert.equal(await read, 'durable payload');

  const aborted = writeStoredProject('discarded payload');
  await waitFor(() => database.requests.length === 1);
  database.succeedNextRequest();
  await flushMicrotasks();
  database.abortNextTransaction();
  await assert.rejects(aborted, /aborted/);
  assert.equal(database.events.at(-2), 'request-success');
  assert.equal(database.events.at(-1), 'transaction-abort');

  const finalRead = readStoredProject();
  await waitFor(() => database.requests.length === 1);
  database.succeedNextRequest();
  database.completeNextTransaction();
  assert.equal(await finalRead, 'durable payload');
});
