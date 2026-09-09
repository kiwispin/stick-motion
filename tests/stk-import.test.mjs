import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  STK_MAX_FILE_BYTES, STK_MAX_PAYLOAD_BYTES, STK_WRAPPER_V4, STK_WRAPPER_V5, createFigureFromStk, decodeStk, decodeStkBytes,
  pointOnStkSegment, validateStkArtwork
} from '../src/stk-import.js';
import { normaliseProject } from '../src/project.js';

function compressed(wrapper, payload) {
  return Buffer.concat([Buffer.from([wrapper]), zlib.deflateSync(Buffer.from(payload))]);
}

function v4Payload(records) {
  const payload = Buffer.alloc(1 + records.length * 24);
  payload[0] = records.length;
  records.forEach((record, index) => {
    const offset = 1 + index * 24;
    payload[offset] = record.parent;
    payload[offset + 1] = index + 1;
    payload.writeUInt16LE(record.reserved ?? 0, offset + 2);
    payload.writeFloatLE(record.length, offset + 4);
    payload.writeDoubleLE(record.angle, offset + 8);
    payload.writeFloatLE(record.width, offset + 16);
    payload[offset + 20] = record.type ?? 0;
    payload[offset + 21] = record.flag ?? 0;
    payload.writeUInt16LE(record.trailing ?? 3133, offset + 22);
  });
  return payload;
}

function v5Payload({ segments, curves = [], polygons = [], ranks = null }) {
  const chunks = [Buffer.from([0xa8, segments.length & 0xff, segments.length >> 8])];
  for (const segment of segments) {
    const record = Buffer.alloc(23);
    record.writeUInt16LE(segment.parent, 0);
    record.writeFloatLE(segment.length, 2);
    record.writeDoubleLE(segment.angle, 6);
    record.writeFloatLE(segment.width, 14);
    record[18] = segment.type ?? 0; record[19] = segment.flag ?? 0;
    record.set(segment.color ?? [0, 0, 0], 20); chunks.push(record);
  }
  const curveHeader = Buffer.alloc(2); curveHeader.writeUInt16LE(curves.length); chunks.push(curveHeader);
  for (const curve of curves) { const record = Buffer.alloc(10); record.writeUInt16LE(curve.index, 0); record.writeDoubleLE(curve.bend, 2); chunks.push(record); }
  const polygonHeader = Buffer.alloc(2); polygonHeader.writeUInt16LE(polygons.length); chunks.push(polygonHeader);
  for (const polygon of polygons) {
    const record = Buffer.alloc(6 + polygon.vertices.length * 2);
    record.writeUInt16LE(polygon.vertices.length, 0); record.set(polygon.color, 2);
    polygon.vertices.forEach((vertex, index) => record.writeUInt16LE(vertex, 6 + index * 2)); chunks.push(record);
  }
  const drawRanks = ranks ?? segments.map((_, index) => index);
  const tail = Buffer.alloc(drawRanks.length * 2); drawRanks.forEach((rank, index) => tail.writeUInt16LE(rank, index * 2)); chunks.push(tail);
  return Buffer.concat(chunks);
}

function lineFigureData(figure) {
  return JSON.parse(JSON.stringify(figure));
}

test('decodes the measured Pivot 4 layout and preserves the filled circle mapping', async () => {
  const bytes = compressed(STK_WRAPPER_V4, v4Payload([
    { parent: 0, length: 20, angle: 0, width: 6 },
    { parent: 1, length: 10, angle: Math.PI / 2, width: 4, type: 3 }
  ]));
  const decoded = await decodeStk(bytes);
  assert.equal(decoded.wrapper, STK_WRAPPER_V4);
  assert.equal(decoded.segments.length, 2);
  assert.equal(decoded.segments[1].type, 3);
  const figure = createFigureFromStk(decoded);
  figure.updatePositions();
  assert.equal(figure.joints.length, 3);
  assert.equal(figure.joints[1].parentId, 'stk-root');
  assert.equal(figure.joints[2].parentId, 'stk-1');
  assert.ok(figure.stkArtwork.warnings.length > 0);
  assert.deepEqual(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].stkArtwork, figure.stkArtwork);
});

test('decodes Pivot 5 curves, polygons, colors and rank-per-item draw order', async () => {
  const payload = v5Payload({
    segments: [
      { parent: 0, length: 100, angle: 0, width: 5, color: [12, 34, 56] },
      { parent: 1, length: 50, angle: Math.PI / 2, width: 0, flag: 1, type: 4, color: [90, 80, 70] },
      { parent: 1, length: 30, angle: 0, width: 4, color: [1, 2, 3] }
    ],
    curves: [{ index: 1, bend: -Math.PI / 2 }],
    polygons: [{ color: [200, 100, 50], vertices: [0, 1, 3] }],
    ranks: [2, 0, 3, 1]
  });
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, payload));
  assert.equal(decoded.payloadHeader, 'a80300');
  assert.equal(decoded.parameters.length, 1);
  assert.equal(decoded.segments[1].bend, -Math.PI / 2);
  assert.deepEqual(decoded.polygons[0].color, [200, 100, 50]);
  assert.deepEqual(decoded.drawRanks, [2, 0, 3, 1]);
  validateStkArtwork(decoded);
  const figure = createFigureFromStk(decoded);
  assert.equal(figure.joints.length, 4);
  assert.equal(figure.joints[2].handleVisible, false);
  const source = decoded.segments[1];
  figure.updatePositions();
  const parent = figure.joints[1], child = figure.joints[2];
  const start = { x: parent.x, y: parent.y };
  const chordLength = Math.hypot(child.x - parent.x, child.y - parent.y);
  const chordAngle = Math.atan2(child.y - parent.y, child.x - parent.x);
  const p0 = pointOnStkSegment(source, start, 0, chordLength, chordAngle);
  const p1 = pointOnStkSegment(source, start, 1, chordLength, chordAngle);
  assert.ok(Math.hypot(p0.x - start.x, p0.y - start.y) < 1e-8);
  assert.ok(Math.hypot(p1.x - child.x, p1.y - child.y) < 1e-8);
});

test('extends the joint bound only for validated imported figures', async () => {
  const segments = Array.from({ length: 100 }, (_, index) => ({ parent: index, length: 1, angle: 0, width: 1, color: [1, 1, 1] }));
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({ segments })));
  const figure = createFigureFromStk(decoded);
  assert.equal(figure.joints.length, 101);
  assert.equal(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].joints.length, 101);
});

test('rejects unsupported types, malformed parents, trailing sections and source layouts', async () => {
  const unsupported = v5Payload({ segments: [{ parent: 0, length: 10, angle: 0, width: 2, type: 6, color: [0, 0, 0] }] });
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V5, unsupported)), /unsupported type/);
  const badParent = v5Payload({ segments: [{ parent: 2, length: 10, angle: 0, width: 2, color: [0, 0, 0] }] });
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V5, badParent)), /parent/);
  const good = v4Payload([{ parent: 0, length: 10, angle: 0, width: 2 }]);
  await assert.throws(() => decodeStkBytes(Buffer.concat([good, Buffer.from([0])]), STK_WRAPPER_V4), /trailing/);
  const unknownV4 = v4Payload([{ parent: 0, length: 10, angle: 0, width: 2, trailing: 0 }]);
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V4, unknownV4)), /record layout/);
});

test('project validation binds imported metadata to native joints before render', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({ segments: [{ parent: 0, length: 10, angle: 0, width: 2, color: [1, 2, 3] }] })));
  const figure = lineFigureData(createFigureFromStk(decoded));
  figure.joints.pop();
  assert.throws(() => normaliseProject({ frames: [[figure]] }), /STK joint count/);
  const wrong = lineFigureData(createFigureFromStk(decoded));
  wrong.joints[1].id = 'not-stk-1';
  assert.throws(() => normaliseProject({ frames: [[wrong]] }), /STK joint binding/);
  const missingPolygons = lineFigureData(createFigureFromStk(decoded));
  delete missingPolygons.stkArtwork.polygons;
  assert.throws(() => normaliseProject({ frames: [[missingPolygons]] }), /polygon metadata/);
});

test('checks File/Blob size before reading and bounds decompression output', async () => {
  let read = false;
  await assert.rejects(() => decodeStk({ size: STK_MAX_FILE_BYTES + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }), /exceeds/);
  assert.equal(read, false);
  const bombPayload = Buffer.alloc(STK_MAX_PAYLOAD_BYTES + 1);
  const bomb = compressed(STK_WRAPPER_V4, bombPayload);
  await assert.rejects(() => decodeStk(bomb), /decompressed data exceeds/);
});
