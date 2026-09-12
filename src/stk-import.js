import { Figure, Joint, SEGMENT_LINE } from './models.js';

// STK is a compressed binary format.  The importer deliberately accepts only
// the Pivot 3, Pivot 4 and two measured Pivot 5 layouts reverse-engineered from
// local samples.  A file that does not match one of those complete layouts
// fails before a Figure is created; no unsupported feature is silently discarded.
export const STK_WRAPPER_V3 = 0x78;
export const STK_WRAPPER_V4 = 0x79;
export const STK_WRAPPER_V5 = 0x7a;
export const STK_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const STK_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const STK_MAX_SEGMENTS = 512;
export const STK_MAX_POLYGONS = 512;
export const STK_MAX_POLYGON_VERTICES = 16384;
export const STK_MAX_DRAW_ITEMS = STK_MAX_SEGMENTS + STK_MAX_POLYGONS;
export const MAX_IMPORTED_JOINTS_PER_FIGURE = STK_MAX_SEGMENTS + 1;
// Keep the radius reconstruction bounded away from the 2π singularity.  The
// supplied Owl's largest bend is ~3.173 rad, comfortably inside this bound.
export const STK_MAX_ABS_BEND = 1.95 * Math.PI;
export const STK_MAX_SEGMENT_LENGTH = 10000;
export const STK_MAX_SEGMENT_WIDTH = 500;
const EPSILON = 1e-8;

export function isStkCircleSegment(artwork, segment) {
  return Boolean(segment && ((artwork?.wrapper === STK_WRAPPER_V3 && segment.type === 1) ||
    (artwork?.wrapper === STK_WRAPPER_V4 && segment.type === 3) ||
    (artwork?.wrapper === STK_WRAPPER_V5 && (segment.type === 1 || segment.type === 3))));
}

function fail(message) {
  throw new Error(`STK import rejected: ${message}`);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('the selected value is not binary data.');
}

async function readBinary(value) {
  if (value && typeof value.arrayBuffer === 'function') return asBytes(await value.arrayBuffer());
  return asBytes(value);
}

async function inflateBounded(compressed, maxBytes = STK_MAX_PAYLOAD_BYTES) {
  if (typeof DecompressionStream !== 'function') {
    fail('this browser does not provide bounded deflate decompression.');
  }
  let stream;
  try {
    const source = new Blob([compressed]).stream();
    stream = source.pipeThrough(new DecompressionStream('deflate'));
  } catch (error) {
    fail(`deflate decompression is unavailable (${error?.message || 'unsupported'}).`);
  }
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail('decompressor returned invalid data.');
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        fail(`decompressed data exceeds the ${maxBytes.toLocaleString()} byte safety limit.`);
      }
      parts.push(next.value);
    }
  } catch (error) {
    if (String(error?.message || '').startsWith('STK import rejected:')) throw error;
    fail(`the compressed payload could not be decompressed (${error?.message || 'invalid stream'}).`);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function ensureBytes(payload, offset, count, label) {
  if (offset < 0 || count < 0 || offset + count > payload.byteLength) fail(`the ${label} section is incomplete.`);
}

function finiteNumber(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label} is invalid.`);
  return value;
}

function readRgb(payload, offset, label) {
  ensureBytes(payload, offset, 3, label);
  return [payload[offset], payload[offset + 1], payload[offset + 2]];
}

function validateRgb(color, label) {
  if (!Array.isArray(color) || color.length !== 3 || color.some(value => !Number.isInteger(value) || value < 0 || value > 255)) fail(`${label} has an invalid colour.`);
  return [...color];
}

function parseV3(payload) {
  ensureBytes(payload, 0, 2, 'Pivot 3 header');
  if (payload[0] !== 1) fail(`unsupported Pivot 3 payload header ${payload[0].toString(16).padStart(2, '0')}.`);
  const segmentCount = payload[1];
  if (segmentCount < 1 || segmentCount > 255) fail('Pivot 3 segment count is outside the supported range.');
  const expectedBytes = 2 + segmentCount * 24;
  if (payload.byteLength < expectedBytes) fail('Pivot 3 segment records are incomplete.');
  if (payload.byteLength > expectedBytes) fail('Pivot 3 payload has unsupported trailing data.');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sourceSegments = [];
  const sourceIds = new Set();
  const sourceIdToRecord = new Map();
  for (let index = 0; index < segmentCount; index += 1) {
    const offset = 2 + index * 24;
    const parentSourceId = payload[offset];
    const sourceId = payload[offset + 1];
    const reserved = view.getUint16(offset + 2, true);
    const length = view.getFloat32(offset + 4, true);
    const angle = view.getFloat64(offset + 8, true);
    const width = view.getFloat32(offset + 16, true);
    const type = payload[offset + 20];
    const flag = payload[offset + 21];
    const trailing = view.getUint16(offset + 22, true);
    if (sourceId < 1 || sourceId > segmentCount || sourceIds.has(sourceId)) fail(`Pivot 3 segment ${index + 1} has an invalid or duplicate source id.`);
    if (reserved !== 0 || trailing !== 0) fail(`Pivot 3 segment ${sourceId} uses an unsupported record layout.`);
    finiteNumber(length, `Pivot 3 segment ${sourceId} length`, 0, STK_MAX_SEGMENT_LENGTH);
    finiteNumber(angle, `Pivot 3 segment ${sourceId} angle`, -1000000, 1000000);
    finiteNumber(width, `Pivot 3 segment ${sourceId} width`, 0, STK_MAX_SEGMENT_WIDTH);
    if (type !== 0 && type !== 1) fail(`Pivot 3 segment ${sourceId} uses unsupported type ${type}.`);
    if (flag !== 0 && flag !== 1) fail(`Pivot 3 segment ${sourceId} uses unsupported flag ${flag}.`);
    sourceIds.add(sourceId);
    sourceIdToRecord.set(sourceId, index);
    sourceSegments.push({ index, sourceId, parentSourceId, length, angle, bend: 0, width, type, flag,
      // Pivot 3 has no colour field; type 1's legacy hollow-circle renderer
      // supplies its white interior and black outline.
      color: null, reserved, trailing });
  }
  sourceSegments.forEach(segment => {
    if (segment.parentSourceId !== 0 && !sourceIds.has(segment.parentSourceId)) fail(`Pivot 3 segment ${segment.sourceId} references an unknown parent.`);
  });

  // Keep the file's drawing order whenever its parent records already precede
  // their children.  If a future V3 file has forward parent references, use a
  // stable topological order for the rig and retain source order in drawRanks.
  const recordOrderValid = sourceSegments.every(segment => segment.parentSourceId === 0 ||
    sourceIdToRecord.get(segment.parentSourceId) < segment.index);
  let orderedSourceSegments;
  if (recordOrderValid) {
    orderedSourceSegments = sourceSegments;
  } else {
    const children = new Map(sourceSegments.map(segment => [segment.sourceId, []]));
    const indegree = new Map(sourceSegments.map(segment => [segment.sourceId, segment.parentSourceId === 0 ? 0 : 1]));
    sourceSegments.forEach(segment => { if (segment.parentSourceId !== 0) children.get(segment.parentSourceId).push(segment); });
    const queue = sourceSegments.filter(segment => indegree.get(segment.sourceId) === 0);
    const sorted = [];
    while (queue.length) {
      queue.sort((a, b) => a.index - b.index);
      const segment = queue.shift();
      sorted.push(segment);
      for (const child of children.get(segment.sourceId)) {
        indegree.set(child.sourceId, indegree.get(child.sourceId) - 1);
        if (indegree.get(child.sourceId) === 0) queue.push(child);
      }
    }
    if (sorted.length !== sourceSegments.length) fail('Pivot 3 segment hierarchy contains a cycle.');
    orderedSourceSegments = sorted;
  }
  const internalIdBySourceId = new Map(orderedSourceSegments.map((segment, index) => [segment.sourceId, index + 1]));
  const segments = orderedSourceSegments.map((source, index) => ({
    ...source,
    id: index + 1,
    parent: source.parentSourceId === 0 ? 0 : internalIdBySourceId.get(source.parentSourceId)
  }));
  const drawRanks = segments.map(segment => sourceIdToRecord.get(segment.sourceId));
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper: STK_WRAPPER_V3,
    payloadHeader: '01', segments, polygons: [], drawRanks,
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: segments.some(segment => segment.type === 1)
      ? ['Pivot 3 type 1 circles are rendered as hollow circles with white interiors.'] : []
  };
}

export function endpointFor(segment, start) {
  const { length: length, angle, bend = 0 } = segment;
  if (Math.abs(bend) < EPSILON) return { x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle) };
  return {
    x: start.x + length * (Math.sin(angle + bend) - Math.sin(angle)) / bend,
    y: start.y + length * (Math.cos(angle) - Math.cos(angle + bend)) / bend
  };
}

function parseV4(payload) {
  ensureBytes(payload, 0, 1, 'Pivot 4 header');
  const segmentCount = payload[0];
  if (segmentCount < 1 || segmentCount > 255) fail('Pivot 4 segment count is outside the supported range.');
  const expectedBytes = 1 + segmentCount * 24;
  if (payload.byteLength < expectedBytes) fail('Pivot 4 segment records are incomplete.');
  if (payload.byteLength > expectedBytes) fail('Pivot 4 payload has unsupported trailing data.');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const offset = 1 + index * 24;
    const parent = payload[offset];
    const id = payload[offset + 1];
    const reserved = view.getUint16(offset + 2, true);
    const length = view.getFloat32(offset + 4, true);
    const angle = view.getFloat64(offset + 8, true);
    const width = view.getFloat32(offset + 16, true);
    const type = payload[offset + 20];
    const flag = payload[offset + 21];
    const trailing = view.getUint16(offset + 22, true);
    if (id !== index + 1) fail(`Pivot 4 segment ${index + 1} has a non-sequential id.`);
    if (parent > index) fail(`Pivot 4 segment ${id} has a forward or unknown parent.`);
    finiteNumber(length, `Pivot 4 segment ${id} length`, 0, STK_MAX_SEGMENT_LENGTH);
    finiteNumber(angle, `Pivot 4 segment ${id} angle`, -1000000, 1000000);
    finiteNumber(width, `Pivot 4 segment ${id} width`, 0, STK_MAX_SEGMENT_WIDTH);
    if (type !== 0 && type !== 3) fail(`Pivot 4 segment ${id} uses unsupported type ${type}.`);
    if (flag !== 0) fail(`Pivot 4 segment ${id} uses unsupported flag ${flag}.`);
    if (reserved !== 0 || trailing !== 3133) fail(`Pivot 4 segment ${id} uses an unsupported record layout.`);
    // The two unlabelled fields are retained for forensic round trips.  They
    // are not interpreted as a feature and therefore do not affect rendering.
    segments.push({ id, parent, length, angle, bend: 0, width, type, flag, color: null, reserved, trailing });
  }
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper: STK_WRAPPER_V4,
    payloadHeader: null, segments, polygons: [], drawRanks: segments.map((_, index) => index),
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: segments.some(segment => segment.type === 3)
      ? ['Pivot 4 circle segments are rendered from their endpoint pair using the measured filled-circle mapping.'] : []
  };
}

function parseV5(payload) {
  ensureBytes(payload, 0, 3, 'Pivot 5 header');
  const hasTransparency = payload[0] === 0xa0;
  if (payload[0] !== 0xa8 && !hasTransparency) fail(`unsupported Pivot 5 payload header ${Array.from(payload.subarray(0, 3)).map(value => value.toString(16).padStart(2, '0')).join('')}.`);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const segmentCount = view.getUint16(1, true);
  if (segmentCount < 1 || segmentCount > STK_MAX_SEGMENTS) fail('Pivot 5 segment count is outside the supported range.');
  let offset = 3;
  const segmentRecordBytes = hasTransparency ? 24 : 23;
  ensureBytes(payload, offset, segmentCount * segmentRecordBytes, 'Pivot 5 segment records');
  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const record = offset;
    const parent = view.getUint16(record, true);
    const length = view.getFloat32(record + 2, true);
    const angle = view.getFloat64(record + 6, true);
    const width = view.getFloat32(record + 14, true);
    const type = payload[record + 18];
    const flag = payload[record + 19];
    const color = readRgb(payload, record + 20, `Pivot 5 segment ${index + 1}`);
    if (parent > index) fail(`Pivot 5 segment ${index + 1} has a forward or unknown parent.`);
    finiteNumber(length, `Pivot 5 segment ${index + 1} length`, 0, STK_MAX_SEGMENT_LENGTH);
    finiteNumber(angle, `Pivot 5 segment ${index + 1} angle`, -1000000, 1000000);
    finiteNumber(width, `Pivot 5 segment ${index + 1} width`, 0, STK_MAX_SEGMENT_WIDTH);
    if (![0, 1, 3, 4, 6].includes(type)) fail(`Pivot 5 segment ${index + 1} uses unsupported type ${type}.`);
    if (flag !== 0 && flag !== 1) fail(`Pivot 5 segment ${index + 1} uses unsupported flag ${flag}.`);
    const transparency = hasTransparency ? payload[record + 23] : 0;
    segments.push({ id: index + 1, parent, length, angle, bend: 0, width, type, flag, color, transparency });
    offset += segmentRecordBytes;
  }

  ensureBytes(payload, offset, 2, 'Pivot 5 curve count');
  const curveCount = view.getUint16(offset, true); offset += 2;
  if (curveCount > segmentCount) fail('Pivot 5 curve count exceeds the segment count.');
  const seenCurves = new Set();
  const parameters = [];
  for (let index = 0; index < curveCount; index += 1) {
    ensureBytes(payload, offset, 10, 'Pivot 5 curve records');
    const segmentIndex = view.getUint16(offset, true);
    const bend = view.getFloat64(offset + 2, true);
    if (segmentIndex >= segmentCount) fail(`Pivot 5 curve ${index + 1} references an unknown segment.`);
    if (seenCurves.has(segmentIndex)) fail(`Pivot 5 curve records contain a duplicate segment ${segmentIndex + 1}.`);
    finiteNumber(bend, `Pivot 5 curve ${index + 1} bend`, -STK_MAX_ABS_BEND, STK_MAX_ABS_BEND);
    seenCurves.add(segmentIndex);
    segments[segmentIndex].bend = bend;
    parameters.push({ index: segmentIndex, segmentId: segmentIndex + 1, value: bend });
    offset += 10;
  }

  ensureBytes(payload, offset, 2, 'Pivot 5 polygon count');
  const polygonCount = view.getUint16(offset, true); offset += 2;
  if (polygonCount > STK_MAX_POLYGONS) fail('Pivot 5 polygon count is outside the supported range.');
  const polygons = [];
  let totalVertices = 0;
  for (let index = 0; index < polygonCount; index += 1) {
    ensureBytes(payload, offset, 6, 'Pivot 5 polygon header');
    const vertexCount = view.getUint16(offset, true);
    const color = readRgb(payload, offset + 2, `Pivot 5 polygon ${index + 1}`);
    const transparency = hasTransparency ? payload[offset + 5] : 0;
    const reserved = hasTransparency ? null : payload[offset + 5];
    if (!hasTransparency && reserved !== 0) fail(`Pivot 5 polygon ${index + 1} uses an unsupported colour/reserved byte.`);
    if (vertexCount < 3 || vertexCount > STK_MAX_POLYGON_VERTICES) fail(`Pivot 5 polygon ${index + 1} has an invalid vertex count.`);
    totalVertices += vertexCount;
    if (totalVertices > STK_MAX_POLYGON_VERTICES) fail('Pivot 5 polygon vertices exceed the safety limit.');
    offset += 6;
    ensureBytes(payload, offset, vertexCount * 2, 'Pivot 5 polygon vertices');
    const vertices = [];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const reference = view.getUint16(offset, true);
      if (reference > segmentCount) fail(`Pivot 5 polygon ${index + 1} references an unknown node.`);
      if (vertex > 0 && vertices[vertex - 1] === reference) fail(`Pivot 5 polygon ${index + 1} repeats an adjacent node.`);
      vertices.push(reference); offset += 2;
    }
    if (vertices[0] === vertices[vertices.length - 1]) fail(`Pivot 5 polygon ${index + 1} repeats its closing node.`);
    polygons.push({ id: segmentCount + index, color, vertices, transparency, reserved });
  }

  const itemCount = segmentCount + polygonCount;
  if (itemCount > STK_MAX_DRAW_ITEMS) fail('Pivot 5 draw-item count is outside the supported range.');
  const remaining = payload.byteLength - offset;
  if (remaining !== itemCount * 2) fail('Pivot 5 payload has incomplete or unsupported trailing draw-order data.');
  const drawRanks = [];
  const rankSet = new Set();
  for (let index = 0; index < itemCount; index += 1) {
    const rank = view.getUint16(offset, true); offset += 2;
    if (rank >= itemCount || rankSet.has(rank)) fail('Pivot 5 draw ranks are not a complete permutation.');
    rankSet.add(rank); drawRanks.push(rank);
  }
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper: STK_WRAPPER_V5,
    payloadHeader: Array.from(payload.subarray(0, 3)).map(value => value.toString(16).padStart(2, '0')).join(''), segments, parameters, polygons, drawRanks,
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: [
      ...(hasTransparency && (segments.some(segment => segment.transparency > 0) || polygons.some(polygon => polygon.transparency > 0))
        ? ['Pivot 5 transparency bytes are preserved and composited over the existing canvas alpha.'] : []),
      ...(segments.some(segment => segment.type === 4)
        ? ['Type 4 cap style is approximated with round caps in this experimental import.'] : []),
      ...(segments.some(segment => segment.type === 6)
        ? ['Type 6 line caps are approximated with square caps from the supplied V5 reference geometry; the numeric enum is not documented.'] : []),
      ...(segments.some(segment => segment.type === 1 || segment.type === 3)
        ? ['V5 type 1 and type 3 circles use the tentative white-interior/solid-fill mapping; other circle fill variants are not established.'] : [])
    ]
  };
}

export function validateStkArtwork(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 'pivot-stk' || value.schemaVersion !== 1) fail('the imported artwork metadata is malformed.');
  if (value.wrapper !== STK_WRAPPER_V3 && value.wrapper !== STK_WRAPPER_V4 && value.wrapper !== STK_WRAPPER_V5) fail('the imported artwork wrapper is unsupported.');
  if (!Number.isInteger(value.sourceBytes) || value.sourceBytes < 0 || value.sourceBytes > STK_MAX_FILE_BYTES || !Number.isInteger(value.payloadBytes) || value.payloadBytes < 1 || value.payloadBytes > STK_MAX_PAYLOAD_BYTES) fail('the imported source-size metadata is invalid.');
  if (value.wrapper === STK_WRAPPER_V3 && value.payloadHeader !== '01') fail('the Pivot 3 payload header metadata is invalid.');
  if (value.wrapper === STK_WRAPPER_V4 && value.payloadHeader !== null) fail('the Pivot 4 payload header metadata is invalid.');
  if (value.wrapper === STK_WRAPPER_V5 && (typeof value.payloadHeader !== 'string' || !/^(?:a0|a8)[0-9a-f]{4}$/.test(value.payloadHeader))) fail('the Pivot 5 payload header metadata is invalid.');
  const hasV5Transparency = value.wrapper === STK_WRAPPER_V5 && value.payloadHeader.startsWith('a0');
  if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > STK_MAX_SEGMENTS) fail('the imported segment metadata count is invalid.');
  const segments = value.segments;
  const ids = new Set();
  segments.forEach((segment, index) => {
    if (!segment || typeof segment !== 'object' || segment.id !== index + 1 || ids.has(segment.id)) fail('imported segment ids are not unique and sequential.');
    ids.add(segment.id);
    if (!Number.isInteger(segment.parent) || segment.parent < 0 || segment.parent > index) fail(`imported segment ${index + 1} has an invalid parent.`);
    finiteNumber(Number(segment.length), `imported segment ${index + 1} length`, 0, STK_MAX_SEGMENT_LENGTH);
    finiteNumber(Number(segment.angle), `imported segment ${index + 1} angle`, -1000000, 1000000);
    finiteNumber(Number(segment.bend), `imported segment ${index + 1} bend`, -STK_MAX_ABS_BEND, STK_MAX_ABS_BEND);
    finiteNumber(Number(segment.width), `imported segment ${index + 1} width`, 0, STK_MAX_SEGMENT_WIDTH);
    const allowedTypes = value.wrapper === STK_WRAPPER_V3 ? [0, 1] : value.wrapper === STK_WRAPPER_V4 ? [0, 3] : [0, 1, 3, 4, 6];
    if (!allowedTypes.includes(segment.type)) fail(`imported segment ${index + 1} has an unsupported type.`);
    const allowedFlags = value.wrapper === STK_WRAPPER_V4 ? [0] : [0, 1];
    if (!allowedFlags.includes(segment.flag)) fail(`imported segment ${index + 1} has an unsupported flag.`);
    if (segment.color !== null) validateRgb(segment.color, `imported segment ${index + 1}`);
    const transparency = segment.transparency === undefined ? 0 : segment.transparency;
    if (!Number.isInteger(transparency) || transparency < 0 || transparency > 255) fail(`imported segment ${index + 1} has an invalid transparency.`);
    if (value.wrapper !== STK_WRAPPER_V5 && transparency !== 0) fail(`imported segment ${index + 1} uses unsupported transparency.`);
    if (value.wrapper === STK_WRAPPER_V5 && !hasV5Transparency && transparency !== 0) fail(`imported segment ${index + 1} uses unsupported transparency for its payload layout.`);
    if (value.wrapper === STK_WRAPPER_V5 && hasV5Transparency && segment.transparency === undefined) fail(`imported segment ${index + 1} is missing its transparency byte.`);
    if ((value.wrapper === STK_WRAPPER_V3 || value.wrapper === STK_WRAPPER_V4) && (segment.reserved !== 0 || segment.trailing !== (value.wrapper === STK_WRAPPER_V3 ? 0 : 3133))) fail(`imported segment ${index + 1} has an unsupported record layout.`);
  });
  if (!Array.isArray(value.polygons)) fail('imported polygon metadata is missing.');
  const polygons = value.polygons;
  if ((value.wrapper === STK_WRAPPER_V3 || value.wrapper === STK_WRAPPER_V4) && polygons.length) fail(`Pivot ${value.wrapper === STK_WRAPPER_V3 ? 3 : 4} polygon metadata is unsupported.`);
  if (!Array.isArray(polygons) || polygons.length > STK_MAX_POLYGONS) fail('imported polygon metadata count is invalid.');
  let vertexTotal = 0;
  polygons.forEach((polygon, index) => {
    if (!polygon || typeof polygon !== 'object' || polygon.id !== segments.length + index || !Array.isArray(polygon.vertices) || polygon.vertices.length < 3 || polygon.vertices.length > STK_MAX_POLYGON_VERTICES) fail(`imported polygon ${index + 1} is malformed.`);
    validateRgb(polygon.color, `imported polygon ${index + 1}`);
    const transparency = polygon.transparency === undefined ? 0 : polygon.transparency;
    if (!Number.isInteger(transparency) || transparency < 0 || transparency > 255) fail(`imported polygon ${index + 1} has an invalid transparency.`);
    if (value.wrapper !== STK_WRAPPER_V5 && transparency !== 0) fail(`imported polygon ${index + 1} uses unsupported transparency.`);
    if (value.wrapper === STK_WRAPPER_V5 && !hasV5Transparency && transparency !== 0) fail(`imported polygon ${index + 1} uses unsupported transparency for its payload layout.`);
    if (value.wrapper === STK_WRAPPER_V5 && hasV5Transparency && polygon.transparency === undefined) fail(`imported polygon ${index + 1} is missing its transparency byte.`);
    if (value.wrapper === STK_WRAPPER_V5 && !hasV5Transparency && polygon.reserved !== undefined && polygon.reserved !== 0) fail(`imported polygon ${index + 1} uses an unsupported colour/reserved byte.`);
    vertexTotal += polygon.vertices.length;
    if (vertexTotal > STK_MAX_POLYGON_VERTICES) fail('imported polygon vertices exceed the safety limit.');
    polygon.vertices.forEach((reference, vertex) => {
      if (!Number.isInteger(reference) || reference < 0 || reference > segments.length) fail(`imported polygon ${index + 1} references an unknown node.`);
      if (vertex > 0 && polygon.vertices[vertex - 1] === reference) fail(`imported polygon ${index + 1} repeats an adjacent node.`);
    });
    if (polygon.vertices[0] === polygon.vertices[polygon.vertices.length - 1]) fail(`imported polygon ${index + 1} repeats its closing node.`);
  });
  if (value.wrapper === STK_WRAPPER_V5) {
    if (!Array.isArray(value.parameters) || value.parameters.length > segments.length) fail('imported curve metadata is malformed.');
    const parameterSegments = new Set();
    value.parameters.forEach((parameter, index) => {
      if (!parameter || typeof parameter !== 'object' || !Number.isInteger(parameter.index) || parameter.index < 0 || parameter.index >= segments.length || parameter.segmentId !== parameter.index + 1 || !Number.isFinite(parameter.value) || parameter.value !== segments[parameter.index].bend || parameterSegments.has(parameter.index)) fail(`imported curve metadata ${index + 1} is malformed.`);
      parameterSegments.add(parameter.index);
    });
  }
  const itemCount = segments.length + polygons.length;
  if (!Array.isArray(value.drawRanks) || value.drawRanks.length !== itemCount) fail('imported draw ranks are malformed.');
  const ranks = new Set(value.drawRanks);
  if (ranks.size !== itemCount || value.drawRanks.some(rank => !Number.isInteger(rank) || rank < 0 || rank >= itemCount)) fail('imported draw ranks are not a complete permutation.');
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string' || warning.length > 300))) fail('imported warnings are malformed.');
  return true;
}

export function cloneStkArtwork(value) {
  if (value === null || value === undefined) return null;
  // The metadata schema is intentionally made entirely of JSON primitives.
  // This recursive clone keeps it safe on browsers without structuredClone.
  if (Array.isArray(value)) return value.map(cloneStkArtwork);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneStkArtwork(item)]));
  return value;
}

export function orderedStkDrawItems(artwork) {
  validateStkArtwork(artwork);
  const itemCount = artwork.drawRanks.length;
  return Array.from({ length: itemCount }, (_, index) => index).sort((a, b) => artwork.drawRanks[a] - artwork.drawRanks[b]);
}

export function decodeStkBytes(payload, wrapper, sourceBytes = 0) {
  const parsed = wrapper === STK_WRAPPER_V3 ? parseV3(payload) : wrapper === STK_WRAPPER_V4 ? parseV4(payload) : wrapper === STK_WRAPPER_V5 ? parseV5(payload) : fail(`unsupported STK wrapper 0x${wrapper?.toString(16) || '00'}`);
  parsed.sourceBytes = sourceBytes;
  validateStkArtwork(parsed);
  return parsed;
}

export async function decodeStk(input) {
  if (input && typeof input.size === 'number' && input.size > STK_MAX_FILE_BYTES) fail(`the file exceeds the ${STK_MAX_FILE_BYTES.toLocaleString()} byte safety limit.`);
  const bytes = await readBinary(input);
  if (bytes.byteLength < 2) fail('the file is too short.');
  if (bytes.byteLength > STK_MAX_FILE_BYTES) fail(`the file exceeds the ${STK_MAX_FILE_BYTES.toLocaleString()} byte safety limit.`);
  const wrapper = bytes[0];
  if (wrapper !== STK_WRAPPER_V3 && wrapper !== STK_WRAPPER_V4 && wrapper !== STK_WRAPPER_V5) fail(`unsupported STK wrapper 0x${wrapper.toString(16)}.`);
  // Pivot 3's 0x78 byte is the first byte of the zlib stream itself. Pivot 4
  // and 5 use a one-byte wrapper followed by their zlib stream.
  const payload = await inflateBounded(wrapper === STK_WRAPPER_V3 ? bytes : bytes.subarray(1));
  return decodeStkBytes(payload, wrapper, bytes.byteLength);
}

export function pointOnStkSegment(segment, start, t, chordLength = null, chordAngle = null, scale = 1) {
  const bend = Number(segment.bend) || 0;
  const sourceLength = Number(segment.length) * scale;
  const angle = Number(segment.angle);
  if (Number.isFinite(chordLength) && chordLength <= EPSILON) return { x: start.x, y: start.y };
  if (Math.abs(bend) < EPSILON) {
    const length = Number.isFinite(chordLength) ? Math.max(0, chordLength) : sourceLength;
    const direction = Number.isFinite(chordAngle) ? chordAngle : angle;
    return { x: start.x + length * t * Math.cos(direction), y: start.y + length * t * Math.sin(direction) };
  }
  // When a user poses a figure, native drag/interpolation changes the chord
  // endpoint.  Scale the source arc by the current chord while preserving its
  // signed bend so the curve follows that pose without changing its shape.
  const chord = Math.max(0, Number(chordLength) || 0);
  const direction = Number.isFinite(chordAngle) ? chordAngle : angle + bend / 2;
  const radiusSigned = chord > EPSILON ? chord / (2 * Math.sin(bend / 2)) : sourceLength / bend;
  const startTangent = direction - bend / 2;
  const radius = radiusSigned;
  const cx = start.x - radius * Math.sin(startTangent);
  const cy = start.y + radius * Math.cos(startTangent);
  const startA = bend > 0 ? startTangent - Math.PI / 2 : startTangent + Math.PI / 2;
  const theta = startA + bend * t;
  return { x: cx + Math.abs(radius) * Math.cos(theta), y: cy + Math.abs(radius) * Math.sin(theta) };
}

export function createFigureFromStk(decoded, { x = 400, y = 300, id = null } = {}) {
  validateStkArtwork(decoded);
  const figure = new Figure();
  figure.id = id || `stk-${Math.random().toString(36).slice(2, 11)}`;
  figure.x = x; figure.y = y; figure.scale = 1; figure.color = '#000000';
  figure.stkArtwork = cloneStkArtwork(decoded);
  const sourcePoints = [{ x: 0, y: 0 }];
  figure.joints = [new Joint('stk-root', null, 0, 0, SEGMENT_LINE, 20, 1, true, null, true)];
  for (const segment of decoded.segments) {
    const start = sourcePoints[segment.parent];
    const end = endpointFor(segment, start);
    sourcePoints.push(end);
    const chordDx = end.x - start.x;
    const chordDy = end.y - start.y;
    const chordLength = Math.hypot(chordDx, chordDy);
    const chordAngle = chordLength > EPSILON ? Math.atan2(chordDy, chordDx) : segment.angle;
    const parentId = segment.parent === 0 ? 'stk-root' : `stk-${segment.parent}`;
    const thickness = Math.max(1, segment.width || 1);
    const color = segment.color ? `#${segment.color.map(channel => channel.toString(16).padStart(2, '0')).join('')}` : null;
    figure.joints.push(new Joint(`stk-${segment.id}`, parentId, chordLength, chordAngle, SEGMENT_LINE, 20, thickness, true, color, segment.flag === 0));
  }
  return figure;
}

export function getStkNodes(figure) {
  if (!figure?.stkArtwork) return [];
  validateStkArtwork(figure.stkArtwork);
  const joints = new Map(figure.joints.map(joint => [joint.id, joint]));
  const nodes = [{ id: 0, parent: null, start: { x: figure.x, y: figure.y }, end: { x: figure.x, y: figure.y } }];
  figure.stkArtwork.segments.forEach((segment, index) => {
    const joint = joints.get(`stk-${segment.id}`);
    const parent = nodes[segment.parent];
    if (!joint || !parent) fail(`imported segment ${index + 1} cannot be positioned.`);
    nodes.push({ id: segment.id, parent: segment.parent, segment, start: parent.end, end: { x: joint.x, y: joint.y }, joint });
  });
  return nodes;
}
