import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  STK_MAX_FILE_BYTES, STK_MAX_PAYLOAD_BYTES, STK_MAX_SEGMENT_LENGTH, STK_MAX_SEGMENTS, STK_WRAPPER_V2, STK_WRAPPER_V3, STK_WRAPPER_V4, STK_WRAPPER_V5, createFigureFromStk, decodeStk, decodeStkBytes,
  isStkCircleSegment, isStkFilledCircleSegment, pointOnStkSegment, stkDrawnJointIds, validateStkArtwork
} from '../src/stk-import.js';
import { findDragTarget } from '../src/drag-controller.js';
import { MAX_JOINT_LENGTH, normaliseProject, serializeProject } from '../src/project.js';
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
    payload[offset + 1] = record.id ?? index + 1;
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

function v5Payload({ segments, curves = [], polygons = [], ranks = null, transparencyLayout = false }) {
  const chunks = [Buffer.from([transparencyLayout ? 0xa0 : 0xa8, segments.length & 0xff, segments.length >> 8])];
  for (const segment of segments) {
    const record = Buffer.alloc(transparencyLayout ? 24 : 23);
    record.writeUInt16LE(segment.parent, 0);
    record.writeFloatLE(segment.length, 2);
    record.writeDoubleLE(segment.angle, 6);
    record.writeFloatLE(segment.width, 14);
    record[18] = segment.type ?? 0; record[19] = segment.flag ?? 0;
    record.set(segment.color ?? [0, 0, 0], 20);
    if (transparencyLayout) record[23] = segment.transparency ?? 0;
    chunks.push(record);
  }
  const curveHeader = Buffer.alloc(2); curveHeader.writeUInt16LE(curves.length); chunks.push(curveHeader);
  for (const curve of curves) { const record = Buffer.alloc(10); record.writeUInt16LE(curve.index, 0); record.writeDoubleLE(curve.bend, 2); chunks.push(record); }
  const polygonHeader = Buffer.alloc(2); polygonHeader.writeUInt16LE(polygons.length); chunks.push(polygonHeader);
  for (const polygon of polygons) {
    const record = Buffer.alloc(6 + polygon.vertices.length * 2);
    record.writeUInt16LE(polygon.vertices.length, 0); record.set(polygon.color, 2);
    if (transparencyLayout) record[5] = polygon.transparency ?? 0;
    polygon.vertices.forEach((vertex, index) => record.writeUInt16LE(vertex, 6 + index * 2)); chunks.push(record);
  }
  const drawRanks = ranks ?? segments.map((_, index) => index);
  const tail = Buffer.alloc(drawRanks.length * 2); drawRanks.forEach((rank, index) => tail.writeUInt16LE(rank, index * 2)); chunks.push(tail);
  return Buffer.concat(chunks);
}

function a9Payload({ segments, curves = [], polygons = [], ranks = null }) {
  assert.ok(segments.length > 0);
  const header = Buffer.alloc(3);
  header[0] = 0xa9; header.writeUInt16LE(segments.length, 1);
  const chunks = [header];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // A9 is the a8 record order without the per-record type byte:
    // [parent uint16][length float32][angle float64][width float32][flag][RGB].
    const record = Buffer.alloc(22);
    record.writeUInt16LE(segment.parent, 0);
    record.writeFloatLE(segment.length, 2);
    record.writeDoubleLE(segment.angle, 6);
    record.writeFloatLE(segment.width, 14);
    record[18] = segment.flag ?? 0;
    record.set(segment.color ?? [0, 0, 0], 19);
    chunks.push(record);
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

function a88Payload({ segments, curves = [], polygons = [], ranks = null }) {
  assert.ok(segments.length > 0);
  const header = Buffer.alloc(3);
  header[0] = 0x88; header.writeUInt16LE(segments.length, 1);
  const chunks = [header];
  for (const segment of segments) {
    // 0x88 is the a8 layout plus a source-id uint16 after the parent:
    // [parent uint16][source id uint16][length float32][angle float64]
    // [width float32][type byte][flag byte][RGB bytes].
    const record = Buffer.alloc(25);
    record.writeUInt16LE(segment.parentSourceId ?? 0, 0);
    record.writeUInt16LE(segment.sourceId, 2);
    record.writeFloatLE(segment.length, 4);
    record.writeDoubleLE(segment.angle, 8);
    record.writeFloatLE(segment.width, 16);
    record[20] = segment.type ?? 0;
    record[21] = segment.flag ?? 0;
    record.set(segment.color ?? [0, 0, 0], 22);
    chunks.push(record);
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

test('decodes uncompressed Pivot 2 files as the Pivot 3 record layout with ignored padding bytes', async () => {
  // Pivot 2 leaves record padding uninitialised; library files repeat one arbitrary value per file.
  const records = [
    { parent: 0, id: 3, length: 30, angle: 0, width: 10, flag: 0, reserved: 0x0d5f, trailing: 0x0039 },
    { parent: 3, id: 1, length: 20, angle: Math.PI / 2, width: 8, flag: 1, reserved: 0x0d5f, trailing: 0x0039 },
    { parent: 1, id: 2, length: 12, angle: Math.PI, width: 6, type: 1, flag: 1, reserved: 0x0d5f, trailing: 0x0039 }
  ];
  const bytes = v3Payload(records);
  const decoded = await decodeStk(bytes);
  assert.equal(decoded.wrapper, STK_WRAPPER_V2);
  assert.equal(decoded.payloadHeader, '01');
  assert.equal(decoded.sourceBytes, bytes.length);
  assert.equal(decoded.payloadBytes, bytes.length);
  assert.deepEqual(decoded.segments.map(segment => [segment.id, segment.sourceId, segment.parent, segment.reserved, segment.trailing]), [[1, 3, 0, 0x0d5f, 0x39], [2, 1, 1, 0x0d5f, 0x39], [3, 2, 2, 0x0d5f, 0x39]]);
  assert.equal(decoded.segments[2].color, null);
  assert.ok(isStkCircleSegment(decoded, decoded.segments[2]));
  assert.equal(isStkCircleSegment(decoded, decoded.segments[0]), false);
  assert.deepEqual(decoded.warnings, ['Pivot 2 type 1 circles are rendered as hollow circles with white interiors.']);
  const figure = createFigureFromStk(decoded);
  assert.deepEqual(figure.joints.map(joint => joint.handleVisible), [true, true, false, false]);
  assert.deepEqual(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].stkArtwork, figure.stkArtwork);
  // The same payload compressed is Pivot 3, which still requires zero padding.
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V3, bytes)), /Pivot 3 segment 3 uses an unsupported record layout/);
});

test('rejects malformed Pivot 2 files with clear messages', async () => {
  const good = v3Payload([{ parent: 0, id: 1, length: 10, angle: 0, width: 2 }, { parent: 1, id: 2, length: 10, angle: 0, width: 2 }]);
  await decodeStk(good);
  await assert.rejects(() => decodeStk(good.subarray(0, -1)), /STK import rejected: Pivot 2 segment records are incomplete/);
  await assert.rejects(() => decodeStk(Buffer.concat([good, Buffer.from([0])])), /STK import rejected: Pivot 2 payload has unsupported trailing data/);
  await assert.rejects(() => decodeStk(Buffer.from([1, 0])), /STK import rejected: Pivot 2 segment count/);
  await assert.rejects(() => decodeStk(Buffer.from([1])), /STK import rejected: the file is too short/);
  const cycle = Buffer.from(good); cycle[2] = 2;
  await assert.rejects(() => decodeStk(cycle), /STK import rejected: Pivot 2 segment hierarchy contains a cycle/);
  const unknownParent = Buffer.from(good); unknownParent[26] = 9;
  await assert.rejects(() => decodeStk(unknownParent), /STK import rejected: Pivot 2 segment 2 references an unknown parent/);
  const duplicate = Buffer.from(good); duplicate[27] = 1;
  await assert.rejects(() => decodeStk(duplicate), /STK import rejected: Pivot 2 segment 2 has an invalid or duplicate source id/);
  const badType = Buffer.from(good); badType[2 + 20] = 3;
  await assert.rejects(() => decodeStk(badType), /STK import rejected: Pivot 2 segment 1 uses unsupported type 3/);
  const badWidth = Buffer.from(good); badWidth.writeFloatLE(Number.NaN, 2 + 16);
  await assert.rejects(() => decodeStk(badWidth), /STK import rejected: Pivot 2 segment 1 width is invalid/);
  const decoded = decodeStkBytes(good, STK_WRAPPER_V2);
  assert.throws(() => validateStkArtwork({ ...decoded, polygons: [{ id: 2, color: [0, 0, 0], vertices: [0, 1, 2] }], drawRanks: [0, 1, 2] }), /Pivot 2 polygon metadata is unsupported/);
  assert.throws(() => validateStkArtwork({ ...decoded, payloadHeader: null }), /Pivot 2 payload header metadata is invalid/);
  assert.throws(() => validateStkArtwork({ ...decoded, segments: [{ ...decoded.segments[0], type: 3 }, decoded.segments[1]] }), /unsupported type/);
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

test('decodes the Pivot 5 a9 a8-order layout and paints by width regardless of flag', () => {
  const payload = a9Payload({
    segments: [
      { parent: 0, length: 100, angle: 0, width: 1, flag: 0, color: [9, 9, 9] },
      { parent: 1, length: 100, angle: Math.PI / 2, width: 2.125, flag: 1, color: [230, 205, 183] },
      { parent: 0, length: 1, angle: -Math.PI / 2, width: 4, flag: 0, color: [221, 106, 40] },
      { parent: 0, length: 50, angle: Math.PI, width: 0, flag: 1, color: [0, 0, 0] }
    ],
    curves: [{ index: 0, bend: Math.PI }, { index: 1, bend: -Math.PI / 3 }],
    polygons: [{ color: [200, 100, 50], vertices: [0, 1, 3] }],
    ranks: [2, 0, 3, 1, 4]
  });
  const decoded = decodeStkBytes(payload, STK_WRAPPER_V5);
  assert.equal(decoded.payloadHeader, 'a90400');
  assert.deepEqual(decoded.segments[0].color, [9, 9, 9]);
  assert.equal(decoded.segments[0].width, 1);
  assert.equal(decoded.segments[0].flag, 0);
  assert.equal(decoded.segments[0].parent, 0);
  assert.deepEqual(decoded.segments[1].color, [230, 205, 183], 'segment 2 keeps its own style rather than the previous record');
  assert.equal(decoded.segments[1].width, 2.125);
  assert.equal(decoded.segments[1].flag, 1);
  assert.equal(decoded.segments[1].parent, 1);
  assert.equal(decoded.segments[2].parent, 0);
  assert.equal(decoded.segments[3].width, 0);
  assert.equal(decoded.segments[1].bend, -Math.PI / 3);
  assert.deepEqual(decoded.drawRanks, [2, 0, 3, 1, 4]);
  assert.equal(decoded.polygons.length, 1);
  assert.ok(decoded.warnings.some(warning => warning.includes('a9')));
  validateStkArtwork(decoded);

  const events = [];
  const stateStack = [];
  const context = {
    fillStyle: '#000000', strokeStyle: '#000000', lineCap: 'round', lineJoin: 'round', lineWidth: 1,
    save() { stateStack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineCap: this.lineCap, lineJoin: this.lineJoin, lineWidth: this.lineWidth }); },
    restore() { Object.assign(this, stateStack.pop()); }, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    fill() { events.push('fill'); }, stroke() { events.push('stroke'); }
  };
  const figure = createFigureFromStk(decoded);
  assert.equal(figure.joints.filter(joint => joint.handleVisible !== false).length, 3, 'only flag-0 segments expose controls');
  drawStkFigure({ context, figure });
  // Draw order by rank: segment 2 (flag 1, width 2.125) is painted, segment 4
  // (width 0) is skipped, then segment 1, segment 3 and the polygon render.
  assert.deepEqual(events, ['stroke', 'stroke', 'stroke', 'fill'], 'positive-width flag-1 strokes paint and zero-width strokes do not');
  const bounds = getStkArtworkBounds(createFigureFromStk(decoded, { x: 0, y: 0 }));
  assert.ok(bounds.maxX > 30, 'A9 curved paths remain in polygon bounds');
  const dragFigure = createFigureFromStk(decoded, { x: 0, y: 0 });
  dragFigure.updatePositions();
  const zeroWidth = dragFigure.joints.find(joint => joint.id === 'stk-4');
  const zeroParent = dragFigure.joints.find(joint => joint.id === zeroWidth.parentId);
  const zeroMidpoint = { x: (zeroWidth.x + zeroParent.x) / 2, y: (zeroWidth.y + zeroParent.y) / 2 };
  const distanceToSegment = (point, start, end) => {
    const dx = end.x - start.x, dy = end.y - start.y;
    const progress = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point.x - (start.x + progress * dx), point.y - (start.y + progress * dy));
  };
  assert.equal(findDragTarget({ figures: [dragFigure], position: zeroMidpoint, handleRadius: 4, distanceToSegment, isPointInSpeechBubble: () => false }), null, 'zero-width A9 construction paths are not draggable');
});

// Real-world .stk files are not committed; tests look in the project's stk/ folder, then the original developer's Downloads.
function realFixture(name) {
  return [new URL(`../stk/${name}`, import.meta.url), `/Users/crayner/Downloads/${name}`].find(candidate => fs.existsSync(candidate)) || null;
}
const sheepFixture = realFixture('sheep cartoon.440d9893 (1).stk');
const hoopFixture = realFixture('basketball hoop.812bfc5e.stk');
const spiderManFixture = realFixture('Spider-Man_Eysi.c1dee0f9.stk');

test('decodes the supplied sheep cartoon Pivot 5 a9 fixture completely', { skip: !sheepFixture }, async () => {
  const bytes = fs.readFileSync(sheepFixture);
  const decoded = await decodeStk(bytes);
  assert.equal(decoded.sourceBytes, 7252);
  assert.equal(decoded.payloadBytes, 11383);
  assert.equal(decoded.payloadHeader, 'a95601');
  assert.equal(decoded.segments.length, 342);
  assert.equal(decoded.parameters.length, 243);
  assert.equal(decoded.polygons.length, 28);
  assert.equal(decoded.drawRanks.length, 370);
  assert.equal(decoded.segments[0].parent, 0);
  assert.deepEqual(decoded.segments.reduce((counts, segment) => { counts[segment.flag] += 1; return counts; }, [0, 0]), [20, 322]);
  assert.ok(decoded.segments.some(segment => segment.width === 2.125 && segment.flag === 1 && segment.color.join(',') === '230,205,183'));
  assert.ok(decoded.segments.some(segment => segment.width === 15.75 && segment.flag === 1 && segment.color.join(',') === '224,147,60'));
  validateStkArtwork(decoded);
  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  assert.equal(figure.joints.length, 343);
  const controls = figure.joints.filter(joint => joint.handleVisible !== false);
  assert.equal(controls.length, 21, 'sheep exposes the root plus its 20 flag-0 skeleton controls');
  assert.ok(controls.some(joint => joint.id === 'stk-1'), 'the main root segment is a control');
  const bounds = getStkArtworkBounds(figure);
  assert.ok(bounds.minX > -180 && bounds.maxX < 50 && bounds.minY > -140 && bounds.maxY < 90);
});

test('decodes the supplied basketball hoop Pivot 5 a9 fixture completely', { skip: !hoopFixture }, async () => {
  const bytes = fs.readFileSync(hoopFixture);
  const decoded = await decodeStk(bytes);
  assert.equal(decoded.sourceBytes, 288);
  assert.equal(decoded.payloadBytes, 437);
  assert.equal(decoded.payloadHeader, 'a91000');
  assert.equal(decoded.segments.length, 16);
  assert.equal(decoded.parameters.length, 0);
  assert.equal(decoded.polygons.length, 3);
  assert.equal(decoded.drawRanks.length, 19);
  assert.equal(decoded.segments[0].parent, 0);
  assert.deepEqual(decoded.segments.reduce((counts, segment) => { counts[segment.flag] += 1; return counts; }, [0, 0]), [3, 13]);
  // The pole/backboard strokes are flag 1 with positive width and must paint.
  const paintedFlagOne = decoded.segments.filter(segment => segment.flag === 1 && segment.width > 0);
  assert.ok(paintedFlagOne.length >= 10, 'flag-1 positive-width structure remains paintable');
  validateStkArtwork(decoded);
  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  assert.equal(figure.joints.length, 17);
  const controls = figure.joints.filter(joint => joint.handleVisible !== false);
  assert.equal(controls.length, 4, 'basketball hoop exposes the root plus three flag-0 controls');
  const bounds = getStkArtworkBounds(figure);
  assert.ok(bounds.minY < -300 && bounds.maxY < 20, 'hoop bounds span the tall pole and base');
});

test('decodes the Pivot 5 0x88 source-id layout and remaps out-of-order ids', () => {
  const payload = a88Payload({
    segments: [
      { sourceId: 2, parentSourceId: 0, length: 100, angle: 0, width: 1, flag: 0, color: [1, 2, 3] },
      { sourceId: 1, parentSourceId: 2, length: 50, angle: Math.PI / 2, width: 2.125, flag: 1, color: [4, 5, 6] },
      { sourceId: 3, parentSourceId: 1, length: 25, angle: Math.PI, width: 0, flag: 1, color: [7, 8, 9] }
    ],
    curves: [{ index: 0, bend: 0.5 }, { index: 2, bend: -0.75 }],
    polygons: [{ color: [10, 20, 30], vertices: [0, 1, 2] }],
    ranks: [1, 2, 3, 0]
  });
  const decoded = decodeStkBytes(payload, STK_WRAPPER_V5);
  assert.equal(decoded.payloadHeader, '880300');
  assert.deepEqual(decoded.segments.map(segment => [segment.id, segment.sourceId, segment.parent]), [[1, 2, 0], [2, 1, 1], [3, 3, 2]], 'source ids remap to record order');
  assert.equal(decoded.segments[0].bend, 0.5, 'curves use 0-based record indices');
  assert.equal(decoded.segments[2].bend, -0.75);
  assert.equal(decoded.segments[1].width, 2.125);
  assert.deepEqual(decoded.drawRanks, [1, 2, 3, 0]);
  validateStkArtwork(decoded);
  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  assert.equal(figure.joints.filter(joint => joint.handleVisible !== false).length, 2, 'root plus one flag-0 segment');
});

test('rejects malformed Pivot 5 0x88 records', () => {
  const forwardParent = a88Payload({ segments: [
    { sourceId: 1, parentSourceId: 2, length: 10, angle: 0, width: 1, flag: 0, color: [1, 2, 3] },
    { sourceId: 2, parentSourceId: 0, length: 10, angle: 0, width: 1, flag: 0, color: [1, 2, 3] }
  ] });
  assert.throws(() => decodeStkBytes(forwardParent, STK_WRAPPER_V5), /forward parent/);
  const duplicateId = a88Payload({ segments: [
    { sourceId: 1, parentSourceId: 0, length: 10, angle: 0, width: 1, flag: 0, color: [1, 2, 3] },
    { sourceId: 1, parentSourceId: 0, length: 10, angle: 0, width: 1, flag: 0, color: [1, 2, 3] }
  ] });
  assert.throws(() => decodeStkBytes(duplicateId, STK_WRAPPER_V5), /duplicate source id/);
  const valid = a88Payload({ segments: [
    { sourceId: 1, parentSourceId: 0, length: 10, angle: 0, width: 1, flag: 0, color: [1, 2, 3] }
  ] });
  assert.throws(() => decodeStkBytes(valid.subarray(0, -1), STK_WRAPPER_V5), /incomplete|trailing/);
});

test('decodes the supplied Spider-Man 0x88 fixture completely', { skip: !spiderManFixture }, async () => {
  const bytes = fs.readFileSync(spiderManFixture);
  const decoded = await decodeStk(bytes);
  assert.equal(decoded.sourceBytes, 1230);
  assert.equal(decoded.payloadBytes, 1727);
  assert.equal(decoded.payloadHeader, '883c00');
  assert.equal(decoded.segments.length, 60);
  assert.equal(decoded.parameters.length, 10);
  assert.equal(decoded.polygons.length, 0);
  assert.equal(decoded.drawRanks.length, 60);
  assert.deepEqual(decoded.segments.reduce((counts, segment) => { counts[segment.type] += 1; return counts; }, [0, 0]), [59, 1]);
  assert.deepEqual(decoded.segments.reduce((counts, segment) => { counts[segment.flag] += 1; return counts; }, [0, 0]), [15, 45]);
  validateStkArtwork(decoded);
  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  assert.equal(figure.joints.length, 61);
  assert.equal(figure.joints.filter(joint => joint.handleVisible !== false).length, 16, 'root plus 15 flag-0 controls');
  const bounds = getStkArtworkBounds(figure);
  assert.ok(bounds.minY < -100 && bounds.maxY > 100 && bounds.maxX - bounds.minX < 60, 'tall thin standing figure');
});

test('rejects malformed Pivot 5 a9 style and unaccounted bytes', () => {
  const payload = a9Payload({ segments: [
    { parent: 0, length: 10, angle: 0, width: 2, flag: 0, color: [1, 2, 3] },
    { parent: 1, length: 5, angle: 0, width: 1, flag: 0, color: [4, 5, 6] }
  ] });
  const badFlag = Buffer.from(payload); badFlag[3 + 22 + 18] = 2;
  assert.throws(() => decodeStkBytes(badFlag, STK_WRAPPER_V5), /unsupported flag/);
  assert.throws(() => decodeStkBytes(payload.subarray(0, -1), STK_WRAPPER_V5), /incomplete|trailing/);
  const forwardParent = Buffer.from(payload); forwardParent.writeUInt16LE(2, 3 + 22);
  assert.throws(() => decodeStkBytes(forwardParent, STK_WRAPPER_V5), /forward or unknown parent/);
});

test('decodes the measured Pivot 5 a0 transparency layout without dropping alpha bytes', async () => {
  const payload = v5Payload({
    transparencyLayout: true,
    segments: [
      { parent: 0, length: 40, angle: 0, width: 4, color: [236, 236, 236] },
      { parent: 1, length: 20, angle: Math.PI / 2, width: 0, type: 3, flag: 1, color: [255, 255, 255], transparency: 159 }
    ],
    polygons: [{ color: [0, 0, 0], transparency: 198, vertices: [0, 1, 2] }],
    ranks: [0, 1, 2]
  });
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, payload));
  assert.equal(decoded.payloadHeader, 'a00200');
  assert.equal(decoded.segments[0].transparency, 0);
  assert.equal(decoded.segments[1].transparency, 159);
  assert.equal(decoded.polygons[0].transparency, 198);
  assert.equal(decoded.polygons[0].reserved, null);
  assert.ok(decoded.warnings.some(warning => warning.includes('transparency bytes')));
  validateStkArtwork(decoded);

  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  const events = [];
  const stateStack = [];
  const context = {
    fillStyle: '#000000', strokeStyle: '#000000', lineCap: 'round', lineWidth: 1, globalAlpha: 0.5,
    save() { stateStack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineCap: this.lineCap, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha }); },
    restore() { Object.assign(this, stateStack.pop()); }, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    fill() { events.push({ kind: 'fill', color: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { events.push({ kind: 'stroke', color: this.strokeStyle, alpha: this.globalAlpha, cap: this.lineCap }); }
  };
  drawStkFigure({ context, figure });
  assert.deepEqual(events.map(({ kind, color }) => ({ kind, color })), [
    { kind: 'stroke', color: 'rgb(236,236,236)' },
    { kind: 'fill', color: 'rgb(255,255,255)' },
    { kind: 'fill', color: 'rgb(0,0,0)' }
  ]);
  assert.equal(events[0].cap, 'round');
  assert.ok(Math.abs(events[0].alpha - 0.5) < 1e-12);
  assert.ok(Math.abs(events[1].alpha - 0.5 * (96 / 255)) < 1e-12);
  assert.ok(Math.abs(events[2].alpha - 0.5 * (57 / 255)) < 1e-12);
  assert.equal(context.globalAlpha, 0.5);
});

test('retains curved geometry for opaque polygon bounds when its source segment is fully transparent', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({
    transparencyLayout: true,
    segments: [
      { parent: 0, length: 100, angle: 0, width: 0, color: [0, 0, 0], transparency: 255 },
      { parent: 0, length: 100, angle: Math.PI, width: 1, color: [0, 0, 0], transparency: 0 }
    ],
    curves: [{ index: 0, bend: Math.PI }],
    polygons: [{ color: [10, 20, 30], transparency: 0, vertices: [0, 1, 2] }],
    ranks: [0, 1, 2]
  })));
  const figure = createFigureFromStk(decoded, { x: 0, y: 0 });
  const bounds = getStkArtworkBounds(figure);
  // The transparent half-turn arc bulges to x≈31.83 even though its endpoint
  // is at x≈0; polygon fit must include that curved boundary.
  assert.ok(bounds.maxX > 20);
});

test('rejects incomplete or mismatched V5 transparency metadata and payloads', async () => {
  const a0Payload = v5Payload({
    transparencyLayout: true,
    segments: [{ parent: 0, length: 10, angle: 0, width: 2, color: [1, 2, 3], transparency: 12 }]
  });
  const a0 = await decodeStk(compressed(STK_WRAPPER_V5, a0Payload));
  const missing = JSON.parse(JSON.stringify(a0));
  delete missing.segments[0].transparency;
  assert.throws(() => validateStkArtwork(missing), /missing its transparency byte/);
  const invalid = JSON.parse(JSON.stringify(a0));
  invalid.segments[0].transparency = 256;
  assert.throws(() => validateStkArtwork(invalid), /invalid transparency/);
  const fractional = JSON.parse(JSON.stringify(a0));
  fractional.segments[0].transparency = 1.5;
  assert.throws(() => validateStkArtwork(fractional), /invalid transparency/);

  const a8 = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({
    segments: [{ parent: 0, length: 10, angle: 0, width: 2, color: [1, 2, 3] }]
  })));
  a8.segments[0].transparency = 1;
  assert.throws(() => validateStkArtwork(a8), /unsupported transparency for its payload layout/);
  assert.throws(() => decodeStkBytes(a0Payload.slice(0, -1), STK_WRAPPER_V5), /incomplete|trailing/);
  // a1 drops the type byte, so a0-sized records no longer line up with the tables that follow.
  const misreadHeader = Buffer.from(a0Payload); misreadHeader[0] = 0xa1;
  assert.throws(() => decodeStkBytes(misreadHeader, STK_WRAPPER_V5), /STK import rejected: Pivot 5 a1/);
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
  // Pivot 3 zero-fills its record padding, so non-zero padding is still rejected there (Pivot 2 and 4 allow it).
  const paddedV3 = v3Payload([{ parent: 0, id: 1, length: 10, angle: 0, width: 2, trailing: 5 }]);
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V3, paddedV3)), /record layout/);
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

// Every real figure in stk/ (when present) must decode, draw, and survive a project save and reopen unchanged.
const realFixtureFolder = new URL('../stk/', import.meta.url);
const realStkFiles = fs.existsSync(realFixtureFolder) ? fs.readdirSync(realFixtureFolder).filter(name => name.toLowerCase().endsWith('.stk')).sort() : [];

function recordingCanvasContext() {
  const calls = [];
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineCap: 'round', lineJoin: 'round', lineWidth: 1, globalAlpha: 1 };
  const context = new Proxy(state, {
    get(target, key) { return key in target ? target[key] : (...args) => { calls.push(String(key)); return undefined; }; },
    set(target, key, value) { target[key] = value; return true; }
  });
  return { context, calls };
}

for (const name of realStkFiles) {
  test(`real figure "${name}" decodes, draws, and survives save and reopen`, async () => {
    const decoded = await decodeStk(fs.readFileSync(new URL(name, realFixtureFolder)));
    validateStkArtwork(decoded);
    const figure = createFigureFromStk(decoded, { x: 400, y: 300 });
    assert.equal(figure.joints.length, decoded.segments.length + 1);

    const { context, calls } = recordingCanvasContext();
    drawStkFigure({ context, figure });
    assert.ok(calls.includes('stroke') || calls.includes('fill'), 'the figure paints something');

    const saved = JSON.parse(JSON.stringify({ version: 5, name: 'Fixture', width: 800, height: 500, fps: 12, frames: [[figure]], delays: [1], currentFrameIndex: 0, groups: [], settings: {} }));
    const reopened = normaliseProject(saved).frames[0][0];
    assert.deepEqual(reopened.stkArtwork, JSON.parse(JSON.stringify(figure.stkArtwork)), 'imported artwork is unchanged by save and reopen');
    assert.deepEqual(reopened.joints.map(joint => [joint.id, joint.parentId]), figure.joints.map(joint => [joint.id, joint.parentId]));
    // Reopening normalises angles, which can change the last floating-point digit; anything visible would be far larger.
    reopened.joints.forEach((joint, index) => {
      assert.ok(Math.abs(joint.length - figure.joints[index].length) < 1e-9, `${joint.id} length`);
      assert.ok(Math.abs(Math.atan2(Math.sin(joint.angle - figure.joints[index].angle), Math.cos(joint.angle - figure.joints[index].angle))) < 1e-9, `${joint.id} angle`);
    });
  });
}

test('a Pivot animation (.piv) file is rejected cleanly as a figure', { skip: !fs.existsSync(new URL('DBZ-DBS Kid Goku.eb4b9e39.piv', realFixtureFolder)) }, async () => {
  await assert.rejects(() => decodeStk(fs.readFileSync(new URL('DBZ-DBS Kid Goku.eb4b9e39.piv', realFixtureFolder))), /STK import rejected/);
});

async function savedProjectWithStkFigure() {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, a88Payload({
    segments: [
      { sourceId: 2, parentSourceId: 0, length: 30, angle: 0, width: 4, color: [10, 20, 30] },
      { sourceId: 1, parentSourceId: 2, length: 20, angle: 1, width: 3, flag: 1 },
      { sourceId: 3, parentSourceId: 1, length: 10, angle: 2, width: 2 }
    ],
    curves: [{ index: 1, bend: 0.5 }],
    polygons: [{ vertices: [0, 1, 2], color: [200, 100, 50] }],
    ranks: [3, 0, 1, 2]
  })));
  const figure = createFigureFromStk(decoded, { x: 100, y: 100, id: 'hardening-figure' });
  return JSON.parse(JSON.stringify({ version: 5, name: 'Hardening', width: 800, height: 500, fps: 12, frames: [[figure]], delays: [1], currentFrameIndex: 0, groups: [], settings: {} }));
}
const artworkOf = project => project.frames[0][0].stkArtwork;

test('reopening a project drops unknown data hidden inside imported STK artwork', async () => {
  const clean = await savedProjectWithStkFigure();
  const hostile = await savedProjectWithStkFigure();
  const junk = Array.from({ length: 1000 }, (_, index) => index);
  const artwork = artworkOf(hostile);
  artwork.junk = junk;
  artwork.segments[0].junk = junk;
  artwork.polygons[0].junk = junk;
  artwork.parameters[0].junk = junk;
  const reopened = normaliseProject(hostile).frames[0][0].stkArtwork;
  assert.deepEqual(JSON.parse(JSON.stringify(reopened)), artworkOf(clean));
  assert.ok(!JSON.stringify(reopened).includes('junk'));
});

test('reopening a project rejects junk inside known but previously unchecked STK fields', async () => {
  const cases = [
    ['segment source id', artwork => { artwork.segments[0].sourceId = Array.from({ length: 1000 }, () => 1); }],
    ['segment parent source id', artwork => { artwork.segments[1].parentSourceId = { nested: true }; }],
    ['segment record index', artwork => { artwork.segments[0].index = 'x'.repeat(200); }],
    ['segment reserved bytes', artwork => { artwork.segments[0].reserved = [0, 0, 0]; }],
    ['segment trailing bytes', artwork => { artwork.segments[0].trailing = -1; }],
    ['polygon reserved byte', artwork => { artwork.polygons[0].reserved = 'x'; }],
    ['segment gradient', artwork => { artwork.segments[0].gradient = Array.from({ length: 1000 }, () => 1); }],
    ['figure trailer', artwork => { artwork.figureTrailer = [1, 2, 3, 4, 5]; }],
    ['warning count', artwork => { artwork.warnings = Array.from({ length: 33 }, () => 'warning'); }]
  ];
  for (const [label, corrupt] of cases) {
    const project = await savedProjectWithStkFigure();
    corrupt(artworkOf(project));
    assert.throws(() => normaliseProject(project), /STK import rejected/, label);
  }
});

test('decodes real-world Pivot 4 variations: any padding, flag 1, out-of-order ids and circle types 1, 3 and 4', async () => {
  // Library files carry arbitrary per-file padding values, construction (flag 1) segments and source ids out of order.
  const decoded = await decodeStk(compressed(STK_WRAPPER_V4, v4Payload([
    { parent: 0, id: 3, length: 30, angle: 0, width: 10, trailing: 0 },
    { parent: 3, id: 1, length: 20, angle: Math.PI / 2, width: 8, flag: 1, type: 1, reserved: 772, trailing: 6450 },
    { parent: 1, id: 2, length: 110, angle: Math.PI, width: 22, flag: 1, type: 4, trailing: 25 },
    { parent: 3, id: 4, length: 12, angle: 0, width: 4, type: 3 }
  ])));
  assert.equal(decoded.wrapper, STK_WRAPPER_V4);
  assert.deepEqual(decoded.segments.map(segment => [segment.id, segment.sourceId, segment.parent]), [[1, 3, 0], [2, 1, 1], [3, 2, 2], [4, 4, 1]]);
  assert.deepEqual(decoded.segments.map(segment => [segment.reserved, segment.trailing]), [[0, 0], [772, 6450], [0, 25], [0, 3133]]);
  assert.deepEqual(decoded.segments.map(segment => isStkCircleSegment(decoded, segment)), [false, true, true, true]);
  assert.deepEqual(decoded.segments.map(segment => isStkFilledCircleSegment(decoded, segment)), [false, false, false, true]);
  const figure = createFigureFromStk(decoded);
  assert.deepEqual(figure.joints.map(joint => joint.handleVisible), [true, true, false, false, true]);
  assert.deepEqual(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].stkArtwork, figure.stkArtwork);
});

test('draws circle types as measured: rings, white-interior circles and solid discs', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({ segments: [
    { parent: 0, length: 40, angle: 0, width: 6, type: 4, color: [10, 10, 10] },
    { parent: 0, length: 20, angle: 0, width: 2, type: 1, color: [20, 20, 20] },
    { parent: 0, length: 10, angle: 0, width: 0, type: 3, color: [30, 30, 30] },
    { parent: 0, length: 10, angle: 0, width: 0, type: 1, color: [40, 40, 40] }
  ] })));
  const painted = [];
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'round', lineJoin: 'round', globalAlpha: 1 };
  const stack = [];
  const context = new Proxy(state, {
    get(target, key) {
      if (key === 'save') return () => stack.push({ ...target });
      if (key === 'restore') return () => Object.assign(target, stack.pop());
      if (key === 'fill') return () => painted.push(['fill', target.fillStyle]);
      if (key === 'stroke') return () => painted.push(['stroke', target.strokeStyle, target.lineWidth]);
      if (key === 'arc') return (x, y, radius) => painted.push(['arc', radius]);
      return key in target ? target[key] : () => {};
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  drawStkFigure({ context, figure: createFigureFromStk(decoded, { x: 0, y: 0 }) });
  assert.deepEqual(painted, [
    ['arc', 20], ['stroke', 'rgb(10,10,10)', 6],                         // type 4: a ring stroked at the segment width
    ['arc', 10], ['fill', '#ffffff'], ['stroke', 'rgb(20,20,20)', 2],    // type 1: white interior, coloured outline
    ['arc', 5], ['fill', 'rgb(30,30,30)']                                // type 3: a solid disc paints even at zero width
  ]);                                                                    // a zero-width type 1 paints nothing
});

test('Pivot 5 0x88 polygons name their corners by source id', async () => {
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, a88Payload({
    segments: [
      { sourceId: 3, parentSourceId: 0, length: 10, angle: 0, width: 1 },
      { sourceId: 1, parentSourceId: 3, length: 10, angle: Math.PI / 2, width: 1 },
      { sourceId: 2, parentSourceId: 1, length: 10, angle: Math.PI, width: 1 }
    ],
    polygons: [{ vertices: [3, 1, 2], color: [1, 2, 3] }, { vertices: [0, 1, 2], color: [4, 5, 6] }],
    ranks: [0, 1, 2, 3, 4]
  })));
  // Source ids 3, 1 and 2 are records 1, 2 and 3; node 0 is the figure's root.
  assert.deepEqual(decoded.polygons.map(polygon => polygon.vertices), [[1, 2, 3], [0, 2, 3]]);
});

test('imports detailed figures up to the part cap with a warning, and rejects larger ones', async () => {
  const chain = count => v5Payload({ segments: Array.from({ length: count }, (_, index) => ({ parent: index, length: 2, angle: 0, width: 1, color: [0, 0, 0] })) });
  const decoded = await decodeStk(compressed(STK_WRAPPER_V5, chain(STK_MAX_SEGMENTS)));
  assert.equal(decoded.segments.length, STK_MAX_SEGMENTS);
  assert.ok(decoded.warnings.some(warning => /parts/.test(warning)), 'detailed figures warn that frames save a lot of data');
  const figure = createFigureFromStk(decoded);
  assert.equal(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].joints.length, STK_MAX_SEGMENTS + 1);
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V5, chain(STK_MAX_SEGMENTS + 1))), /segment count/);
});

// Builds a Pivot 5 payload whose record fields follow the header bits (see the layout table in
// src/stk-import.js).  Segment `gradient` is [R, G, B, transparency]; `trailer` is the 0x40 figure trailer.
function bitPayload({ header, segments, curves = [], polygons = [], ranks = null, trailer = null }) {
  const chunks = [Buffer.from([header, segments.length & 0xff, segments.length >> 8])];
  segments.forEach((segment, index) => {
    const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); chunks.push(bytes); };
    u16(segment.parent);
    if (!(header & 0x20)) u16(segment.sourceId ?? index + 1);
    const geometry = Buffer.alloc(16);
    geometry.writeFloatLE(segment.length, 0); geometry.writeDoubleLE(segment.angle, 4); geometry.writeFloatLE(segment.width, 12);
    chunks.push(geometry);
    if (!(header & 0x01)) chunks.push(Buffer.from([segment.type ?? 0]));
    if (!(header & 0x02)) chunks.push(Buffer.from([segment.flag ?? 0]));
    if (!(header & 0x04)) chunks.push(Buffer.from(segment.color ?? [0, 0, 0]));
    if (!(header & 0x08)) chunks.push(Buffer.from([segment.transparency ?? 0]));
    if (!(header & 0x80)) chunks.push(Buffer.from(segment.gradient ? [segment.marker ?? 1, ...segment.gradient] : [segment.marker ?? 0]));
  });
  const curveHeader = Buffer.alloc(2); curveHeader.writeUInt16LE(curves.length); chunks.push(curveHeader);
  for (const curve of curves) { const record = Buffer.alloc(10); record.writeUInt16LE(curve.index, 0); record.writeDoubleLE(curve.bend, 2); chunks.push(record); }
  const polygonHeader = Buffer.alloc(2); polygonHeader.writeUInt16LE(polygons.length); chunks.push(polygonHeader);
  for (const polygon of polygons) {
    const record = Buffer.alloc(6 + polygon.vertices.length * 2);
    record.writeUInt16LE(polygon.vertices.length, 0); record.set(polygon.color, 2); record[5] = polygon.transparency ?? 0;
    polygon.vertices.forEach((vertex, index) => record.writeUInt16LE(vertex, 6 + index * 2)); chunks.push(record);
  }
  if (!(header & 0x10)) {
    const drawRanks = ranks ?? Array.from({ length: segments.length + polygons.length }, (_, index) => index);
    const tail = Buffer.alloc(drawRanks.length * 2); drawRanks.forEach((rank, index) => tail.writeUInt16LE(rank, index * 2)); chunks.push(tail);
  }
  if (trailer) { const record = Buffer.alloc(8); record.writeFloatLE(trailer[0], 0); record.set(trailer.slice(1), 4); chunks.push(record); }
  return Buffer.concat(chunks);
}

test('restores Pivot 5 fields that the header bits omit as their defaults', () => {
  // ad = a8 | 0x04 | 0x01: no type byte and no colour, so every record is 19 bytes.
  const ad = decodeStkBytes(bitPayload({ header: 0xad, segments: [
    { parent: 0, length: 10, angle: 0, width: 2, flag: 0 },
    { parent: 1, length: 5, angle: 1, width: 3, flag: 1 }
  ] }), STK_WRAPPER_V5);
  assert.equal(ad.payloadHeader, 'ad0200');
  assert.deepEqual(ad.segments.map(segment => [segment.type, segment.flag, segment.color, segment.transparency]), [[0, 0, [0, 0, 0], 0], [0, 1, [0, 0, 0], 0]]);
  // aa = a8 | 0x02: the flag byte is omitted, the type byte is kept.
  const aa = decodeStkBytes(bitPayload({ header: 0xaa, segments: [
    { parent: 0, length: 10, angle: 0, width: 2, type: 3, color: [9, 8, 7] }
  ] }), STK_WRAPPER_V5);
  assert.deepEqual([aa.segments[0].type, aa.segments[0].flag, aa.segments[0].color], [3, 0, [9, 8, 7]]);
  // 80: source ids and segment transparency are both present.
  const x80 = decodeStkBytes(bitPayload({ header: 0x80, segments: [
    { parent: 0, sourceId: 2, length: 10, angle: 0, width: 2, transparency: 40 },
    { parent: 2, sourceId: 1, length: 5, angle: 1, width: 3 }
  ] }), STK_WRAPPER_V5);
  assert.deepEqual(x80.segments.map(segment => [segment.id, segment.parent, segment.sourceId, segment.transparency]), [[1, 0, 2, 40], [2, 1, 1, 0]]);
  for (const decoded of [ad, aa, x80]) validateStkArtwork(decoded);
  const typed = JSON.parse(JSON.stringify(ad)); typed.segments[0].type = 3;
  assert.throws(() => validateStkArtwork(typed), /unsupported type/);
  const flagged = JSON.parse(JSON.stringify(aa)); flagged.segments[0].flag = 1;
  assert.throws(() => validateStkArtwork(flagged), /unsupported flag/);
});

test('decodes Pivot 5 gradient segments and draws them as a start-to-end gradient', () => {
  const decoded = decodeStkBytes(bitPayload({ header: 0x28, segments: [
    { parent: 0, length: 10, angle: 0, width: 2, color: [0, 0, 0], gradient: [255, 0, 0, 30] },
    { parent: 1, length: 5, angle: 1, width: 3, color: [1, 2, 3] }
  ] }), STK_WRAPPER_V5);
  assert.deepEqual(decoded.segments[0].gradient, [255, 0, 0, 30]);
  assert.equal(decoded.segments[1].gradient, undefined);
  assert.ok(decoded.warnings.some(warning => /gradient/.test(warning)));
  const stops = [];
  const { context } = recordingCanvasContext();
  context.createLinearGradient = () => ({ addColorStop: (offset, color) => stops.push([offset, color]) });
  drawStkFigure({ context, figure: createFigureFromStk(decoded) });
  assert.deepEqual(stops, [[0, 'rgba(0,0,0,1)'], [1, `rgba(255,0,0,${1 - 30 / 255})`]]);
  const misplaced = JSON.parse(JSON.stringify(decoded)); misplaced.payloadHeader = 'a80200';
  assert.throws(() => validateStkArtwork(misplaced), /gradient its payload layout cannot hold/);
  const malformed = JSON.parse(JSON.stringify(decoded)); malformed.segments[0].gradient = [1, 2, 3];
  assert.throws(() => validateStkArtwork(malformed), /invalid gradient/);
  assert.throws(() => decodeStkBytes(bitPayload({ header: 0x28, segments: [{ parent: 0, length: 10, angle: 0, width: 2, marker: 2 }] }), STK_WRAPPER_V5), /gradient marker 2/);
  assert.throws(() => decodeStkBytes(bitPayload({ header: 0x28, segments: [{ parent: 0, length: 10, angle: 0, width: 2, gradient: [1, 2, 3, 4] }] }).subarray(0, 28), STK_WRAPPER_V5), /incomplete/);
});

test('reads record-order drawing, the figure outline trailer and polygon transparency', () => {
  // b8 = a8 | 0x10: no draw ranks; items draw in record order.
  const twoLines = [{ parent: 0, length: 10, angle: 0, width: 2 }, { parent: 1, length: 5, angle: 1, width: 3 }];
  const b8 = decodeStkBytes(bitPayload({ header: 0xb8, segments: twoLines }), STK_WRAPPER_V5);
  assert.deepEqual(b8.drawRanks, [0, 1]);
  assert.throws(() => decodeStkBytes(bitPayload({ header: 0xb8, segments: twoLines, polygons: [{ color: [1, 2, 3], vertices: [0, 1, 2] }] }), STK_WRAPPER_V5), /omits the draw order of its polygons/);
  // e8 = a8 | 0x40: an 8-byte outline trailer [thickness float32][RGB][transparency] after the ranks.
  const e8 = decodeStkBytes(bitPayload({ header: 0xe8, segments: [{ parent: 0, length: 10, angle: 0, width: 2 }], trailer: [2, 0, 255, 0, 0] }), STK_WRAPPER_V5);
  assert.deepEqual(e8.figureTrailer, [2, 0, 255, 0, 0]);
  const plain = { ...e8, payloadHeader: 'a80100' }; delete plain.figureTrailer;
  validateStkArtwork(plain);
  assert.equal(getStkArtworkBounds(createFigureFromStk(e8)).maxX - getStkArtworkBounds(createFigureFromStk(plain)).maxX, 2);
  assert.throws(() => validateStkArtwork({ ...plain, figureTrailer: [2, 0, 0, 0, 0] }), /figure trailer metadata does not match/);
  assert.throws(() => validateStkArtwork({ ...e8, figureTrailer: [Infinity, 0, 0, 0, 0] }), /figure trailer metadata is malformed/);
  assert.throws(() => decodeStkBytes(bitPayload({ header: 0xe8, segments: [{ parent: 0, length: 10, angle: 0, width: 2 }] }), STK_WRAPPER_V5), /trailing draw-order data/);
  // The polygon transparency byte is read in every layout, including a8 where segments have none.
  const a8 = decodeStkBytes(bitPayload({ header: 0xa8, segments: twoLines, polygons: [{ color: [1, 2, 3], vertices: [0, 1, 2], transparency: 200 }] }), STK_WRAPPER_V5);
  assert.deepEqual([a8.polygons[0].transparency, a8.polygons[0].reserved], [200, 0]);
  validateStkArtwork(a8);
});

test('imports Pivot slider arms, saves and reopens them, and keeps hand-made joints to the normal limit', async () => {
  // An invisible arm runs 500,000 units out and its child comes straight back, so the visible part
  // hangs near the root and moves in a nearly straight line when the returning arm is turned.
  const slider = v5Payload({ segments: [
    { parent: 0, length: 500000, angle: 0, width: 0, flag: 1 },
    { parent: 1, length: 500000, angle: Math.PI + 0.0001, width: 0 },
    { parent: 2, length: 20, angle: Math.PI / 2, width: 4 }
  ] });
  const figure = createFigureFromStk(await decodeStk(compressed(STK_WRAPPER_V5, slider)), { x: 0, y: 0 });
  figure.updatePositions();
  const bounds = getStkArtworkBounds(figure);
  assert.ok(bounds.maxX - bounds.minX < 10 && bounds.maxY - bounds.minY < 30, 'the invisible arms do not count towards the figure size');
  assert.deepEqual([...stkDrawnJointIds(figure.stkArtwork)], ['stk-2', 'stk-3'], 'nor towards a group outline');
  const part = () => figure.joints.find(joint => joint.id === 'stk-3');
  const before = { x: part().x, y: part().y };
  figure.joints.find(joint => joint.id === 'stk-2').angle += 0.00001;
  figure.updatePositions();
  assert.ok(Math.abs(part().x - before.x) < 0.01 && Math.abs(Math.abs(part().y - before.y) - 5) < 0.01, 'the part slides 5 units in a straight line');

  const state = { frames: [[figure]], frameDelays: [1], groups: [], docWidth: 800, docHeight: 500, fps: 12, currentFrameIndex: 0 };
  const reopened = normaliseProject(JSON.parse(JSON.stringify(serializeProject(state)))).frames[0][0];
  assert.equal(reopened.joints.find(joint => joint.id === 'stk-1').length, 500000);
  assert.equal(normaliseProject({ frames: [[lineFigureData(figure)]] }).frames[0][0].joints.length, 4, 'version 5 files with full joint lists reopen too');

  const tooLong = v5Payload({ segments: [{ parent: 0, length: STK_MAX_SEGMENT_LENGTH * 1.5, angle: 0, width: 0 }] });
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V5, tooLong)), /length is invalid/);
  const handMade = { id: 'drawn', x: 0, y: 0, joints: [{ id: 'root', parentId: null, length: 0, angle: 0 }, { id: 'arm', parentId: 'root', length: MAX_JOINT_LENGTH + 1, angle: 0 }] };
  assert.throws(() => normaliseProject({ frames: [[handMade]] }), /joint length/);
});

test('draws tied Pivot 5 draw ranks in record order and accepts bends up to 1.99π', async () => {
  const three = [0, 1, 2].map(index => ({ parent: index, length: 10, angle: 0, width: 2 }));
  // Items 0 and 1 share rank 1 and rank 2 is unused, as in a few library files.
  const tied = await decodeStk(compressed(STK_WRAPPER_V5, v5Payload({ segments: three, ranks: [1, 1, 0] })));
  assert.deepEqual(tied.drawRanks, [1, 2, 0]);
  assert.ok(tied.warnings.some(warning => /same place/.test(warning)));
  validateStkArtwork(tied);
  await assert.rejects(() => decodeStk(compressed(STK_WRAPPER_V5, v5Payload({ segments: three, ranks: [0, 1, 3] }))), /not a complete permutation/);

  const bent = bend => compressed(STK_WRAPPER_V5, v5Payload({ segments: [{ parent: 0, length: 25, angle: 0, width: 2 }], curves: [{ index: 0, bend }] }));
  const nearlyFull = await decodeStk(bent(-1.98 * Math.PI));
  assert.ok(Number.isFinite(getStkArtworkBounds(createFigureFromStk(nearlyFull)).maxX));
  await assert.rejects(() => decodeStk(bent(1.995 * Math.PI)), /bend is invalid/);
});
