import assert from 'node:assert/strict';
import test from 'node:test';
import { EASES, easeProgress } from '../src/motion-curve.js';
import { normaliseProject, serializeProject, serializeProjectJson } from '../src/project.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('every easing starts at the first frame, ends at the next, and never runs backwards', () => {
  for (const ease of EASES) {
    assert.equal(easeProgress(ease, 0), 0, ease);
    assert.ok(close(easeProgress(ease, 1), 1), ease);
    let last = 0;
    for (let step = 1; step <= 100; step += 1) {
      const value = easeProgress(ease, step / 100);
      assert.ok(value >= last, `${ease} at ${step}%`);
      last = value;
    }
  }
});

test('Speed up starts slowly, Slow down ends slowly, Both does each, and Steady keeps one speed', () => {
  assert.equal(easeProgress('even', 0.5), 0.5);
  assert.equal(easeProgress('in', 0.5), 0.25);
  assert.equal(easeProgress('out', 0.5), 0.75);
  assert.equal(easeProgress('inout', 0.5), 0.5);
  assert.equal(easeProgress('inout', 0.25), 0.125);
  assert.equal(easeProgress('inout', 0.75), 0.875);
  assert.equal(easeProgress(undefined, 0.3), 0.3); // a frame without easing is steady
});

const state = eases => ({
  projectName: 'Eased', docWidth: 800, docHeight: 500, fps: 12,
  frames: [[], [], []], frameDelays: [1, 1, 1], ...(eases ? { frameEases: eases } : {}), currentFrameIndex: 0, groups: [], backgroundData: null,
  isLooping: true, isSmooth: true, showOnion: true, showPivots: true, showPath: false, motionCurve: 'straight', onionBefore: 1, onionAfter: 0, fileSaved: false
});

test('a project saves its easing only when a move eases, and reopens it', () => {
  assert.equal('eases' in serializeProject(state(['even', 'even', 'even'])), false); // files without easing are as before
  assert.equal('eases' in serializeProject(state()), false);
  const saved = serializeProject(state(['out', 'even', 'inout']));
  assert.deepEqual(saved.eases, ['out', 'even', 'inout']);
  assert.equal(serializeProjectJson(state(['out', 'even', 'inout'])), JSON.stringify(saved));
  assert.deepEqual(normaliseProject(JSON.parse(JSON.stringify(saved))).eases, ['out', 'even', 'inout']);
});

test('opening a project tolerates missing, short, or unknown easing', () => {
  const base = JSON.parse(JSON.stringify(serializeProject(state())));
  assert.deepEqual(normaliseProject(base).eases, ['even', 'even', 'even']);
  assert.deepEqual(normaliseProject({ ...base, eases: ['in'] }).eases, ['in', 'even', 'even']);
  assert.deepEqual(normaliseProject({ ...base, eases: ['bounce', 7, 'out'] }).eases, ['even', 'even', 'out']);
  assert.deepEqual(normaliseProject({ ...base, eases: 'in' }).eases, ['even', 'even', 'even']);
});
