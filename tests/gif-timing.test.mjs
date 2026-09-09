import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGifSchedules } from '../src/export-utils.js';

function gifDelays(bytes) {
  let offset = 13;
  if (bytes[10] & 128) offset += 3 * 2 ** ((bytes[10] & 7) + 1);
  const delays = [];
  const skip = () => { while (bytes[offset]) offset += bytes[offset] + 1; offset++; };
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 59) break;
    if (block === 33) {
      const label = bytes[offset++];
      if (label === 249) delays.push(bytes.readUInt16LE(offset + 2) * 10);
      skip();
    } else if (block === 44) {
      const packed = bytes[offset + 8]; offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++; skip();
    } else throw new Error(`Unexpected GIF block ${block}`);
  }
  return delays;
}

// Run the actual bundled worker, then parse the encoded binary rather than
// merely asserting what delays we asked the encoder to write.
function encode(delays) {
  const chunks = [];
  const self = { postMessage(frame) {
    frame.data.forEach((page, index) => chunks.push(Buffer.from(page.slice(0, index === frame.data.length - 1 ? frame.cursor : frame.pageSize))));
  } };
  vm.runInNewContext(fs.readFileSync(new URL('../vendor/gif.worker.js', import.meta.url), 'utf8'), { self, Uint8Array, Uint32Array, Int32Array, Float64Array });
  delays.forEach((delay, index) => self.onmessage({ data: {
    index, last: index === delays.length - 1, width: 2, height: 2,
    delay, repeat: 0, quality: 10, transparent: null, dither: false,
    globalPalette: false, canTransfer: false,
    data: new Uint8Array(16).fill(index % 2 ? 255 : 0)
  } }));
  return gifDelays(Buffer.concat(chunks));
}

test('Jonah: actual encoder produces a browser-safe 530 ms loop', () => {
  const delays = createGifSchedules({ fps: 17, delays: Array(9).fill(1), smooth: true }).flat();
  const encoded = encode(delays);
  assert.deepEqual(encoded, delays);
  assert.ok(encoded.every(delay => delay >= 20 && delay % 10 === 0));
  assert.equal(encoded.reduce((a, b) => a + b, 0), 530);
  console.log(JSON.stringify({ frames: encoded.length, encodedMs: 530, intendedMs: 9000 / 17, errorMs: 530 - 9000 / 17 }));
});

test('long animations and variable holds avoid cumulative rounding drift', () => {
  for (const smooth of [false, true]) {
    for (const fps of [1, 12, 17, 24, 30]) {
      const multipliers = Array.from({ length: 400 }, (_, i) => [1, 2, 1.5][i % 3]);
      const schedules = createGifSchedules({ fps, delays: multipliers, smooth });
      let expected = 0, actual = 0;
      schedules.forEach((schedule, i) => {
        expected += 1000 / fps * multipliers[i];
        actual += schedule.reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(actual - expected) <= 5.000001);
        assert.ok(schedule.every(delay => delay >= 20 && delay % 10 === 0));
        if (!smooth) assert.equal(schedule.length, 1);
      });
    }
  }
});

test('sub-20 ms source frames use safe delays, with unavoidable GIF duration expansion', () => {
  assert.deepEqual(createGifSchedules({ fps: 30, delays: [0.1, 0.1], smooth: true }), [[20], [20]]);
});

if (process.env.GIF_TIMING_INPUT) {
  const delays = gifDelays(fs.readFileSync(process.env.GIF_TIMING_INPUT));
  console.log(JSON.stringify({ inputFrames: delays.length, encodedMs: delays.reduce((a, b) => a + b, 0), browserAdjustedMs: delays.reduce((a, b) => a + (b <= 10 ? 100 : b), 0) }));
}
