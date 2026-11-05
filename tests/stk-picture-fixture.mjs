// Builds synthetic Pivot 5 figures with pictures (type-2 segments and their image table) and the small PNG
// images they carry, for the unit and browser tests.  See the layout notes in src/stk-import.js.
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// An 8-bit RGBA PNG; pixel(x, y) returns [r, g, b, a].  `declaredWidth`/`declaredHeight` override the
// header's size without changing the pixel data (for decompression-bomb tests), and `extra` chunks go
// before the image data.
export function pngImage(width, height, pixel = () => [255, 0, 0, 255], { declaredWidth = width, declaredHeight = height, extra = [], idat = true, iend = true } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(declaredWidth, 0); header.writeUInt32BE(declaredHeight, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) Buffer.from(pixel(x, y)).copy(rows, y * (1 + width * 4) + 1 + x * 4);
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), ...extra,
    ...(idat ? [pngChunk('IDAT', zlib.deflateSync(rows))] : []), ...(iend ? [pngChunk('IEND')] : [])]);
}

// A Pivot 5 a8 payload (type, flag and colour bytes; draw ranks).  A segment with `picture: [image, mirror]`
// is type 2 and gets the four picture bytes (`pictureZero` overrides the reserved third byte).  Each image
// is { x1, y1, x2, y2, png }; `endDelta` shifts its stored end offset and `endHigh` sets the offset's high half.
// `imageCount` overrides the count written.
export function picturePayload({ segments, curves = [], images = [], polygons = [], ranks = null, imageCount = images.length, writeImageTable = segments.some(segment => segment.picture) }) {
  const chunks = [Buffer.from([0xa8, segments.length & 0xff, segments.length >> 8])];
  let size = 3;
  const push = chunk => { chunks.push(chunk); size += chunk.length; };
  for (const segment of segments) {
    const record = Buffer.alloc(23 + (segment.picture ? 4 : 0));
    record.writeUInt16LE(segment.parent, 0);
    record.writeFloatLE(segment.length, 2);
    record.writeDoubleLE(segment.angle, 6);
    record.writeFloatLE(segment.width ?? 0, 14);
    record[18] = segment.picture ? 2 : segment.type ?? 0;
    record[19] = segment.flag ?? 0;
    record.set(segment.color ?? [0, 0, 0], 20);
    if (segment.picture) { record.writeUInt16LE(segment.picture[0], 23); record[25] = segment.pictureZero ?? 0; record[26] = segment.picture[1]; }
    push(record);
  }
  const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
  push(u16(curves.length));
  for (const curve of curves) { const record = Buffer.alloc(10); record.writeUInt16LE(curve.index, 0); record.writeDoubleLE(curve.bend, 2); push(record); }
  if (writeImageTable) {
    push(u16(imageCount));
    for (const image of images) {
      const header = Buffer.alloc(24);
      [image.x1, image.y1, image.x2, image.y2].forEach((value, index) => header.writeInt32LE(value, index * 4));
      header.writeUInt32LE(size + 24 + image.png.length + (image.endDelta ?? 0), 16);
      header.writeUInt32LE(image.endHigh ?? 0, 20);
      push(header); push(image.png);
    }
  }
  push(u16(polygons.length));
  for (const polygon of polygons) {
    const record = Buffer.alloc(6 + polygon.vertices.length * 2);
    record.writeUInt16LE(polygon.vertices.length, 0); record.set(polygon.color, 2);
    polygon.vertices.forEach((vertex, index) => record.writeUInt16LE(vertex, 6 + index * 2)); push(record);
  }
  const drawRanks = ranks ?? Array.from({ length: segments.length + polygons.length }, (_, index) => index);
  const tail = Buffer.alloc(drawRanks.length * 2); drawRanks.forEach((rank, index) => tail.writeUInt16LE(rank, index * 2)); push(tail);
  return Buffer.concat(chunks);
}

export function stkFile(payload) {
  return Buffer.concat([Buffer.from([0x7a]), zlib.deflateSync(payload)]);
}

// A small figure: a black line, then a 4 by 2 picture whose anchors (0, 1) -> (4, 1) run along its middle,
// on a 40-unit segment, then a mirrored copy of it hanging down from the line's end.
export function sampleFigure() {
  const png = pngImage(4, 2, (x, y) => (y === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  return picturePayload({
    segments: [
      { parent: 0, length: 30, angle: 0, width: 4 },
      { parent: 1, length: 40, angle: 0, picture: [0, 0] },
      { parent: 1, length: 40, angle: Math.PI / 2, width: 12, picture: [0, 1] }
    ],
    images: [{ x1: 0, y1: 1, x2: 4, y2: 1, png }],
    ranks: [1, 0, 2]
  });
}
