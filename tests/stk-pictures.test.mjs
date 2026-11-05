import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  STK_MAX_IMAGE_BYTES, STK_WRAPPER_V5, createFigureFromStk, decodeStk, decodeStkBytes, mirrorStkArtwork, settleStkArtwork, stkDrawnJointIds, stkImageBytes, validateStkArtwork
} from '../src/stk-import.js';
import { normaliseProject, serializeProject } from '../src/project.js';
import { drawStkFigure, getStkArtworkBounds, loadStkPictures, stkPictureTransform } from '../src/stk-renderer.js';
import { pngChunk, pngImage, picturePayload, sampleFigure, stkFile } from './stk-picture-fixture.mjs';

// Node cannot decode images: this stand-in reads the size from the PNG header, as a browser would report it.
globalThis.createImageBitmap = async blob => { const header = new DataView(await blob.arrayBuffer()); return { width: header.getUint32(16), height: header.getUint32(20), stub: true }; };

function recordingContext() {
  const calls = [];
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineCap: 'round', lineJoin: 'round', lineWidth: 1, globalAlpha: 1, imageSmoothingEnabled: true };
  const context = new Proxy(state, {
    get(target, key) { return key in target ? target[key] : (...args) => { calls.push({ name: String(key), args, smoothing: target.imageSmoothingEnabled }); }; },
    set(target, key, value) { target[key] = value; return true; }
  });
  return { context, calls };
}

const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
const near = (actual, expected, label) => {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.y - expected.y) < 1e-9, `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};

test('decodes Pivot 5 picture segments and their image table', () => {
  const decoded = decodeStkBytes(sampleFigure(), STK_WRAPPER_V5);
  assert.equal(decoded.images.length, 1);
  const [image] = decoded.images;
  assert.deepEqual([image.x1, image.y1, image.x2, image.y2, image.width, image.height], [0, 1, 4, 1, 4, 2]);
  assert.deepEqual(Buffer.from(stkImageBytes(image)), pngImage(4, 2, (x, y) => (y === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255])));
  assert.deepEqual(decoded.segments.map(segment => [segment.type, segment.image, segment.imageMirror]), [[0, undefined, undefined], [2, 0, 0], [2, 0, 1]]);
  assert.ok(decoded.warnings.some(warning => warning.includes('Pictures are drawn')));
  validateStkArtwork(decoded);
  // A figure without pictures gains no picture fields.
  const plain = decodeStkBytes(picturePayload({ segments: [{ parent: 0, length: 10, angle: 0, width: 2 }] }), STK_WRAPPER_V5);
  assert.equal('images' in plain, false);
});

test('places each picture so its anchors sit on the segment ends, mirrored across the segment when flagged', () => {
  const image = { x1: 2, y1: 3, x2: 12, y2: 3, width: 20, height: 10 };
  const start = { x: 100, y: 50 }, end = { x: 100, y: 90 };
  for (const mirrored of [false, true]) {
    const m = stkPictureTransform(start, end, image, mirrored);
    near(apply(m, 2, 3), start, 'first anchor'); near(apply(m, 12, 3), end, 'second anchor');
    assert.equal(m.scale, 4);
    // Image "down" (+y) turns to the segment's right-hand side, or its left when mirrored.
    const below = apply(m, 2, 4);
    assert.ok(Math.abs(below.x - (mirrored ? 104 : 96)) < 1e-9, `mirrored=${mirrored}`);
  }
  assert.equal(stkPictureTransform(start, start, image, false), null);
});

test('draws pictures in draw-rank order once decoded, with hard edges only when enlarged', async () => {
  const figure = createFigureFromStk(decodeStkBytes(sampleFigure(), STK_WRAPPER_V5), { x: 10, y: 20 });
  let first = recordingContext();
  drawStkFigure({ context: first.context, figure });
  assert.equal(first.calls.filter(call => call.name === 'drawImage').length, 0, 'nothing is drawn for a picture still decoding');
  await loadStkPictures(figure.stkArtwork);
  first = recordingContext();
  drawStkFigure({ context: first.context, figure });
  const order = first.calls.filter(call => call.name === 'drawImage' || call.name === 'stroke').map(call => call.name);
  // Ranks [1, 0, 2]: the first picture, then the line, then the second picture.
  assert.deepEqual(order, ['drawImage', 'stroke', 'drawImage']);
  const transforms = first.calls.filter(call => call.name === 'transform').map(call => call.args);
  near(apply({ a: transforms[0][0], b: transforms[0][1], c: transforms[0][2], d: transforms[0][3], e: transforms[0][4], f: transforms[0][5] }, 0, 1), { x: 40, y: 20 }, 'picture start');
  near(apply({ a: transforms[0][0], b: transforms[0][1], c: transforms[0][2], d: transforms[0][3], e: transforms[0][4], f: transforms[0][5] }, 4, 1), { x: 80, y: 20 }, 'picture end');
  const [a, b, c, d] = transforms[1];
  assert.ok(a * d - b * c < 0, 'the mirrored picture is reflected');
  // 4 pixels across 40 units is enlarged, so drawn without smoothing; shrunk, it is smoothed.
  assert.deepEqual(first.calls.filter(call => call.name === 'drawImage').map(call => call.smoothing), [false, false]);
  figure.scale = 0.05; figure.joints.forEach(joint => { joint.length *= 0.05; });
  const shrunk = recordingContext();
  drawStkFigure({ context: shrunk.context, figure });
  assert.deepEqual(shrunk.calls.filter(call => call.name === 'drawImage').map(call => call.smoothing), [true, true]);
});

test('bounds cover the placed images and drawn joints include width-0 pictures', () => {
  const artwork = settleStkArtwork(decodeStkBytes(sampleFigure(), STK_WRAPPER_V5));
  const figure = createFigureFromStk(artwork, { x: 0, y: 0 });
  // The line runs 0..30; the first picture covers x 30..70 and y -10..10 (scale 10, rows 0..2 around row 1);
  // the second hangs from (30, 0) to (30, 40) and, mirrored, spreads x 20..40.
  const bounds = getStkArtworkBounds(figure);
  assert.ok(Math.abs(bounds.minX - (-2)) < 1e-9 && Math.abs(bounds.maxX - 70) < 1e-9, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.minY - (-10)) < 1e-9 && Math.abs(bounds.maxY - 40) < 1e-9, JSON.stringify(bounds));
  assert.deepEqual([...stkDrawnJointIds(artwork)].sort(), ['stk-1', 'stk-2', 'stk-3', 'stk-root']);
});

test('flipping a figure flips its pictures with it and shares the decoded images', async () => {
  const artwork = settleStkArtwork(decodeStkBytes(sampleFigure(), STK_WRAPPER_V5));
  const mirrored = mirrorStkArtwork(artwork);
  assert.deepEqual(mirrored.segments.map(segment => segment.imageMirror), [undefined, 1, 0]);
  assert.equal(mirrored.images, artwork.images);
  assert.equal(mirrorStkArtwork(mirrored), artwork);
  // Flip as the editor does (each joint angle becomes π − angle about the root) and compare with
  // reflecting the original drawing across the root's vertical line.
  const figure = createFigureFromStk(artwork, { x: 50, y: 0 });
  figure.updatePositions();
  const before = getStkArtworkBounds(figure);
  const flipped = figure.clone();
  flipped.joints.forEach(joint => { if (joint.parentId !== null) joint.angle = Math.PI - joint.angle; });
  flipped.stkArtwork = mirrored;
  flipped.updatePositions();
  const after = getStkArtworkBounds(flipped);
  assert.ok(Math.abs(after.minX - (100 - before.maxX)) < 1e-9 && Math.abs(after.maxX - (100 - before.minX)) < 1e-9);
  for (const index of [1, 2]) {
    const segment = artwork.segments[index], image = artwork.images[0];
    const node = (fig, id) => { const joints = new Map(fig.joints.map(joint => [joint.id, joint])); const j = joints.get(`stk-${id}`); const p = joints.get(j.parentId); return [{ x: p.x, y: p.y }, { x: j.x, y: j.y }]; };
    const original = stkPictureTransform(...node(figure, segment.id), image, segment.imageMirror === 1);
    const turned = stkPictureTransform(...node(flipped, segment.id), image, mirrored.segments[index].imageMirror === 1);
    for (const [x, y] of [[0, 0], [4, 0], [0, 2], [4, 2]]) {
      const point = apply(original, x, y);
      near(apply(turned, x, y), { x: 100 - point.x, y: point.y }, `segment ${segment.id} pixel ${x},${y}`);
    }
  }
});

test('a project saves each picture figure once and reopens it unchanged', async () => {
  const artwork = settleStkArtwork(decodeStkBytes(sampleFigure(), STK_WRAPPER_V5));
  const one = createFigureFromStk(artwork, { x: 100, y: 100, id: 'one' });
  const two = createFigureFromStk(mirrorStkArtwork(artwork), { x: 300, y: 100, id: 'two' });
  const saved = JSON.parse(JSON.stringify(serializeProject({ frames: [[one, two], [one.clone()]], docWidth: 800, docHeight: 500, fps: 12, frameDelays: [1, 1], currentFrameIndex: 0, groups: [] })));
  assert.equal(Object.keys(saved.stkArtworks).length, 2);
  assert.equal(JSON.stringify(saved).split(artwork.images[0].data).length - 1, 2, 'the PNG data is saved once per artwork');
  const reopened = normaliseProject(saved);
  const reopenedArtwork = reopened.frames[0][0].stkArtwork;
  assert.deepEqual(JSON.parse(JSON.stringify(reopenedArtwork)), JSON.parse(JSON.stringify(artwork)));
  assert.equal(reopened.frames[1][0].stkArtwork, reopenedArtwork);
  assert.ok(Object.isFrozen(reopenedArtwork.images) && Object.isFrozen(reopenedArtwork.images[0]));
  assert.deepEqual(reopened.frames[0][1].stkArtwork.segments.map(segment => segment.imageMirror), [undefined, 1, 0]);
  await loadStkPictures(reopenedArtwork);
  const { context, calls } = recordingContext();
  drawStkFigure({ context, figure: reopened.frames[0][0] });
  assert.equal(calls.filter(call => call.name === 'drawImage').length, 2);
});

test('the figure outline is not traced around pictures', () => {
  const payload = sampleFigure();
  const decoded = decodeStkBytes(payload, STK_WRAPPER_V5);
  const withOutline = settleStkArtwork({ ...decoded, payloadHeader: 'e80300', figureTrailer: [2, 0, 0, 0, 0] });
  const { context, calls } = recordingContext();
  drawStkFigure({ context, figure: createFigureFromStk(withOutline) });
  // One outline stroke for the line, then the line itself; neither picture is outlined.
  assert.equal(calls.filter(call => call.name === 'stroke').length, 2);
});

function expectRejected(payload, pattern, label) {
  assert.throws(() => decodeStkBytes(payload, STK_WRAPPER_V5), error => error.message.startsWith('STK import rejected:') && pattern.test(error.message), label);
}

test('rejects malformed picture records and image tables cleanly', async () => {
  const png = pngImage(4, 2);
  const segments = [{ parent: 0, length: 40, angle: 0, picture: [0, 0] }];
  const image = { x1: 0, y1: 1, x2: 4, y2: 1, png };
  expectRejected(picturePayload({ segments, images: [{ ...image, png: Buffer.concat([Buffer.from('notapng!'), png.subarray(8)]) }] }), /is not a PNG image/, 'signature');
  expectRejected(picturePayload({ segments, images: [{ ...image, endDelta: -1 }] }), /PNG|end/, 'end offset short of the PNG');
  expectRejected(picturePayload({ segments, images: [{ ...image, png: Buffer.concat([png, Buffer.from([0, 0, 0, 0])]) }] }), /does not end where/, 'bytes after IEND');
  expectRejected(picturePayload({ segments, images: [{ ...image, endDelta: 100000 }] }), /invalid end offset/, 'end offset past the payload');
  expectRejected(picturePayload({ segments, images: [{ ...image, endHigh: 1 }] }), /invalid end offset/, 'high half of the end offset');
  expectRejected(picturePayload({ segments, images: [{ ...image, png: pngImage(4, 2, undefined, { iend: false }) }] }), /end marker|does not end/, 'no IEND');
  expectRejected(picturePayload({ segments, images: [{ ...image, png: pngImage(4, 2, undefined, { idat: false }) }] }), /no PNG image data/, 'no IDAT');
  expectRejected(picturePayload({ segments, images: [image], imageCount: 0 }), /image count/, 'no images');
  expectRejected(picturePayload({ segments: [{ ...segments[0], picture: [1, 0] }], images: [image] }), /missing picture image/, 'index out of range');
  expectRejected(picturePayload({ segments: [{ ...segments[0], picture: [0, 2] }], images: [image] }), /picture settings/, 'mirror flag');
  expectRejected(picturePayload({ segments: [{ ...segments[0], pictureZero: 1 }], images: [image] }), /picture settings/, 'reserved byte');
  expectRejected(picturePayload({ segments, images: [{ ...image, x2: 0 }] }), /same pixel/, 'coincident anchors');
  expectRejected(picturePayload({ segments, curves: [{ index: 0, bend: 0.5 }], images: [image] }), /bends a picture/, 'curved picture');
  expectRejected(picturePayload({ segments, images: [image] }).subarray(0, 3 + 25), /picture section is incomplete/,'truncated picture record');
  expectRejected(picturePayload({ segments, images: [image], writeImageTable: false }), /image count|incomplete|unsupported/, 'missing image table');
  // Decompression bombs: a tiny PNG claiming a huge size is refused before any decoding.
  expectRejected(picturePayload({ segments, images: [{ ...image, png: pngImage(4, 2, undefined, { declaredWidth: 5000, declaredHeight: 2 }) }] }), /outside the supported size/, 'too wide');
  expectRejected(picturePayload({ segments, images: [{ ...image, png: pngImage(4, 2, undefined, { declaredWidth: 4000, declaredHeight: 4000 }) }] }), /outside the supported size/, 'too many pixels');
  const big = pngImage(4, 2, undefined, { declaredWidth: 2048, declaredHeight: 2048 });
  expectRejected(picturePayload({ segments, images: Array.from({ length: 5 }, () => ({ ...image, png: big })) }), /pixel safety limit/, 'too many pixels in all');
  const padded = pngImage(4, 2, undefined, { extra: [pngChunk('tEXt', Buffer.alloc(STK_MAX_IMAGE_BYTES / 2))] });
  expectRejected(picturePayload({ segments, images: [{ ...image, png: padded }, { ...image, png: padded }] }), /byte safety limit/, 'too many bytes');
  // The whole file path gives the same clean rejection.
  await assert.rejects(() => decodeStk(stkFile(picturePayload({ segments, images: [{ ...image, endDelta: -3 }] }))), /STK import rejected/);
});

async function savedPictureProject() {
  const figure = createFigureFromStk(decodeStkBytes(sampleFigure(), STK_WRAPPER_V5), { x: 100, y: 100, id: 'picture-figure' });
  return JSON.parse(JSON.stringify(serializeProject({ frames: [[figure]], docWidth: 800, docHeight: 500, fps: 12, frameDelays: [1], currentFrameIndex: 0, groups: [] })));
}

test('reopening a project checks picture data as strictly as importing it', async () => {
  const artworkOf = project => Object.values(project.stkArtworks)[0];
  const hostile = await savedPictureProject();
  artworkOf(hostile).images[0].junk = 'x'.repeat(1000);
  artworkOf(hostile).segments[1].junk = 1;
  assert.ok(!JSON.stringify(normaliseProject(hostile).frames[0][0].stkArtwork).includes('junk'));
  const bomb = Buffer.from(pngImage(4, 2, undefined, { declaredWidth: 4096, declaredHeight: 4096 })).toString('base64');
  const cases = [
    ['not base64', artwork => { artwork.images[0].data = '!!!!'; }],
    ['not a PNG', artwork => { artwork.images[0].data = Buffer.from('hello world, not a png at all, really not; padding padding').toString('base64'); }],
    ['truncated PNG', artwork => { artwork.images[0].data = Buffer.from(stkImageBytes(artwork.images[0])).subarray(0, 60).toString('base64'); }],
    ['wrong recorded size', artwork => { artwork.images[0].width = 400; }],
    ['bomb', artwork => { artwork.images[0].data = bomb; artwork.images[0].width = 4096; artwork.images[0].height = 4096; }],
    ['coincident anchors', artwork => { artwork.images[0].x2 = 0; }],
    ['fractional anchor', artwork => { artwork.images[0].x1 = 0.5; }],
    ['missing image', artwork => { artwork.segments[1].image = 3; }],
    ['bad mirror flag', artwork => { artwork.segments[1].imageMirror = true; }],
    ['curved picture', artwork => { artwork.segments[1].bend = 0.3; }],
    ['picture fields on a line', artwork => { artwork.segments[0].image = 0; }],
    ['images without pictures', artwork => { artwork.segments[1].type = 0; delete artwork.segments[1].image; delete artwork.segments[1].imageMirror; artwork.segments[2].type = 0; delete artwork.segments[2].image; delete artwork.segments[2].imageMirror; }],
    ['pictures without images', artwork => { delete artwork.images; }],
    ['empty image table', artwork => { artwork.images = []; }],
    ['oversized data', artwork => { artwork.images[0].data = 'AAAA'.repeat(Math.ceil(STK_MAX_IMAGE_BYTES / 3) + 1); }]
  ];
  for (const [label, corrupt] of cases) {
    const project = await savedPictureProject();
    corrupt(artworkOf(project));
    assert.throws(() => normaliseProject(project), /STK import rejected/, label);
  }
});

// The thirteen library figures with pictures (private; skipped when absent).
const libraryFolder = new URL('../stk/library/', import.meta.url);
const pictureFigures = { '01f9': 21, '00kz': 18, '01ib': 6, '01kn': 6, '01ke': 2, '00qv': 2, '00nn': 15, '01py': 3, '007p': 12, '00yu': 1, '01fg': 8, '019o': 4, '015s': 3 };
for (const [id, pictures] of Object.entries(pictureFigures)) {
  const file = new URL(`${id}.stk`, libraryFolder);
  test(`library picture figure ${id} imports, draws its ${pictures} pictures and survives save and reopen`, { skip: !fs.existsSync(file) }, async () => {
    const decoded = await decodeStk(fs.readFileSync(file));
    const figure = createFigureFromStk(decoded, { x: 400, y: 300 });
    await loadStkPictures(figure.stkArtwork);
    const { context, calls } = recordingContext();
    drawStkFigure({ context, figure });
    assert.equal(calls.filter(call => call.name === 'drawImage').length, pictures);
    const saved = JSON.parse(JSON.stringify(serializeProject({ frames: [[figure]], docWidth: 800, docHeight: 500, fps: 12, frameDelays: [1], currentFrameIndex: 0, groups: [] })));
    assert.deepEqual(JSON.parse(JSON.stringify(normaliseProject(saved).frames[0][0].stkArtwork)), JSON.parse(JSON.stringify(figure.stkArtwork)));
  });
}

test('the Pivot 3 Hummer picture stays rejected', { skip: !fs.existsSync(new URL('00qo.stk', libraryFolder)) }, async () => {
  await assert.rejects(() => decodeStk(fs.readFileSync(new URL('00qo.stk', libraryFolder))), /STK import rejected: Pivot 3 payload has unsupported trailing data/);
});
