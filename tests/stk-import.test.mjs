import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  STK_MAX_FILE_BYTES, STK_MAX_PAYLOAD_BYTES, STK_WRAPPER_V3, STK_WRAPPER_V4, STK_WRAPPER_V5, createFigureFromStk, decodeStk, decodeStkBytes,
  isStkCircleSegment, pointOnStkSegment, validateStkArtwork
} from '../src/stk-import.js';
import { normaliseProject } from '../src/project.js';
import { drawStkFigure, getStkArtworkBounds } from '../src/stk-renderer.js';

function compressed(wrapper, payload) {
  const stream = zlib.deflateSync(Buffer.from(payload));
  return wrapper === STK_WRAPPER_V3 ? stream : Buffer.concat([Buffer.from([wrapper]), stream]);
}

function v3Payload(records, header = 1) {
  const payload = Buffer.alloc(2 + records.length * 24);
  payload[0] = header; payload[1] = records.length;
  records.forEach((record, index) => {
    const offset = 2 + index * 24;
    payload[offset] = record.parent;
    payload[offset + 1] = record.id;
    payload.writeUInt16LE(record.reserved ?? 0, offset + 2);
    payload.writeFloatLE(record.length, offset + 4);
    payload.writeDoubleLE(record.angle, offset + 8);
    payload.writeFloatLE(record.width, offset + 16);
    payload[offset + 20] = record.type ?? 0;
    payload[offset + 21] = record.flag ?? 0;
    payload.writeUInt16LE(record.trailing ?? 0, offset + 22);
  });
  return payload;
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

test('decodes Pivot 3 source ids in record draw order and preserves its legacy type-1 circle', async () => {
  const bytes = compressed(STK_WRAPPER_V3, v3Payload([
    { parent: 0, id: 3, length: 30, angle: 0, width: 10, flag: 0 },
    { parent: 3, id: 1, length: 20, angle: Math.PI / 2, width: 8, flag: 1 },
    { parent: 1, id: 2, length: 12, angle: Math.PI, width: 6, type: 1, flag: 1 }
  ]));
  const decoded = await decodeStk(bytes);
  assert.equal(decoded.wrapper, STK_WRAPPER_V3);
  assert.equal(decoded.payloadHeader, '01');
  assert.deepEqual(decoded.segments.map(segment => [segment.id, segment.sourceId, segment.parent]), [[1, 3, 0], [2, 1, 1], [3, 2, 2]]);
  assert.deepEqual(decoded.drawRanks, [0, 1, 2]);
  assert.equal(decoded.segments[2].color, null);
  const figure = createFigureFromStk(decoded);
  figure.updatePositions();
  assert.deepEqual(figure.joints.map(joint => [joint.id, joint.parentId]), [['stk-root', null], ['stk-1', 'stk-root'], ['stk-2', 'stk-1'], ['stk-3', 'stk-2']]);
  assert.equal(figure.joints[3].handleVisible, false);
  validateStkArtwork(decoded);
  assert.deepEqual(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].stkArtwork, figure.stkArtwork);
});

test('topologically orders Pivot 3 forward-parent records while preserving source draw ranks', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V3, v3Payload([
    { parent: 1, id: 2, length: 10, angle: 0, width: 2 },
    { parent: 0, id: 1, length: 10, angle: 0, width: 2 }
  ])));
  assert.deepEqual(decoded.segments.map(segment => [segment.sourceId, segment.parent]), [[1, 0], [2, 1]]);
  assert.deepEqual(decoded.drawRanks, [1, 0]);
});

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

test('accepts measured V5 type-6 lines and type-1/type-3 wheel circles', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({
    segments: [
      { parent: 0, length: 20, angle: 0, width: 2, type: 6, color: [10, 20, 30] },
      { parent: 1, length: 10, angle: Math.PI / 2, width: 3, type: 1, color: [40, 50, 60] },
      { parent: 2, length: 8, angle: -Math.PI / 2, width: 0, type: 3, color: [70, 80, 90] }
    ]
  })));
  assert.deepEqual(decoded.segments.map(segment => segment.type), [6, 1, 3]);
  assert.ok(decoded.warnings.some(warning => warning.includes('Type 6 line caps')));
  assert.ok(isStkCircleSegment(decoded, decoded.segments[1]));
  assert.ok(isStkCircleSegment(decoded, decoded.segments[2]));
  assert.equal(isStkCircleSegment(decoded, decoded.segments[0]), false);
  const figure = createFigureFromStk(decoded);
  figure.updatePositions();
  assert.equal(figure.joints.length, 4);
  validateStkArtwork(figure.stkArtwork);
  const events = [];
  const stateStack = [];
  const context = {
    fillStyle: '#000000', strokeStyle: '#000000', lineCap: 'round', lineWidth: 1,
    save() { stateStack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineCap: this.lineCap, lineWidth: this.lineWidth }); },
    restore() { Object.assign(this, stateStack.pop()); }, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    fill() { events.push({ kind: 'fill', color: this.fillStyle }); },
    stroke() { events.push({ kind: 'stroke', color: this.strokeStyle, cap: this.lineCap }); }
  };
  drawStkFigure({ context, figure });
  assert.deepEqual(events, [
    { kind: 'stroke', color: 'rgb(10,20,30)', cap: 'square' },
    { kind: 'fill', color: '#ffffff' },
    { kind: 'stroke', color: 'rgb(40,50,60)', cap: 'round' },
    { kind: 'fill', color: 'rgb(70,80,90)' }
  ]);
});

test('includes the square-cap corner envelope for V5 type-6 bounds', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({
    segments: [{ parent: 0, length: 10, angle: Math.PI / 4, width: 4, type: 6, color: [1, 2, 3] }]
  })));
  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  const bounds = getStkArtworkBounds(figure);
  const endpoint = 10 / Math.sqrt(2);
  assert.ok(bounds.maxX >= endpoint + Math.SQRT2 * 2 - 1e-8);
  assert.ok(bounds.maxY >= endpoint + Math.SQRT2 * 2 - 1e-8);
});

test('extends the joint bound only for validated imported figures', async () => {
  const segments = Array.from({ length: 100 }, (_, index) => ({ parent: index, length: 1, angle: 0, width: 1, color: [1, 1, 1] }));
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({ segments })));
  const figure = createFigureFromStk(decoded);
  assert.equal(figure.joints.length, 101);
  assert.equal(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].joints.length, 101);
});

test('rejects unsupported types, malformed parents, trailing sections and source layouts', async () => {
  const unsupported = v5Payload({ segments: [{ parent: 0, length: 10, angle: 0, width: 2, type: 5, color: [0, 0, 0] }] });
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
