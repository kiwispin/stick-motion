import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { Figure, Joint } from '../src/models.js';
import { createSnapshot } from '../src/history.js';
import { normaliseProject, serializeProject } from '../src/project.js';
import { createFigureFromStk, decodeStk } from '../src/stk-import.js';

// A Pivot 5 (a8) figure: a chain of `count` segments with varied angles, flags and colours.
function chainStk(count) {
  const payload = Buffer.alloc(3 + count * 23 + 4 + count * 2);
  payload[0] = 0xa8; payload.writeUInt16LE(count, 1);
  for (let index = 0; index < count; index += 1) {
    const offset = 3 + index * 23;
    payload.writeUInt16LE(index, offset);
    payload.writeFloatLE(5, offset + 2);
    payload.writeDoubleLE(0.01 * index, offset + 6);
    payload.writeFloatLE(2 + (index % 3), offset + 14);
    payload[offset + 19] = index % 7 ? 1 : 0;
    payload.set([index % 256, 10, 20], offset + 20);
  }
  const tables = 3 + count * 23 + 4;
  for (let index = 0; index < count; index += 1) payload.writeUInt16LE(index, tables + index * 2);
  return Buffer.concat([Buffer.from([0x7a]), zlib.deflateSync(payload)]);
}

const stateWith = frames => ({ frames, frameDelays: frames.map(() => 1), groups: [], docWidth: 800, docHeight: 500, fps: 12, currentFrameIndex: 0 });
const roundTrip = state => normaliseProject(JSON.parse(JSON.stringify(serializeProject(state))));
const sameAngle = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-9;

async function posedFrames(count, frameCount) {
  const figure = createFigureFromStk(await decodeStk(chainStk(count)), { x: 100, y: 120, id: 'big' });
  return Array.from({ length: frameCount }, (_, frame) => {
    const posed = figure.clone();
    posed.x += frame * 10;
    posed.joints.forEach((joint, index) => { if (index) joint.angle += frame * 0.05; });
    return [posed];
  });
}

test('saves imported artwork once and only a compact pose per frame, without losing anything', async () => {
  const frames = await posedFrames(300, 3);
  const saved = serializeProject(stateWith(frames));
  assert.equal(saved.version, 6);
  assert.deepEqual(Object.keys(saved.stkArtworks), ['stk1']);
  for (const [figureData] of saved.frames) {
    assert.equal(figureData.stkArtworkRef, 'stk1');
    assert.equal(figureData.stkPose.length, 301);
    assert.equal(figureData.joints, undefined);
    assert.equal(figureData.stkArtwork, undefined);
  }
  const legacySize = JSON.stringify({ frames }).length;
  assert.ok(JSON.stringify(saved).length < legacySize / 2, 'the compact format is much smaller than one artwork copy per frame');

  const reopened = roundTrip(stateWith(frames));
  const artworks = new Set(reopened.frames.map(([figure]) => figure.stkArtwork));
  assert.equal(artworks.size, 1, 'every frame shares one artwork after reopening');
  assert.ok(Object.isFrozen([...artworks][0]));
  reopened.frames.forEach(([figure], frame) => {
    const original = frames[frame][0];
    assert.equal(figure.x, original.x);
    figure.joints.forEach((joint, index) => {
      const expected = original.joints[index];
      assert.deepEqual([joint.id, joint.parentId, joint.thickness, joint.color, joint.handleVisible], [expected.id, expected.parentId, expected.thickness, expected.color, expected.handleVisible]);
      assert.ok(Math.abs(joint.length - expected.length) < 1e-9 && sameAngle(joint.angle, expected.angle));
    });
  });
});

test('keeps the full joint list for an imported figure whose joints differ from its artwork', async () => {
  const frames = await posedFrames(20, 2);
  frames[1][0].joints[5].color = '#123456';
  const saved = serializeProject(stateWith(frames));
  assert.ok(saved.frames[0][0].stkPose);
  assert.ok(Array.isArray(saved.frames[1][0].joints) && !saved.frames[1][0].stkPose);
  assert.equal(saved.frames[1][0].stkArtworkRef, 'stk1');
  assert.equal(roundTrip(stateWith(frames)).frames[1][0].joints[5].color, '#123456');
});

test('opens version 5 projects that embed the artwork in every frame, sharing identical copies', async () => {
  const frames = await posedFrames(40, 3);
  const legacy = JSON.parse(JSON.stringify({ version: 5, frames, delays: [1, 1, 1] }));
  assert.ok(legacy.frames.every(([figure]) => figure.stkArtwork && figure.joints));
  const reopened = normaliseProject(legacy);
  assert.equal(new Set(reopened.frames.map(([figure]) => figure.stkArtwork)).size, 1);
  assert.ok(sameAngle(reopened.frames[2][0].joints[10].angle, frames[2][0].joints[10].angle));
});

test('rejects malformed version 6 projects', async () => {
  const project = async () => JSON.parse(JSON.stringify(serializeProject(stateWith(await posedFrames(10, 1)))));
  const cases = [
    ['missing artwork', p => { p.frames[0][0].stkArtworkRef = 'stk9'; }, /missing STK artwork/],
    ['pose too short', p => { p.frames[0][0].stkPose.pop(); }, /invalid STK pose/],
    ['pose entry not a pair', p => { p.frames[0][0].stkPose[3] = [1]; }, /invalid STK pose/],
    ['pose entry not numbers', p => { p.frames[0][0].stkPose[3] = ['1', 0]; }, /invalid STK pose/],
    ['pose length out of range', p => { p.frames[0][0].stkPose[3] = [1e9, 0]; }, /joint length/],
    ['pose without artwork', p => { delete p.frames[0][0].stkArtworkRef; }, /pose but no STK artwork/],
    ['artwork table not an object', p => { p.stkArtworks = [1, 2]; }, /artwork table is malformed/],
    ['invalid artwork in the table', p => { p.stkArtworks.stk1.segments = 'junk'; }, /STK import rejected/],
    ['too many artworks', p => { for (let index = 2; index <= 1001; index += 1) p.stkArtworks[`stk${index}`] = p.stkArtworks.stk1; }, /at most 1000/]
  ];
  for (const [label, corrupt, error] of cases) {
    const data = await project();
    corrupt(data);
    assert.throws(() => normaliseProject(data), error, label);
  }
});

test('figure clones share imported artwork, which cannot be changed', async () => {
  const figure = createFigureFromStk(await decodeStk(chainStk(5)));
  const clone = figure.clone();
  assert.equal(clone.stkArtwork, figure.stkArtwork);
  assert.ok(Object.isFrozen(figure.stkArtwork) && Object.isFrozen(figure.stkArtwork.segments[0]) && Object.isFrozen(figure.stkArtwork.segments[0].color));
  assert.throws(() => { figure.stkArtwork.segments[0].width = 99; }, TypeError);
  assert.throws(() => { figure.stkArtwork.segments.push({}); }, TypeError);
});

test('very deep figures update their positions without overflowing the call stack', () => {
  const figure = new Figure();
  figure.x = 0; figure.y = 0;
  figure.joints = [new Joint('root', null, 0, 0), ...Array.from({ length: 20000 }, (_, index) => new Joint(`joint-${index}`, index ? `joint-${index - 1}` : 'root', 1, 0))];
  figure.updatePositions();
  assert.equal(figure.joints.at(-1).x, 20000);
});

test('undo snapshots share stored frames instead of copying them', () => {
  const frames = [[new Figure()], [new Figure()]];
  const snapshot = createSnapshot({ frames, frameDelays: [1, 1], currentFrameIndex: 0, figures: frames[0].map(figure => figure.clone()), groups: [] });
  assert.notEqual(snapshot.frames, frames);
  assert.equal(snapshot.frames[0], frames[0]);
  assert.equal(snapshot.frames[1], frames[1]);
  assert.notEqual(snapshot.figures[0], frames[0][0], 'the stage is copied');
});
