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
// Projects store each imported artwork once and only a [length, angle] pose per joint per frame, so even the
// largest library figures (about 9,000 parts) save roughly 400 KB per frame.
export const STK_MAX_SEGMENTS = 10000;
const STK_DETAILED_SEGMENTS = 2048;
// Artwork that has been validated, copied and frozen (see settleStkArtwork); it can never change again.
const settledArtwork = new WeakSet();
// Picture tables of settled artwork.  Copies made for flipping and smooth playback share the table, so its
// PNG data is checked and decoded once.
const settledImages = new WeakSet();
const jointTemplates = new WeakMap();
const drawnJointIds = new WeakMap();
const mirroredArtworks = new WeakMap();
export const STK_MAX_POLYGONS = 512;
export const STK_MAX_POLYGON_VERTICES = 16384;
export const STK_MAX_DRAW_ITEMS = STK_MAX_SEGMENTS + STK_MAX_POLYGONS;
export const MAX_IMPORTED_JOINTS_PER_FIGURE = STK_MAX_SEGMENTS + 1;
// Keep the radius reconstruction bounded away from the 2π singularity: at 1.99π the arc's radius is
// about 32 times its chord.  The library's largest bend is 1.987π.
export const STK_MAX_ABS_BEND = 1.99 * Math.PI;
// Pivot's "slider" trick hangs a part off an invisible arm up to about 1,000,000 units long, whose child
// arm comes straight back, so the part moves in a nearly straight line when posed.
export const STK_MAX_SEGMENT_LENGTH = 10000000;
// A saved joint's length is its chord, never longer than its segment; the margin absorbs rounding.
export const MAX_IMPORTED_JOINT_LENGTH = 2 * STK_MAX_SEGMENT_LENGTH;
export const STK_MAX_SEGMENT_WIDTH = 500;
// Pictures (Pivot 5 type-2 segments) carry their own PNG images.  These limits are checked from the PNG
// headers before anything is decoded, so a small file cannot unpack into a huge image.  The library's
// largest picture figure has 14 images, 565 KB of PNG data and 1.75 million pixels; its largest image
// is 606 by 1192.
export const STK_MAX_IMAGES = 256;
export const STK_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const STK_MAX_IMAGE_SIDE = 4096;
export const STK_MAX_IMAGE_PIXELS = 2048 * 2048;
export const STK_MAX_TOTAL_IMAGE_PIXELS = 16 * 1024 * 1024;
const STK_MAX_WARNINGS = 32; // the importer itself produces at most ten
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

// A Pivot 5 type-2 segment draws one of the figure's stored images instead of a line.  Its width, colour,
// transparency and gradient have no visible effect in Pivot (measured against library previews).
export function isStkPictureSegment(artwork, segment) {
  return Boolean(segment && artwork?.wrapper === STK_WRAPPER_V5 && segment.type === STK_PICTURE_TYPE);
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Checks that bytes [start, end) are exactly one PNG file: the signature, an IHDR chunk first, at least one
// IDAT chunk, and chunks that run without gaps to an IEND ending exactly at `end`.  Returns the size its
// header declares, checked against the safety limits; the pixels themselves are not decoded here.
function checkPng(bytes, start, end, label) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (end - start < 8 + 25 + 12 || end > bytes.byteLength) fail(`${label} is not a complete PNG image.`);
  if (PNG_SIGNATURE.some((value, index) => bytes[start + index] !== value)) fail(`${label} is not a PNG image.`);
  const chunkType = offset => String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let offset = start + 8;
  if (view.getUint32(offset) !== 13 || chunkType(offset) !== 'IHDR') fail(`${label} has no PNG header.`);
  const width = view.getUint32(offset + 8);
  const height = view.getUint32(offset + 12);
  if (width < 1 || height < 1 || width > STK_MAX_IMAGE_SIDE || height > STK_MAX_IMAGE_SIDE || width * height > STK_MAX_IMAGE_PIXELS) fail(`${label} is ${width} by ${height} pixels, outside the supported size.`);
  let imageData = false;
  while (true) {
    if (offset + 12 > end) fail(`${label} ends before its PNG end marker.`);
    const length = view.getUint32(offset);
    const type = chunkType(offset);
    if (!/^[A-Za-z]{4}$/.test(type) || length > end - offset - 12) fail(`${label} has a malformed PNG chunk.`);
    offset += 12 + length;
    if (type === 'IDAT') imageData = true;
    if (type === 'IEND') break;
  }
  if (offset !== end) fail(`${label} does not end where the file says it does.`);
  if (!imageData) fail(`${label} has no PNG image data.`);
  return { width, height };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

// The PNG file of a picture, from the base64 text it is kept (and saved in projects) as.
export function stkImageBytes(image) {
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
//   [picture fields, type 2 only: image index uint16, a zero byte, mirror flag byte]
// A figure with any type-2 (picture) segment stores an image table between its curves and polygons:
//   [image count uint16], then per image [x1 y1 x2 y2 int32][end offset uint64][a complete PNG file]
// (x1, y1) is the image pixel placed on the segment's start and (x2, y2) the one on its end; the end
// offset is where the PNG ends, counted from the start of the payload.
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
const STK_PICTURE_TYPE = 2;
const V5_PICTURE_FIELD_BYTES = 4;
const V5_IMAGE_HEADER_BYTES = 24;
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
  // Without gradients every record but a picture's has the same size, so the section is checked up front;
  // gradients and pictures lengthen their records, so each record is checked as well.
  if (!hasGradients) ensureBytes(payload, 3, segmentCount * recordBytes, `${label} segment records`);
  const sourceSegments = [];
  const sourceIds = new Set();
  const sourceIdToRecord = new Map();
  let offset = 3;
  for (let index = 0; index < segmentCount; index += 1) {
    ensureBytes(payload, offset, recordBytes, `${label} segment records`);
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
    if (hasType && !V5_SEGMENT_TYPES.includes(type) && type !== STK_PICTURE_TYPE) fail(`${label} segment ${sourceId} uses unsupported type ${type}.`);
    if (flag !== 0 && flag !== 1) fail(`${label} segment ${sourceId} uses unsupported flag ${flag}.`);
    if (gradientMarker !== 0 && gradientMarker !== 1) fail(`${label} segment ${sourceId} uses an unsupported gradient marker ${gradientMarker}.`);
    let gradient = null;
    if (gradientMarker === 1) {
      ensureBytes(payload, offset, 4, `${label} segment ${sourceId} gradient`);
      gradient = [payload[offset], payload[offset + 1], payload[offset + 2], payload[offset + 3]];
      offset += 4;
    }
    let picture = null;
    if (type === STK_PICTURE_TYPE) {
      ensureBytes(payload, offset, V5_PICTURE_FIELD_BYTES, `${label} segment ${sourceId} picture`);
      const imageMirror = payload[offset + 3];
      if (payload[offset + 2] !== 0 || (imageMirror !== 0 && imageMirror !== 1)) fail(`${label} segment ${sourceId} has unsupported picture settings.`);
      picture = { image: view.getUint16(offset, true), imageMirror };
      offset += V5_PICTURE_FIELD_BYTES;
    }
    sourceIds.add(sourceId);
    sourceIdToRecord.set(sourceId, index);
    const style = { width, type, flag, color, transparency, ...(gradient ? { gradient } : {}), ...(picture || {}) };
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
    // No library picture is curved, so how Pivot would bend one is unknown.
    if (segments[segmentIndex].type === STK_PICTURE_TYPE && bend !== 0) fail(`${label} curve ${index + 1} bends a picture, which is not supported.`);
    seenCurves.add(segmentIndex);
    segments[segmentIndex].bend = bend;
    parameters.push({ index: segmentIndex, segmentId: segmentIndex + 1, value: bend });
    offset += 10;
  }

  let images = null;
  if (segments.some(segment => segment.type === STK_PICTURE_TYPE)) ({ images, offset } = readV5Images(payload, view, segments, offset, label));

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
  // Items draw in rank order.  A few library files give two items the same rank (and so skip another);
  // tied items draw in record order, and the ranks are renumbered into a complete permutation.
  const sourceRanks = [];
  for (let index = 0; index < itemCount; index += 1) {
    const rank = hasDrawRanks ? view.getUint16(offset, true) : index;
    if (hasDrawRanks) offset += 2;
    if (rank >= itemCount) fail(`${label} draw ranks are not a complete permutation.`);
    sourceRanks.push(rank);
  }
  const drawRanks = new Array(itemCount);
  sourceRanks.map((_, item) => item).sort((a, b) => sourceRanks[a] - sourceRanks[b] || a - b).forEach((item, rank) => { drawRanks[item] = rank; });
  const tiedRanks = itemCount - new Set(sourceRanks).size;
  let figureTrailer = null;
  if (trailerBytes) {
    const value = view.getFloat32(offset, true);
    finiteNumber(value, `${label} figure trailer value`, 0, STK_MAX_FIGURE_TRAILER_VALUE);
    figureTrailer = [value, payload[offset + 4], payload[offset + 5], payload[offset + 6], payload[offset + 7]];
    offset += trailerBytes;
  }
  if (offset !== payload.byteLength) fail(`${label} payload has unsupported trailing data.`);
  return { parameters, polygons, drawRanks, figureTrailer, tiedRanks, images };
}

// The image table of a figure with pictures.  Every PNG is checked whole, and its size against the limits,
// before anything is copied out; the images are decoded later, by the renderer.
function readV5Images(payload, view, segments, start, label) {
  let offset = start;
  ensureBytes(payload, offset, 2, `${label} image count`);
  const count = view.getUint16(offset, true); offset += 2;
  if (count < 1 || count > STK_MAX_IMAGES) fail(`${label} image count is outside the supported range.`);
  const images = [];
  let totalBytes = 0;
  let totalPixels = 0;
  for (let index = 0; index < count; index += 1) {
    const imageLabel = `${label} picture image ${index + 1}`;
    ensureBytes(payload, offset, V5_IMAGE_HEADER_BYTES, `${imageLabel} header`);
    const [x1, y1, x2, y2] = [0, 4, 8, 12].map(field => view.getInt32(offset + field, true));
    if (x1 === x2 && y1 === y2) fail(`${imageLabel} places both ends of its segment on the same pixel.`);
    // A 64-bit offset; the high half is zero in any payload under the 16 MB limit.
    const end = view.getUint32(offset + 16, true);
    if (view.getUint32(offset + 20, true) !== 0) fail(`${imageLabel} has an invalid end offset.`);
    offset += V5_IMAGE_HEADER_BYTES;
    if (end <= offset || end > payload.byteLength) fail(`${imageLabel} has an invalid end offset.`);
    totalBytes += end - offset;
    if (totalBytes > STK_MAX_IMAGE_BYTES) fail(`${label} images exceed the ${STK_MAX_IMAGE_BYTES.toLocaleString()} byte safety limit.`);
    const { width, height } = checkPng(payload, offset, end, imageLabel);
    totalPixels += width * height;
    if (totalPixels > STK_MAX_TOTAL_IMAGE_PIXELS) fail(`${label} images exceed the ${STK_MAX_TOTAL_IMAGE_PIXELS.toLocaleString()} pixel safety limit.`);
    images.push({ x1, y1, x2, y2, width, height, data: bytesToBase64(payload.subarray(offset, end)) });
    offset = end;
  }
  segments.forEach((segment, index) => {
    if (segment.type === STK_PICTURE_TYPE && segment.image >= count) fail(`${label} segment ${index + 1} refers to a missing picture image.`);
  });
  return { images, offset };
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
  const { parameters, polygons, drawRanks, figureTrailer, tiedRanks, images } = readV5Tables(payload, view, segments, offset, label, header, nodeIdBySourceId);
  return {
    format: 'pivot-stk', schemaVersion: 1, wrapper: STK_WRAPPER_V5,
    payloadHeader, segments, parameters, polygons, drawRanks,
    ...(figureTrailer ? { figureTrailer } : {}),
    ...(images ? { images } : {}),
    sourceBytes: 0, payloadBytes: payload.byteLength,
    warnings: [
      ...v5Warnings(header, segments, polygons, figureTrailer),
      ...(tiedRanks ? ['The Pivot 5 draw order gives some parts the same place; tied parts are drawn in file order.'] : []),
      ...(images ? ['Pictures are drawn from the images stored in the file, placed on their segments as measured against library previews.'] : [])
    ]
  };
}

export function validateStkArtwork(value) {
  if (settledArtwork.has(value)) return true;
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
    const allowedTypes = value.wrapper === STK_WRAPPER_V2 || value.wrapper === STK_WRAPPER_V3 ? [0, 1] : value.wrapper === STK_WRAPPER_V4 ? [0, 1, 3, 4] : v5Header & V5_NO_TYPE ? [0] : [...V5_SEGMENT_TYPES, STK_PICTURE_TYPE];
    if (!allowedTypes.includes(segment.type)) fail(`imported segment ${index + 1} has an unsupported type.`);
    if (segment.type === STK_PICTURE_TYPE) {
      if (!Array.isArray(value.images) || !Number.isInteger(segment.image) || segment.image < 0 || segment.image >= value.images.length) fail(`imported segment ${index + 1} refers to a missing picture image.`);
      if (segment.imageMirror !== 0 && segment.imageMirror !== 1) fail(`imported segment ${index + 1} has an invalid picture mirror flag.`);
      if (Number(segment.bend) !== 0) fail(`imported segment ${index + 1} is a curved picture, which is not supported.`);
    } else if (segment.image !== undefined || segment.imageMirror !== undefined) fail(`imported segment ${index + 1} has picture settings but is not a picture.`);
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
  if (value.images !== undefined) {
    if (value.wrapper !== STK_WRAPPER_V5 || !segments.some(segment => segment.type === STK_PICTURE_TYPE)) fail('imported picture images do not belong to any picture segment.');
    if (!settledImages.has(value.images)) validateStkImages(value.images);
  }
  return true;
}

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

// A reopened project's pictures get the same checks as a freshly imported file's: each must be one whole
// PNG within the size limits, matching the size recorded for it.
function validateStkImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > STK_MAX_IMAGES) fail('imported picture images are malformed.');
  let totalLength = 0;
  images.forEach((image, index) => {
    const label = `imported picture image ${index + 1}`;
    if (!image || typeof image !== 'object' || Array.isArray(image)) fail(`${label} is malformed.`);
    const anchors = [image.x1, image.y1, image.x2, image.y2];
    if (anchors.some(value => !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)) fail(`${label} has invalid anchor points.`);
    if (image.x1 === image.x2 && image.y1 === image.y2) fail(`${label} places both ends of its segment on the same pixel.`);
    if (typeof image.data !== 'string' || image.data.length % 4 !== 0 || !BASE64_TEXT.test(image.data)) fail(`${label} has malformed image data.`);
    totalLength += image.data.length;
    if (totalLength > Math.ceil(STK_MAX_IMAGE_BYTES / 3) * 4) fail(`imported picture images exceed the ${STK_MAX_IMAGE_BYTES.toLocaleString()} byte safety limit.`);
  });
  let totalPixels = 0;
  images.forEach((image, index) => {
    const label = `imported picture image ${index + 1}`;
    let bytes;
    try { bytes = stkImageBytes(image); } catch { fail(`${label} has malformed image data.`); }
    const { width, height } = checkPng(bytes, 0, bytes.byteLength, label);
    if (image.width !== width || image.height !== height) fail(`${label} does not match its recorded size.`);
    totalPixels += width * height;
    if (totalPixels > STK_MAX_TOTAL_IMAGE_PIXELS) fail(`imported picture images exceed the ${STK_MAX_TOTAL_IMAGE_PIXELS.toLocaleString()} pixel safety limit.`);
  });
}

// Every field the parsers above can produce (controlVisible is accepted from older saved projects).
// A copy keeps only these, in their original order, so data hidden in a project file cannot ride
// along into every frame and Undo step. Their values are flat JSON primitives or flat arrays.
const STK_ARTWORK_FIELDS = new Set(['format', 'schemaVersion', 'wrapper', 'payloadHeader', 'segments', 'parameters', 'polygons', 'drawRanks', 'figureTrailer', 'images', 'sourceBytes', 'payloadBytes', 'warnings']);
const STK_SEGMENT_FIELDS = new Set(['index', 'sourceId', 'parentSourceId', 'id', 'parent', 'length', 'angle', 'bend', 'width', 'type', 'flag', 'color', 'transparency', 'gradient', 'image', 'imageMirror', 'reserved', 'trailing', 'controlVisible']);
const STK_POLYGON_FIELDS = new Set(['id', 'color', 'vertices', 'transparency', 'reserved']);
const STK_PARAMETER_FIELDS = new Set(['index', 'segmentId', 'value']);
const STK_IMAGE_FIELDS = new Set(['x1', 'y1', 'x2', 'y2', 'width', 'height', 'data']);

function copyKnownFields(source, fields) {
  return Object.fromEntries(Object.keys(source).filter(key => fields.has(key)).map(key => [key, Array.isArray(source[key]) ? [...source[key]] : source[key]]));
}

export function cloneStkArtwork(value) {
  if (value === null || value === undefined) return null;
  const artwork = copyKnownFields(value, STK_ARTWORK_FIELDS);
  if (Array.isArray(value.segments)) artwork.segments = value.segments.map(segment => copyKnownFields(segment, STK_SEGMENT_FIELDS));
  if (Array.isArray(value.polygons)) artwork.polygons = value.polygons.map(polygon => copyKnownFields(polygon, STK_POLYGON_FIELDS));
  if (Array.isArray(value.parameters)) artwork.parameters = value.parameters.map(parameter => copyKnownFields(parameter, STK_PARAMETER_FIELDS));
  // A settled picture table is frozen, so copies share it (and the renderer's decoded images) instead of
  // duplicating its PNG data.
  if (Array.isArray(value.images)) artwork.images = settledImages.has(value.images) ? value.images : value.images.map(image => copyKnownFields(image, STK_IMAGE_FIELDS));
  return artwork;
}

// Imported artwork never changes after import, so one validated, frozen copy is shared by every frame, Undo
// step and playback pose of a figure.  Freezing makes an accidental edit throw instead of silently changing
// every frame, and lets validation be skipped for artwork already checked.
export function settleStkArtwork(value) {
  if (settledArtwork.has(value)) return value;
  validateStkArtwork(value);
  const artwork = deepFreeze(cloneStkArtwork(value));
  settledArtwork.add(artwork);
  if (artwork.images) settledImages.add(artwork.images);
  return artwork;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// The fixed part of an imported figure's joints: the root plus one joint per segment, with the segment's
// thickness, colour and pose-handle visibility.  Posing changes only each joint's length and angle.
export function stkJointTemplate(artwork) {
  if (jointTemplates.has(artwork)) return jointTemplates.get(artwork);
  const template = [{ id: 'stk-root', parentId: null, thickness: 1, color: null, handleVisible: true }];
  for (const segment of artwork.segments) {
    template.push({
      id: `stk-${segment.id}`,
      parentId: segment.parent === 0 ? 'stk-root' : `stk-${segment.parent}`,
      thickness: Math.max(1, segment.width || 1),
      color: segment.color ? `#${segment.color.map(channel => channel.toString(16).padStart(2, '0')).join('')}` : null,
      handleVisible: segment.controlVisible === undefined ? segment.flag === 0 : segment.controlVisible
    });
  }
  if (settledArtwork.has(artwork)) jointTemplates.set(artwork, template);
  return template;
}

// Flipping a figure mirrors its curves.  Artwork is frozen and shared, so the mirrored curves go on a
// settled copy; the pair is remembered, so flipping back returns the original and saves add nothing new.
// Pictures flip too: the flipped segment alone would only turn a picture, so its mirror flag is toggled to
// reflect it across the segment as well, which together amounts to flipping it with the figure.
export function mirrorStkArtwork(artwork) {
  if (mirroredArtworks.has(artwork)) return mirroredArtworks.get(artwork);
  const segments = artwork.segments.map(segment => ({ ...segment, bend: -(Number(segment.bend) || 0),
    ...(isStkPictureSegment(artwork, segment) ? { imageMirror: segment.imageMirror ? 0 : 1 } : {}) }));
  const parameters = artwork.parameters?.map(parameter => segments[parameter.index] ? { ...parameter, value: segments[parameter.index].bend } : parameter);
  const mirrored = settleStkArtwork({ ...artwork, segments, ...(parameters ? { parameters } : {}) });
  if (settledArtwork.has(artwork)) { mirroredArtworks.set(artwork, mirrored); mirroredArtworks.set(mirrored, artwork); }
  return mirrored;
}

// The joints something is drawn at: both ends of every visible segment and every visible polygon corner.
// Invisible construction arms, such as Pivot's slider arms a million units long, are left out.
export function stkDrawnJointIds(artwork) {
  if (drawnJointIds.has(artwork)) return drawnJointIds.get(artwork);
  const jointId = node => node === 0 ? 'stk-root' : `stk-${node}`;
  const ids = new Set();
  for (const segment of artwork.segments) {
    // A picture is drawn whatever its width and transparency.
    if (isStkPictureSegment(artwork, segment)) { ids.add(jointId(segment.parent)); ids.add(jointId(segment.id)); continue; }
    if (Number(segment.transparency) >= 255 && !segment.gradient) continue;
    if (segment.width <= 0 && !isStkFilledCircleSegment(artwork, segment)) continue;
    ids.add(jointId(segment.parent)); ids.add(jointId(segment.id));
  }
  for (const polygon of artwork.polygons) if (Number(polygon.transparency) < 255) polygon.vertices.forEach(vertex => ids.add(jointId(vertex)));
  if (settledArtwork.has(artwork)) drawnJointIds.set(artwork, ids);
  return ids;
}

export function stkJoint(template, length, angle) {
  return new Joint(template.id, template.parentId, length, angle, SEGMENT_LINE, 20, template.thickness, true, template.color, template.handleVisible);
}

export function orderedStkDrawItems(artwork) {
  validateStkArtwork(artwork);
  const itemCount = artwork.drawRanks.length;
  return Array.from({ length: itemCount }, (_, index) => index).sort((a, b) => artwork.drawRanks[a] - artwork.drawRanks[b]);
}

export function decodeStkBytes(payload, wrapper, sourceBytes = 0) {
  const parsed = wrapper === STK_WRAPPER_V2 || wrapper === STK_WRAPPER_V3 ? parseV2V3(payload, wrapper) : wrapper === STK_WRAPPER_V4 ? parseV4(payload) : wrapper === STK_WRAPPER_V5 ? parseV5(payload) : fail(`unsupported STK wrapper 0x${wrapper?.toString(16) || '00'}`);
  parsed.sourceBytes = sourceBytes;
  if (parsed.segments.length > STK_DETAILED_SEGMENTS) parsed.warnings.push(`This figure has ${parsed.segments.length.toLocaleString()} parts, so posing and playing it are slower on older computers.`);
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
  const artwork = settleStkArtwork(decoded);
  const template = stkJointTemplate(artwork);
  const figure = new Figure();
  figure.id = id || `stk-${Math.random().toString(36).slice(2, 11)}`;
  figure.x = x; figure.y = y; figure.scale = 1; figure.color = '#000000';
  figure.stkArtwork = artwork;
  const sourcePoints = [{ x: 0, y: 0 }];
  figure.joints = [stkJoint(template[0], 0, 0)];
  artwork.segments.forEach((segment, index) => {
    const start = sourcePoints[segment.parent];
    const end = endpointFor(segment, start);
    sourcePoints.push(end);
    const chordDx = end.x - start.x;
    const chordDy = end.y - start.y;
    const chordLength = Math.hypot(chordDx, chordDy);
    const chordAngle = chordLength > EPSILON ? Math.atan2(chordDy, chordDx) : segment.angle;
    figure.joints.push(stkJoint(template[index + 1], chordLength, chordAngle));
  });
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
