import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { Figure, FigureGroup, Joint, SEGMENT_CIRCLE } from '../src/models.js';
import { createSnapshot } from '../src/history.js';
import { normaliseProject, serializeProject, serializeProjectJson } from '../src/project.js';
import { createFigureFromStk, decodeStk, mirrorStkArtwork } from '../src/stk-import.js';

// serializeProjectJson (autosave and project files) reuses each frame's JSON from earlier saves.  Whatever
// the edits, it must give exactly the text the plain serialiser gives.
const plain = state => JSON.stringify(serializeProject(state));
function assertSame(state, label) {
  const fast = serializeProjectJson(state);
  if (fast !== plain(state)) assert.equal(fast, plain(state), label); // compare only on a mismatch: the strings are long
}

// A Pivot 5 (a8) figure: a chain of `count` segments.
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

// An imported figure; with `bend`, every other part is curved, so flipping it gives different artwork.
async function stkFigure(count, id, bend = 0) {
  const decoded = await decodeStk(chainStk(count));
  if (bend) decoded.segments.forEach((segment, index) => { if (index % 2) segment.bend = bend; });
  return createFigureFromStk(decoded, { id });
}

// A small seeded random source, so a failure can be replayed.
function random(seed) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

let nextId = 0;
function stickman(x, y) {
  const figure = new Figure();
  figure.id = `fig${nextId++}`; figure.x = x; figure.y = y;
  figure.joints = [new Joint('root', null, 0, 0), new Joint('neck', 'root', 30, -Math.PI / 2), new Joint('head', 'neck', 15, -Math.PI / 2, SEGMENT_CIRCLE, 12),
    new Joint('armL', 'neck', 25, 2.5), new Joint('armR', 'neck', 25, 0.6), new Joint('legL', 'root', 35, 2), new Joint('legR', 'root', 35, 1.1)];
  return figure;
}

function newState() {
  return {
    projectName: 'Fast "save" é世 😀', docWidth: 800, docHeight: 500, fps: 12,
    frames: [[stickman(100, 200), stickman(300, 200)]], frameDelays: [1], currentFrameIndex: 0, groups: [], backgroundData: null,
    isLooping: true, isSmooth: true, showOnion: true, showPivots: true, showPath: true, onionBefore: 1, onionAfter: 0, fileSaved: false
  };
}

// Edits made the way the editor makes them: a changed frame is a new array of new or shared figures, and
// a stored frame or figure is never changed in place.
const replaceFigure = (state, frameIndex, figureIndex, change) => {
  state.frames[frameIndex] = state.frames[frameIndex].map((figure, index) => {
    if (index !== figureIndex) return figure;
    const copy = figure.clone(); change(copy); return copy;
  });
};

async function editSequence(seed, steps) {
  const rand = random(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const artworks = [await stkFigure(6, 'stkA'), await stkFigure(14, 'stkB', 0.4), await stkFigure(3, 'stkC', -0.7)];
  const state = newState();
  const history = [];
  let clipboard = null;
  const current = () => state.frames[state.currentFrameIndex];
  const edits = {
    addFrame() { state.frames.splice(state.currentFrameIndex + 1, 0, current().map(f => f.clone())); state.frameDelays.splice(state.currentFrameIndex + 1, 0, 1); state.currentFrameIndex += 1; },
    deleteFrame() { if (state.frames.length < 2) return; state.frames.splice(state.currentFrameIndex, 1); state.frameDelays.splice(state.currentFrameIndex, 1); state.currentFrameIndex = Math.min(state.currentFrameIndex, state.frames.length - 1); },
    moveFrame() { const from = Math.floor(rand() * state.frames.length), to = Math.floor(rand() * state.frames.length); const [frame] = state.frames.splice(from, 1); const [delay] = state.frameDelays.splice(from, 1); state.frames.splice(to, 0, frame); state.frameDelays.splice(to, 0, delay); },
    copyFrames() { clipboard = state.frames.slice(0, 1 + Math.floor(rand() * 3)).map(frame => frame.map(f => f.clone())); },
    pasteFrames() {
      if (!clipboard) return;
      const groupIds = new Set(state.groups.map(g => g.id));
      state.frames.splice(state.currentFrameIndex + 1, 0, ...clipboard.map(frame => frame.map(f => { const copy = f.clone(); if (copy.groupId && !groupIds.has(copy.groupId)) copy.groupId = null; return copy; })));
      state.frameDelays.splice(state.currentFrameIndex + 1, 0, ...clipboard.map(() => 1));
    },
    goToFrame() { state.currentFrameIndex = Math.floor(rand() * state.frames.length); },
    addStickman() { state.frames[state.currentFrameIndex] = [...current().map(f => f.clone()), stickman(rand() * 800, rand() * 500)]; },
    importStk() { const figure = pick(artworks).clone(); figure.id = `stk${nextId++}`; figure.x = rand() * 800; state.frames[state.currentFrameIndex] = [...current(), figure]; },
    deleteFigure() { if (!current().length) return; const gone = Math.floor(rand() * current().length); state.frames[state.currentFrameIndex] = current().filter((_, index) => index !== gone); },
    moveFigure() { if (!current().length) return; replaceFigure(state, state.currentFrameIndex, Math.floor(rand() * current().length), f => { f.x += rand() * 40 - 20; f.y += 3; }); },
    pose() { if (!current().length) return; replaceFigure(state, state.currentFrameIndex, Math.floor(rand() * current().length), f => { const joint = pick(f.joints.slice(1)); joint.angle = rand() * 6 - 3; joint.length *= 1.1; }); },
    scaleAndColour() { if (!current().length) return; replaceFigure(state, state.currentFrameIndex, Math.floor(rand() * current().length), f => { f.scale *= 1.25; f.color = '#12ab34'; f.selected = rand() < 0.5; }); },
    flip() {
      const stkIndex = current().findIndex(f => f.stkArtwork);
      if (stkIndex < 0) return;
      replaceFigure(state, state.currentFrameIndex, stkIndex, f => { f.joints.forEach(j => { if (j.parentId !== null) j.angle = Math.PI - j.angle; }); f.stkArtwork = mirrorStkArtwork(f.stkArtwork); });
    },
    // An imported figure whose joints no longer match its artwork is saved with its full joint list.
    restyleImportedJoint() { const stkIndex = current().findIndex(f => f.stkArtwork); if (stkIndex >= 0) replaceFigure(state, state.currentFrameIndex, stkIndex, f => { f.joints[2].color = '#654321'; }); },
    text() { const figure = stickman(50, 50); figure.type = 'speech'; figure.text = pick(['Hi "there"', '"stkArtworkRef":"stk1"', 'line\nbreak \\ back', '   café', '']); state.frames[state.currentFrameIndex] = [...current(), figure]; },
    group() {
      const ids = current().slice(0, 2).map(f => f.id);
      if (ids.length < 2) return;
      const gid = `g${nextId++}`;
      state.groups = [...state.groups.map(g => g.clone()), new FigureGroup(gid, ids, `Group "${state.groups.length + 1}"`)];
      state.frames = state.frames.map(frame => { let changed = false; const next = frame.map(f => { if (!ids.includes(f.id)) return f; changed = true; const copy = f.clone(); copy.groupId = gid; return copy; }); return changed ? next : frame; });
    },
    ungroup() {
      if (!state.groups.length) return;
      const gid = state.groups[0].id;
      state.groups = state.groups.slice(1);
      state.frames = state.frames.map(frame => { let changed = false; const next = frame.map(f => { if (f.groupId !== gid) return f; changed = true; const copy = f.clone(); copy.groupId = null; return copy; }); return changed ? next : frame; });
    },
    background() { state.backgroundData = pick([null, 'data:image/png;base64,AAAA', `data:image/png;base64,${'QUJD'.repeat(2000)}`, 'data:image/gif;base64,R0lGODlh']); },
    settings() {
      const key = pick(['isLooping', 'isSmooth', 'showOnion', 'showPivots', 'showPath', 'fileSaved']);
      state[key] = !state[key];
      state.onionBefore = Math.floor(rand() * 4); state.onionAfter = Math.floor(rand() * 4);
      state.fps = 1 + Math.floor(rand() * 30); state.docWidth = 400 + Math.floor(rand() * 400);
      state.projectName = pick(['Untitled animation', 'My "film"', '', 'café 🎬']);
    },
    delay() { state.frameDelays = state.frameDelays.map((delay, index) => index === state.currentFrameIndex ? 0.5 + rand() * 4 : delay); },
    undo() { if (history.length) Object.assign(state, history.pop()); },
    reopen() { // what loading the autosaved draft gives: new arrays and figures, artwork shared by reference
      const d = normaliseProject(JSON.parse(serializeProjectJson(state)));
      Object.assign(state, { frames: d.frames, frameDelays: d.delays, currentFrameIndex: d.index, groups: d.groups, backgroundData: d.backgroundData });
    }
  };
  const names = Object.keys(edits);
  for (let step = 0; step < steps; step += 1) {
    const name = pick(names);
    // An Undo step shares the frame arrays, as the editor's snapshots do (this state has no separate stage).
    if (name !== 'undo' && rand() < 0.5) { const { figures, ...snapshot } = createSnapshot({ ...state, figures: [] }); history.push(snapshot); }
    edits[name]();
    assertSame(state, `seed ${seed}, step ${step} (${name})`);
  }
  return state;
}

test('the fast save gives exactly the plain JSON through long runs of editing', async () => {
  for (const seed of [1, 7, 42, 2024, 99991]) {
    const state = await editSequence(seed, 300);
    assert.ok(state.frames.length > 0);
  }
});

test('artwork references are numbered in first-use order across frames, as before', async () => {
  const a = await stkFigure(4, 'a');
  const b = await stkFigure(9, 'b', 0.5);
  const flippedB = b.clone(); flippedB.stkArtwork = mirrorStkArtwork(b.stkArtwork);
  assert.notEqual(JSON.stringify(flippedB.stkArtwork), JSON.stringify(b.stkArtwork));
  const state = newState();
  state.frames = [[stickman(1, 1)], [b, a], [a.clone(), flippedB], [flippedB.clone(), b.clone()]];
  state.frameDelays = [1, 1, 1, 1];
  assertSame(state);
  const saved = JSON.parse(serializeProjectJson(state));
  assert.deepEqual(Object.keys(saved.stkArtworks), ['stk1', 'stk2', 'stk3']);
  assert.deepEqual(saved.frames.slice(1).map(frame => frame.map(f => f.stkArtworkRef)), [['stk1', 'stk2'], ['stk2', 'stk3'], ['stk3', 'stk1']]);
  // Moving the frames reorders the numbers, though every frame's JSON comes from the cache.
  state.frames = [state.frames[2], state.frames[0], state.frames[3], state.frames[1]];
  assertSame(state);
  assert.deepEqual(JSON.parse(serializeProjectJson(state)).frames[0].map(f => f.stkArtworkRef), ['stk1', 'stk2']);
  // Without imported figures there is no artwork table at all.
  state.frames = [[stickman(5, 5)]];
  assertSame(state);
  assert.equal('stkArtworks' in JSON.parse(serializeProjectJson(state)), false);
});

test('the fast save matches on edge cases: empty frames, missing values and unusual fields', async () => {
  const state = newState();
  state.frames = [[], [stickman(0, 0)], []];
  state.frameDelays = [1, 2, 3];
  assertSame(state, 'empty frames');
  const odd = stickman(1, 2);
  odd.text = undefined; odd.scale = NaN; odd.extra = { note: 'kept' }; // undefined is dropped and NaN becomes null, as JSON does
  state.frames = [[odd]];
  assertSame(state, 'odd figure fields');
  const imported = await stkFigure(5, 'imp');
  imported.color = undefined;
  state.frames = [[imported, odd]];
  assertSame(state, 'imported figure with a missing field');
  state.backgroundData = undefined; state.projectName = undefined; state.name = 'Fallback name'; state.groups = undefined; state.fileSaved = 'yes';
  assertSame(state, 'missing project values');
  state.frames = [];
  assertSame(state, 'no frames');
});

test('an edited frame is saved fresh while untouched frames come from the cache', async () => {
  const state = newState();
  state.frames = Array.from({ length: 30 }, (_, index) => [stickman(index, 0), stickman(index, 100)]);
  state.frameDelays = state.frames.map(() => 1);
  const first = serializeProjectJson(state);
  replaceFigure(state, 10, 1, f => { f.x = 12345; });
  const second = serializeProjectJson(state);
  assert.notEqual(second, first);
  assert.equal(JSON.parse(second).frames[10][1].x, 12345);
  assert.equal(second, plain(state));
});

test('a reopened project, with its artwork shared from the table, saves the same way through both paths', async () => {
  const edited = await editSequence(31337, 200);
  const d = normaliseProject(JSON.parse(serializeProjectJson(edited)));
  const state = { ...edited, frames: d.frames, frameDelays: d.delays, currentFrameIndex: d.index, groups: d.groups, backgroundData: d.backgroundData };
  assertSame(state, 'reopened');
  replaceFigure(state, 0, 0, f => { f.x += 1; });
  assertSame(state, 'reopened, then edited');
});
