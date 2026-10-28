import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoredZip } from '../src/export-utils.js';

test('PNG ZIP entries declare UTF-8 file names', async () => {
  const name = 'élan-frame-001.png';
  const zip = new Uint8Array(await (await createStoredZip([{ name, data: new Uint8Array([1, 2, 3]) }])).arrayBuffer());
  const view = new DataView(zip.buffer);
  const UTF8_NAMES = 0x0800; // general-purpose flag bit 11

  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true) & UTF8_NAMES, UTF8_NAMES, 'local header flag');
  const nameBytes = new TextEncoder().encode(name);
  assert.deepEqual(zip.slice(30, 30 + nameBytes.length), nameBytes);

  const central = 30 + nameBytes.length + 3;
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint16(central + 8, true) & UTF8_NAMES, UTF8_NAMES, 'central directory flag');
});
