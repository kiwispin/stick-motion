import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  STK_MAX_FILE_BYTES, STK_MAX_PAYLOAD_BYTES, STK_WRAPPER_V3, STK_WRAPPER_V4, STK_WRAPPER_V5, createFigureFromStk, decodeStk, decodeStkBytes,
  isStkCircleSegment, pointOnStkSegment, validateStkArtwork
} from '../src/stk-import.js';
import { findDragTarget } from '../src/drag-controller.js';
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

test('decodes the supplied sheep cartoon Pivot 5 a9 fixture completely', { skip: !fs.existsSync('/Users/crayner/Downloads/sheep cartoon.440d9893 (1).stk') }, async () => {
  const bytes = fs.readFileSync('/Users/crayner/Downloads/sheep cartoon.440d9893 (1).stk');
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

test('decodes the supplied basketball hoop Pivot 5 a9 fixture completely', { skip: !fs.existsSync('/Users/crayner/Downloads/basketball hoop.812bfc5e.stk') }, async () => {
  const bytes = fs.readFileSync('/Users/crayner/Downloads/basketball hoop.812bfc5e.stk');
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

test('decodes the supplied Spider-Man 0x88 fixture completely', { skip: !fs.existsSync('/Users/crayner/Downloads/Spider-Man_Eysi.c1dee0f9.stk') }, async () => {
  const bytes = fs.readFileSync('/Users/crayner/Downloads/Spider-Man_Eysi.c1dee0f9.stk');
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
  const unknownHeader = Buffer.from(a0Payload); unknownHeader[0] = 0xa1;
  assert.throws(() => decodeStkBytes(unknownHeader, STK_WRAPPER_V5), /unsupported Pivot 5 payload header/);
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
