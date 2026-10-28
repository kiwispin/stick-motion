import { Figure, Joint, SEGMENT_LINE } from './models.js';

// STK is a binary format.  The importer deliberately accepts only the Pivot 2,
// Pivot 3, Pivot 4 and measured Pivot 5 layouts reverse-engineered from local
// samples.  A file that does not match one of those complete layouts fails
// before a Figure is created; no unsupported feature is silently discarded.
//
// Pivot 2 files are not compressed: the whole file is the 0x01-headed payload
// that Pivot 3 later wrapped in zlib.  As with Pivot 3's 0x78, `wrapper`
// records the first byte of the file rather than a separate wrapper byte.
export const STK_WRAPPER_V2 = 0x01;
export const STK_WRAPPER_V3 = 0x78;
export const STK_WRAPPER_V4 = 0x79;
export const STK_WRAPPER_V5 = 0x7a;
export const STK_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const STK_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// Figures above about 1,000 parts slow posing and make each saved frame large (about 400 KB per 1,000 parts),
// so the cap keeps every project a student saves within the 25 MB the editor can reopen.
export const STK_MAX_SEGMENTS = 1024;
const STK_DETAILED_SEGMENTS = 512;
export const STK_MAX_POLYGONS = 512;
export const STK_MAX_POLYGON_VERTICES = 16384;
export const STK_MAX_DRAW_ITEMS = STK_MAX_SEGMENTS + STK_MAX_POLYGONS;
export const MAX_IMPORTED_JOINTS_PER_FIGURE = STK_MAX_SEGMENTS + 1;
// Keep the radius reconstruction bounded away from the 2π singularity.  The
// supplied Owl's largest bend is ~3.173 rad, comfortably inside this bound.
export const STK_MAX_ABS_BEND = 1.95 * Math.PI;
export const STK_MAX_SEGMENT_LENGTH = 10000;
export const STK_MAX_SEGMENT_WIDTH = 500;
const STK_MAX_WARNINGS = 32; // the importer itself produces at most four
const EPSILON = 1e-8;

// Circle types, measured against library thumbnails: type 1 is a white-interior circle outlined in the
// segment colour, type 3 a solid disc and type 4 a hollow ring (transparent interior) stroked at the
// segment width. Each circle's diameter is the segment chord.
export function isStkCircleSegment(artwork, segment) {
  return Boolean(segment && (((artwork?.wrapper === STK_WRAPPER_V2 || artwork?.wrapper === STK_WRAPPER_V3) && segment.type === 1) ||
    (artwork?.wrapper === STK_WRAPPER_V4 && (segment.type === 1 || segment.type === 3 || segment.type === 4)) ||
    (artwork?.wrapper === STK_WRAPPER_V5 && (segment.type === 1 || segment.type === 3 || segment.type === 4))));
}

// Only a solid disc paints at zero width; outlined circles and rings, like lines, need a positive width.
export function isStkFilledCircleSegment(artwork, segment) {
  return Boolean(segment && ((artwork?.wrapper === STK_WRAPPER_V4 && segment.type === 3) ||
    (artwork?.wrapper === STK_WRAPPER_V5 && segment.type === 3)));
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

// Pivot 2, 3 and 4 share one 24-byte segment record:
//   [parent source id u8][source id u8][reserved u16][length f32][angle f64][width f32][type u8][flag u8][trailing u16]
// Parents reference source ids, which need not be sequential, so segments are given record-order ids.  The
// file's drawing order is kept whenever parent records precede their children; if a parent comes later, the
// rig uses a stable topological order and drawRanks keep the file's order.  Neither version has a colour field.
function readLegacySegments(payload, first, segmentCount, label, { types, checkPadding }) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sourceSegments = [];
  const sourceIds = new Set();
  const sourceIdToRecord = new Map();
  for (let index = 0; index < segmentCount; index += 1) {
    const offset = first + index * 24;
    const parentSourceId = payload[offset];
    const sourceId = payload[offset + 1];
    const reserved = view.getUint16(offset + 2, true);
    const length = view.getFloat32(offset + 4, true);
    const angle = view.getFloat64(offset + 8, true);
    const width = view.getFloat32(offset + 16, true);
    const type = payload[offset + 20];
    const flag = payload[offset + 21];
    const trailing = view.getUint16(offset + 22, true);
    if (sourceId < 1 || sourceId > segmentCount || sourceIds.has(sourceId)) fail(`${label} segment ${index + 1} has an invalid or duplicate source id.`);
    if (checkPadding && (reserved !== 0 || trailing !== 0)) fail(`${label} segment ${sourceId} uses an unsupported record layout.`);
    finiteNumber(length, `${label} segment ${sourceId} length`, 0, STK_MAX_SEGMENT_LENGTH);
    finiteNumber(angle, `${label} segment ${sourceId} angle`, -1000000, 1000000);
    finiteNumber(width, `${label} segment ${sourceId} width`, 0, STK_MAX_SEGMENT_WIDTH);
    if (!types.includes(type)) fail(`${label} segment ${sourceId} uses unsupported type ${type}.`);
    if (flag !== 0 && flag !== 1) fail(`${label} segment ${sourceId} uses unsupported flag ${flag}.`);
    sourceIds.add(sourceId);
    sourceIdToRecord.set(sourceId, index);
    sourceSegments.push({ index, sourceId, parentSourceId, length, angle, bend: 0, width, type, flag,
      // No colour field: type 1's legacy hollow-circle renderer supplies its white interior and black outline.
      color: null, reserved, trailing });
  }
  sourceSegments.forEach(segment => {
    if (segment.parentSourceId !== 0 && !sourceIds.has(segment.parentSourceId)) fail(`${label} segment ${segment.sourceId} references an unknown parent.`);
  });

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
    if (sorted.length !== sourceSegments.length) fail(`${label} segment hierarchy contains a cycle.`);
    orderedSourceSegments = sorted;
  }
  const internalIdBySourceId = new Map(orderedSourceSegments.map((segment, index) => [segment.sourceId, index + 1]));
  const segments = orderedSourceSegments.map((source, index) => ({
    ...source,
    id: index + 1,
    parent: source.parentSourceId === 0 ? 0 : internalIdBySourceId.get(source.parentSourceId)
  }));
  const drawRanks = segments.map(segment => sourceIdToRecord.get(segment.sourceId));
  return { segments, drawRanks };
}

// Pivot 2 is the Pivot 3 payload stored uncompressed.  Pivot 3 zero-fills the two padding fields; Pivot 2 leaves
// them uninitialised (every record of a file repeats the same leftover bytes), so only Pivot 3 checks them.
function parseV2V3(payload, wrapper) {
  const label = wrapper === STK_WRAPPER_V2 ? 'Pivot 2' : 'Pivot 3';
  ensureBytes(payload, 0, 2, `${label} header`);
  if (payload[0] !== 1) fail(`unsupported ${label} payload header ${payload[0].toString(16).padStart(2, '0')}.`);
  const segmentCount = payload[1];
  if (segmentCount < 1 || segmentCount > 255) fail(`${label} segment count is outside the supported range.`);
  const expectedBytes = 2 + segmentCount * 24;
  if (payload.byteLength < expectedBytes) fail(`${label} segment records are incomplete.`);
  if (payload.byteLength > expectedBytes) fail(`${label} payload has unsupported trailing data.`);
  const { segments, drawRanks } = readLegacySegments(payload, 2, segmentCount, label, { types: [0, 1], checkPadding: wrapper === STK_WRAPPER_V3 });
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper,
    payloadHeader: '01', segments, polygons: [], drawRanks,
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: segments.some(segment => segment.type === 1)
      ? [`${label} type 1 circles are rendered as hollow circles with white interiors.`] : []
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

// Pivot 4 is the Pivot 3 record without the 01 header byte.  Its reserved and trailing fields vary from file to
// file (0, 3133, 6450, ...) without affecting the figure, so they are kept for round trips but not checked.
// Flag 1 marks construction segments as in Pivot 3 and 5; type 1 is the hollow circle, type 3 a filled circle and type 4 a circle outline.
function parseV4(payload) {
  ensureBytes(payload, 0, 1, 'Pivot 4 header');
  const segmentCount = payload[0];
  if (segmentCount < 1 || segmentCount > 255) fail('Pivot 4 segment count is outside the supported range.');
  const expectedBytes = 1 + segmentCount * 24;
  if (payload.byteLength < expectedBytes) fail('Pivot 4 segment records are incomplete.');
  if (payload.byteLength > expectedBytes) fail('Pivot 4 payload has unsupported trailing data.');
  const { segments, drawRanks } = readLegacySegments(payload, 1, segmentCount, 'Pivot 4', { types: [0, 1, 3, 4], checkPadding: false });
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper: STK_WRAPPER_V4,
    payloadHeader: null, segments, polygons: [], drawRanks,
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: [
      ...(segments.some(segment => segment.type === 3)
        ? ['Pivot 4 circle segments are rendered from their endpoint pair using the measured filled-circle mapping.'] : []),
      ...(segments.some(segment => segment.type === 4)
        ? ['Pivot 4 type 4 segments are drawn as hollow rings stroked at the segment width, measured against library thumbnails.'] : []),
      ...(segments.some(segment => segment.type === 1)
        ? ['Pivot 4 type 1 circles are rendered as hollow circles with white interiors.'] : [])
    ]
  };
}

// Pivot 5 payloads share one shape:
//   [header byte][segment count uint16][segment records]
//   [curve count uint16][curve records][polygon count uint16][polygons][draw ranks][figure trailer]
// The header byte is a bit field, not a layout id.  Pivot leaves a field out of every record when
// all segments hold its default value, and sets the matching bit; 0x40 instead adds a trailer:
//
//   0x01  type byte omitted: every segment is a line (type 0)
//   0x02  flag byte omitted: every segment has flag 0 (a pose control)
//   0x04  RGB omitted: every segment is black
//   0x08  transparency byte omitted: every segment is opaque.  Polygons always keep their own
//         transparency byte (the sixth byte of each polygon header), whatever this bit says.
//   0x10  draw ranks omitted: items draw in record order (only measured on figures without polygons)
//   0x20  source ids omitted: ids follow record order
//   0x40  an 8-byte figure trailer follows the draw ranks: [float32][RGB][byte].  It is kept but
//         not interpreted.
//   0x80  gradient marker omitted: no segment has a gradient
//
// A record therefore holds, in order, the fields its header keeps:
//   [parent uint16][source id uint16 (0x20 clear)][length float32][angle float64][width float32]
//   [type byte (0x01 clear)][flag byte (0x02 clear)][RGB (0x04 clear)][transparency (0x08 clear)]
//   [gradient marker byte (0x80 clear): 0, or 1 followed by the gradient end RGB + transparency]
// The common headers are a8 (type, flag, RGB), a0 (a8 + transparency), a9 (a8 without type) and
// 88 (a8 + source ids).  Without bit 0x20, source ids need not be sequential and parents reference
// them, so both are remapped to record order; curve references are always 0-based record indices, but
// polygon vertices name nodes by source id too (a tail polygon in the library raptors interleaves source
// ids 1-4 and 116-118, its two edge chains), so they are remapped to record-order node ids as well.
// Flag 0 segments are the figure's controls and flag 1 marks construction paths; a segment is painted
// whenever it has a positive width, independent of the flag.  (Reading the a9 flag as visibility
// once erased whole figures such as the basketball hoop, and an earlier "reordered" a9 reading
// misaligned every style by one segment.)
const V5_SEGMENT_TYPES = [0, 1, 3, 4, 6];
const V5_NO_TYPE = 0x01;
const V5_NO_FLAG = 0x02;
const V5_NO_COLOUR = 0x04;
const V5_NO_TRANSPARENCY = 0x08;
const V5_NO_DRAW_RANKS = 0x10;
const V5_NO_SOURCE_IDS = 0x20;
const V5_FIGURE_TRAILER = 0x40;
const V5_NO_GRADIENTS = 0x80;
const V5_FIGURE_TRAILER_BYTES = 8;
const STK_MAX_FIGURE_TRAILER_VALUE = 1000000;

function v5HeaderByte(payloadHeader) {
  return parseInt(payloadHeader.slice(0, 2), 16);
}

function v5Label(header) {
  return header === 0xa8 || header === 0xa0 ? 'Pivot 5' : `Pivot 5 ${header.toString(16).padStart(2, '0')}`;
}

function readV5Segments(payload, view, segmentCount, label, header) {
  const hasSourceIds = !(header & V5_NO_SOURCE_IDS);
  const hasType = !(header & V5_NO_TYPE);
  const hasFlag = !(header & V5_NO_FLAG);
  const hasColour = !(header & V5_NO_COLOUR);
  const hasTransparency = !(header & V5_NO_TRANSPARENCY);
  const hasGradients = !(header & V5_NO_GRADIENTS);
  const recordBytes = 18 + (hasSourceIds ? 2 : 0) + (hasType ? 1 : 0) + (hasFlag ? 1 : 0) +
    (hasColour ? 3 : 0) + (hasTransparency ? 1 : 0) + (hasGradients ? 1 : 0);
  // Without gradients every record has the same size, so the whole section is checked up front.
  if (!hasGradients) ensureBytes(payload, 3, segmentCount * recordBytes, `${label} segment records`);
  const sourceSegments = [];
  const sourceIds = new Set();
  const sourceIdToRecord = new Map();
  let offset = 3;
  for (let index = 0; index < segmentCount; index += 1) {
    if (hasGradients) ensureBytes(payload, offset, recordBytes, `${label} segment records`);
    const parent = view.getUint16(offset, true); offset += 2;
    const sourceId = hasSourceIds ? view.getUint16(offset, true) : index + 1;
    if (hasSourceIds) offset += 2;
    const length = view.getFloat32(offset, true);
    const angle = view.getFloat64(offset + 4, true);
    const width = view.getFloat32(offset + 12, true);
    offset += 16;
    const type = hasType ? payload[offset++] : 0;
    const flag = hasFlag ? payload[offset++] : 0;
    const color = hasColour ? readRgb(payload, offset, `${label} segment ${index + 1} colour`) : [0, 0, 0];
    if (hasColour) offset += 3;
    const transparency = hasTransparency ? payload[offset++] : 0;
    const gradientMarker = hasGradients ? payload[offset++] : 0;
    if (hasSourceIds) {
      if (sourceId < 1 || sourceId > segmentCount || sourceIds.has(sourceId)) fail(`${label} segment ${index + 1} has an invalid or duplicate source id.`);
    } else if (parent > index) fail(`${label} segment ${index + 1} has a forward or unknown parent.`);
    finiteNumber(length, `${label} segment ${sourceId} length`, 0, STK_MAX_SEGMENT_LENGTH);
    finiteNumber(angle, `${label} segment ${sourceId} angle`, -1000000, 1000000);
    finiteNumber(width, `${label} segment ${sourceId} width`, 0, STK_MAX_SEGMENT_WIDTH);
    if (hasType && !V5_SEGMENT_TYPES.includes(type)) fail(`${label} segment ${sourceId} uses unsupported type ${type}.`);
    if (flag !== 0 && flag !== 1) fail(`${label} segment ${sourceId} uses unsupported flag ${flag}.`);
    if (gradientMarker !== 0 && gradientMarker !== 1) fail(`${label} segment ${sourceId} uses an unsupported gradient marker ${gradientMarker}.`);
    let gradient = null;
    if (gradientMarker === 1) {
      ensureBytes(payload, offset, 4, `${label} segment ${sourceId} gradient`);
      gradient = [payload[offset], payload[offset + 1], payload[offset + 2], payload[offset + 3]];
      offset += 4;
    }
    sourceIds.add(sourceId);
    sourceIdToRecord.set(sourceId, index);
    const style = { width, type, flag, color, transparency, ...(gradient ? { gradient } : {}) };
    sourceSegments.push(hasSourceIds
      ? { index, sourceId, parentSourceId: parent, length, angle, bend: 0, ...style }
      : { id: index + 1, parent, length, angle, bend: 0, ...style });
  }
  if (!hasSourceIds) return { segments: sourceSegments, offset };
  sourceSegments.forEach(segment => {
    if (segment.parentSourceId === 0) return;
    if (!sourceIds.has(segment.parentSourceId)) fail(`${label} segment ${segment.sourceId} references an unknown parent.`);
    if (sourceIdToRecord.get(segment.parentSourceId) >= segment.index) fail(`${label} segment ${segment.sourceId} has a forward parent.`);
  });
  const internalIdBySourceId = new Map(sourceSegments.map(segment => [segment.sourceId, segment.index + 1]));
  const segments = sourceSegments.map(segment => ({
    ...segment,
    id: segment.index + 1,
    parent: segment.parentSourceId === 0 ? 0 : internalIdBySourceId.get(segment.parentSourceId)
  }));
  return { segments, offset, nodeIdBySourceId: internalIdBySourceId };
}

// The curve, polygon, draw-order and figure-trailer tables that follow the segment records.
function readV5Tables(payload, view, segments, start, label, header, nodeIdBySourceId = null) {
  const segmentCount = segments.length;
  const hasTransparency = !(header & V5_NO_TRANSPARENCY);
  let offset = start;

  ensureBytes(payload, offset, 2, `${label} curve count`);
  const curveCount = view.getUint16(offset, true); offset += 2;
  if (curveCount > segmentCount) fail(`${label} curve count exceeds the segment count.`);
  const seenCurves = new Set();
  const parameters = [];
  for (let index = 0; index < curveCount; index += 1) {
    ensureBytes(payload, offset, 10, `${label} curve records`);
    const segmentIndex = view.getUint16(offset, true);
    const bend = view.getFloat64(offset + 2, true);
    if (segmentIndex >= segmentCount) fail(`${label} curve ${index + 1} references an unknown segment.`);
    if (seenCurves.has(segmentIndex)) fail(`${label} curve records contain a duplicate segment ${segmentIndex + 1}.`);
    finiteNumber(bend, `${label} curve ${index + 1} bend`, -STK_MAX_ABS_BEND, STK_MAX_ABS_BEND);
    seenCurves.add(segmentIndex);
    segments[segmentIndex].bend = bend;
    parameters.push({ index: segmentIndex, segmentId: segmentIndex + 1, value: bend });
    offset += 10;
  }

  ensureBytes(payload, offset, 2, `${label} polygon count`);
  const polygonCount = view.getUint16(offset, true); offset += 2;
  if (polygonCount > STK_MAX_POLYGONS) fail(`${label} polygon count is outside the supported range.`);
  const polygons = [];
  let totalVertices = 0;
  for (let index = 0; index < polygonCount; index += 1) {
    ensureBytes(payload, offset, 6, `${label} polygon header`);
    const vertexCount = view.getUint16(offset, true);
    const color = readRgb(payload, offset + 2, `${label} polygon ${index + 1}`);
    // The sixth byte is the polygon's transparency in every layout (bit 0x08 only covers segments);
    // layouts without segment transparency keep their historical zero reserved field.
    const transparency = payload[offset + 5];
    const reserved = hasTransparency ? null : 0;
    if (vertexCount < 3 || vertexCount > STK_MAX_POLYGON_VERTICES) fail(`${label} polygon ${index + 1} has an invalid vertex count.`);
    totalVertices += vertexCount;
    if (totalVertices > STK_MAX_POLYGON_VERTICES) fail(`${label} polygon vertices exceed the safety limit.`);
    offset += 6;
    ensureBytes(payload, offset, vertexCount * 2, `${label} polygon vertices`);
    const vertices = [];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const sourceReference = view.getUint16(offset, true);
      const reference = nodeIdBySourceId && sourceReference !== 0 ? nodeIdBySourceId.get(sourceReference) : sourceReference;
      if (reference === undefined || reference > segmentCount) fail(`${label} polygon ${index + 1} references an unknown node.`);
      if (vertex > 0 && vertices[vertex - 1] === reference) fail(`${label} polygon ${index + 1} repeats an adjacent node.`);
      vertices.push(reference); offset += 2;
    }
    if (vertices[0] === vertices[vertices.length - 1]) fail(`${label} polygon ${index + 1} repeats its closing node.`);
    polygons.push({ id: segmentCount + index, color, vertices, transparency, reserved });
  }

  const itemCount = segmentCount + polygonCount;
  if (itemCount > STK_MAX_DRAW_ITEMS) fail(`${label} draw-item count is outside the supported range.`);
  const hasDrawRanks = !(header & V5_NO_DRAW_RANKS);
  // Record-order drawing is only measured on figures without polygons; where a polygon would sit
  // in that order is not established, so such files are rejected rather than guessed.
  if (!hasDrawRanks && polygonCount > 0) fail(`${label} omits the draw order of its polygons, which is not supported.`);
  const trailerBytes = header & V5_FIGURE_TRAILER ? V5_FIGURE_TRAILER_BYTES : 0;
  const remaining = payload.byteLength - offset;
  if (remaining !== (hasDrawRanks ? itemCount * 2 : 0) + trailerBytes) fail(`${label} payload has incomplete or unsupported trailing draw-order data.`);
  const drawRanks = [];
  const rankSet = new Set();
  for (let index = 0; index < itemCount; index += 1) {
    const rank = hasDrawRanks ? view.getUint16(offset, true) : index;
    if (hasDrawRanks) offset += 2;
    if (rank >= itemCount || rankSet.has(rank)) fail(`${label} draw ranks are not a complete permutation.`);
    rankSet.add(rank); drawRanks.push(rank);
  }
  let figureTrailer = null;
  if (trailerBytes) {
    const value = view.getFloat32(offset, true);
    finiteNumber(value, `${label} figure trailer value`, 0, STK_MAX_FIGURE_TRAILER_VALUE);
    figureTrailer = [value, payload[offset + 4], payload[offset + 5], payload[offset + 6], payload[offset + 7]];
    offset += trailerBytes;
  }
  if (offset !== payload.byteLength) fail(`${label} payload has unsupported trailing data.`);
  return { parameters, polygons, drawRanks, figureTrailer };
}

function v5Warnings(header, segments, polygons, figureTrailer) {
  if (header === 0xa9) return ['Pivot 5 a9 records use the measured a8-order geometry/style layout without a per-record type byte; positive-width strokes are painted and flag 0 marks pose controls.'];
  if (header === 0x88) return ['Pivot 5 88 source ids are remapped to record order; flag 0 marks pose controls and positive-width strokes paint.'];
  const measuredHeader = header === 0xa8 || header === 0xa0;
  return [
    ...(measuredHeader ? [] : [`Pivot 5 header ${header.toString(16).padStart(2, '0')} omits per-segment fields that hold their default in every segment; they are restored as line, flag 0, black and opaque.`]),
    ...(!(header & V5_NO_SOURCE_IDS) ? ['Pivot 5 source ids are remapped to record order.'] : []),
    ...(segments.some(segment => segment.transparency > 0) || polygons.some(polygon => polygon.transparency > 0)
      ? ['Pivot 5 transparency bytes are preserved and composited over the existing canvas alpha.'] : []),
    ...(segments.some(segment => segment.gradient)
      ? ['Pivot 5 gradient segments are drawn with a straight start-to-end gradient; the exact Pivot gradient geometry is not established.'] : []),
    ...(figureTrailer ? ['The Pivot 5 figure trailer (a number, a colour and one byte) is preserved but not applied.'] : []),
    ...(segments.some(segment => segment.type === 4)
      ? ['Type 4 segments are drawn as hollow rings stroked at the segment width, measured against library thumbnails.'] : []),
    ...(segments.some(segment => segment.type === 6)
      ? ['Type 6 line caps are approximated with square caps from the supplied V5 reference geometry; the numeric enum is not documented.'] : []),
    ...(segments.some(segment => segment.type === 1 || segment.type === 3)
      ? ['V5 type 1 and type 3 circles use the tentative white-interior/solid-fill mapping; other circle fill variants are not established.'] : [])
  ];
}

function parseV5(payload) {
  ensureBytes(payload, 0, 3, 'Pivot 5 header');
  const header = payload[0];
  const payloadHeader = Array.from(payload.subarray(0, 3)).map(value => value.toString(16).padStart(2, '0')).join('');
  const label = v5Label(header);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const segmentCount = view.getUint16(1, true);
  if (segmentCount < 1 || segmentCount > STK_MAX_SEGMENTS) fail(`${label} segment count is outside the supported range.`);
  const { segments, offset, nodeIdBySourceId } = readV5Segments(payload, view, segmentCount, label, header);
  const { parameters, polygons, drawRanks, figureTrailer } = readV5Tables(payload, view, segments, offset, label, header, nodeIdBySourceId);
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper: STK_WRAPPER_V5,
    payloadHeader, segments, parameters, polygons, drawRanks,
    ...(figureTrailer ? { figureTrailer } : {}),
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: v5Warnings(header, segments, polygons, figureTrailer)
  };
}

export function validateStkArtwork(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 'pivot-stk' || value.schemaVersion !== 1) fail('the imported artwork metadata is malformed.');
  if (value.wrapper !== STK_WRAPPER_V2 && value.wrapper !== STK_WRAPPER_V3 && value.wrapper !== STK_WRAPPER_V4 && value.wrapper !== STK_WRAPPER_V5) fail('the imported artwork wrapper is unsupported.');
  if (!Number.isInteger(value.sourceBytes) || value.sourceBytes < 0 || value.sourceBytes > STK_MAX_FILE_BYTES || !Number.isInteger(value.payloadBytes) || value.payloadBytes < 1 || value.payloadBytes > STK_MAX_PAYLOAD_BYTES) fail('the imported source-size metadata is invalid.');
  if ((value.wrapper === STK_WRAPPER_V2 || value.wrapper === STK_WRAPPER_V3) && value.payloadHeader !== '01') fail(`the Pivot ${value.wrapper === STK_WRAPPER_V2 ? 2 : 3} payload header metadata is invalid.`);
  if (value.wrapper === STK_WRAPPER_V4 && value.payloadHeader !== null) fail('the Pivot 4 payload header metadata is invalid.');
  if (value.wrapper === STK_WRAPPER_V5 && (typeof value.payloadHeader !== 'string' || !/^[0-9a-f]{6}$/.test(value.payloadHeader))) fail('the Pivot 5 payload header metadata is invalid.');
  const v5Header = value.wrapper === STK_WRAPPER_V5 ? v5HeaderByte(value.payloadHeader) : null;
  const hasV5Transparency = v5Header !== null && !(v5Header & V5_NO_TRANSPARENCY);
  const hasV5Gradients = v5Header !== null && !(v5Header & V5_NO_GRADIENTS);
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
    const allowedTypes = value.wrapper === STK_WRAPPER_V2 || value.wrapper === STK_WRAPPER_V3 ? [0, 1] : value.wrapper === STK_WRAPPER_V4 ? [0, 1, 3, 4] : v5Header & V5_NO_TYPE ? [0] : V5_SEGMENT_TYPES;
    if (!allowedTypes.includes(segment.type)) fail(`imported segment ${index + 1} has an unsupported type.`);
    const allowedFlags = v5Header & V5_NO_FLAG ? [0] : [0, 1];
    if (!allowedFlags.includes(segment.flag)) fail(`imported segment ${index + 1} has an unsupported flag.`);
    if (segment.controlVisible !== undefined && typeof segment.controlVisible !== 'boolean') fail(`imported segment ${index + 1} has an invalid control visibility flag.`);
    // Source-record bookkeeping kept from Pivot 3/4 and 0x88 files: small integers, or absent.
    for (const key of ['index', 'sourceId', 'parentSourceId', 'reserved', 'trailing']) {
      const field = segment[key];
      if (field !== undefined && field !== null && (!Number.isInteger(field) || field < 0 || field > 0xffff)) fail(`imported segment ${index + 1} has an invalid ${key}.`);
    }
    if (segment.color !== null) validateRgb(segment.color, `imported segment ${index + 1}`);
    if (segment.gradient !== undefined) {
      if (!hasV5Gradients) fail(`imported segment ${index + 1} has a gradient its payload layout cannot hold.`);
      if (!Array.isArray(segment.gradient) || segment.gradient.length !== 4 || segment.gradient.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) fail(`imported segment ${index + 1} has an invalid gradient.`);
    }
    const transparency = segment.transparency === undefined ? 0 : segment.transparency;
    if (!Number.isInteger(transparency) || transparency < 0 || transparency > 255) fail(`imported segment ${index + 1} has an invalid transparency.`);
    if (value.wrapper !== STK_WRAPPER_V5 && transparency !== 0) fail(`imported segment ${index + 1} uses unsupported transparency.`);
    if (value.wrapper === STK_WRAPPER_V5 && !hasV5Transparency && transparency !== 0) fail(`imported segment ${index + 1} uses unsupported transparency for its payload layout.`);
    if (value.wrapper === STK_WRAPPER_V5 && hasV5Transparency && segment.transparency === undefined) fail(`imported segment ${index + 1} is missing its transparency byte.`);
    if (value.wrapper === STK_WRAPPER_V3 && (segment.reserved !== 0 || segment.trailing !== 0)) fail(`imported segment ${index + 1} has an unsupported record layout.`);
  });
  if (!Array.isArray(value.polygons)) fail('imported polygon metadata is missing.');
  const polygons = value.polygons;
  if (value.wrapper !== STK_WRAPPER_V5 && polygons.length) fail(`Pivot ${value.wrapper === STK_WRAPPER_V2 ? 2 : value.wrapper === STK_WRAPPER_V3 ? 3 : 4} polygon metadata is unsupported.`);
  if (!Array.isArray(polygons) || polygons.length > STK_MAX_POLYGONS) fail('imported polygon metadata count is invalid.');
  let vertexTotal = 0;
  polygons.forEach((polygon, index) => {
    if (!polygon || typeof polygon !== 'object' || polygon.id !== segments.length + index || !Array.isArray(polygon.vertices) || polygon.vertices.length < 3 || polygon.vertices.length > STK_MAX_POLYGON_VERTICES) fail(`imported polygon ${index + 1} is malformed.`);
    validateRgb(polygon.color, `imported polygon ${index + 1}`);
    const transparency = polygon.transparency === undefined ? 0 : polygon.transparency;
    if (!Number.isInteger(transparency) || transparency < 0 || transparency > 255) fail(`imported polygon ${index + 1} has an invalid transparency.`);
    if (value.wrapper !== STK_WRAPPER_V5 && transparency !== 0) fail(`imported polygon ${index + 1} uses unsupported transparency.`);
    if (value.wrapper === STK_WRAPPER_V5 && hasV5Transparency && polygon.transparency === undefined) fail(`imported polygon ${index + 1} is missing its transparency byte.`);
    if (value.wrapper === STK_WRAPPER_V5 && !hasV5Transparency && polygon.reserved !== undefined && polygon.reserved !== 0) fail(`imported polygon ${index + 1} uses an unsupported colour/reserved byte.`);
    if (polygon.reserved !== undefined && polygon.reserved !== null && (!Number.isInteger(polygon.reserved) || polygon.reserved < 0 || polygon.reserved > 255)) fail(`imported polygon ${index + 1} has an invalid reserved byte.`);
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
  if ((v5Header !== null && Boolean(v5Header & V5_FIGURE_TRAILER)) !== (value.figureTrailer !== undefined)) fail('imported figure trailer metadata does not match its payload layout.');
  if (value.figureTrailer !== undefined) {
    const [trailerValue, ...bytes] = Array.isArray(value.figureTrailer) ? value.figureTrailer : [];
    if (value.figureTrailer.length !== 5 || !Number.isFinite(trailerValue) || trailerValue < 0 || trailerValue > STK_MAX_FIGURE_TRAILER_VALUE || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) fail('imported figure trailer metadata is malformed.');
  }
  const itemCount = segments.length + polygons.length;
  if (!Array.isArray(value.drawRanks) || value.drawRanks.length !== itemCount) fail('imported draw ranks are malformed.');
  const ranks = new Set(value.drawRanks);
  if (ranks.size !== itemCount || value.drawRanks.some(rank => !Number.isInteger(rank) || rank < 0 || rank >= itemCount)) fail('imported draw ranks are not a complete permutation.');
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > STK_MAX_WARNINGS || value.warnings.some(warning => typeof warning !== 'string' || warning.length > 300))) fail('imported warnings are malformed.');
  return true;
}

// Every field the parsers above can produce (controlVisible is accepted from older saved projects).
// A copy keeps only these, in their original order, so data hidden in a project file cannot ride
// along into every frame and Undo step. Their values are flat JSON primitives or flat arrays.
const STK_ARTWORK_FIELDS = new Set(['format', 'schemaVersion', 'wrapper', 'payloadHeader', 'segments', 'parameters', 'polygons', 'drawRanks', 'figureTrailer', 'sourceBytes', 'payloadBytes', 'warnings']);
const STK_SEGMENT_FIELDS = new Set(['index', 'sourceId', 'parentSourceId', 'id', 'parent', 'length', 'angle', 'bend', 'width', 'type', 'flag', 'color', 'transparency', 'gradient', 'reserved', 'trailing', 'controlVisible']);
const STK_POLYGON_FIELDS = new Set(['id', 'color', 'vertices', 'transparency', 'reserved']);
const STK_PARAMETER_FIELDS = new Set(['index', 'segmentId', 'value']);

function copyKnownFields(source, fields) {
  return Object.fromEntries(Object.keys(source).filter(key => fields.has(key)).map(key => [key, Array.isArray(source[key]) ? [...source[key]] : source[key]]));
}

export function cloneStkArtwork(value) {
  if (value === null || value === undefined) return null;
  const artwork = copyKnownFields(value, STK_ARTWORK_FIELDS);
  if (Array.isArray(value.segments)) artwork.segments = value.segments.map(segment => copyKnownFields(segment, STK_SEGMENT_FIELDS));
  if (Array.isArray(value.polygons)) artwork.polygons = value.polygons.map(polygon => copyKnownFields(polygon, STK_POLYGON_FIELDS));
  if (Array.isArray(value.parameters)) artwork.parameters = value.parameters.map(parameter => copyKnownFields(parameter, STK_PARAMETER_FIELDS));
  return artwork;
}

export function orderedStkDrawItems(artwork) {
  validateStkArtwork(artwork);
  const itemCount = artwork.drawRanks.length;
  return Array.from({ length: itemCount }, (_, index) => index).sort((a, b) => artwork.drawRanks[a] - artwork.drawRanks[b]);
}

export function decodeStkBytes(payload, wrapper, sourceBytes = 0) {
  const parsed = wrapper === STK_WRAPPER_V2 || wrapper === STK_WRAPPER_V3 ? parseV2V3(payload, wrapper) : wrapper === STK_WRAPPER_V4 ? parseV4(payload) : wrapper === STK_WRAPPER_V5 ? parseV5(payload) : fail(`unsupported STK wrapper 0x${wrapper?.toString(16) || '00'}`);
  parsed.sourceBytes = sourceBytes;
  if (parsed.segments.length > STK_DETAILED_SEGMENTS) parsed.warnings.push(`This figure has ${parsed.segments.length.toLocaleString()} parts, so each frame that uses it saves a lot of data. Keep animations with it short.`);
  validateStkArtwork(parsed);
  return parsed;
}

export async function decodeStk(input) {
  if (input && typeof input.size === 'number' && input.size > STK_MAX_FILE_BYTES) fail(`the file exceeds the ${STK_MAX_FILE_BYTES.toLocaleString()} byte safety limit.`);
  const bytes = await readBinary(input);
  if (bytes.byteLength < 2) fail('the file is too short.');
  if (bytes.byteLength > STK_MAX_FILE_BYTES) fail(`the file exceeds the ${STK_MAX_FILE_BYTES.toLocaleString()} byte safety limit.`);
  const wrapper = bytes[0];
  // Pivot 2 files are the raw payload itself.  0x01 cannot begin a zlib stream (its compression-method
  // nibble is not 8), so this never shadows the compressed layouts below.
  if (wrapper === STK_WRAPPER_V2) return decodeStkBytes(bytes, wrapper, bytes.byteLength);
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
    const handleVisible = segment.controlVisible === undefined ? segment.flag === 0 : segment.controlVisible;
    figure.joints.push(new Joint(`stk-${segment.id}`, parentId, chordLength, chordAngle, SEGMENT_LINE, 20, thickness, true, color, handleVisible));
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
