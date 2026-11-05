import assert from 'node:assert/strict';
import test from 'node:test';
import { curvePoint } from '../src/motion-curve.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('the curve passes through both frames at its ends', () => {
  const p0 = { x: 0, y: 300 }, p1 = { x: 100, y: 200 }, p2 = { x: 200, y: 150 }, p3 = { x: 300, y: 200 };
  assert.deepEqual(curvePoint(p0, p1, p2, p3, 0), p1);
  const end = curvePoint(p0, p1, p2, p3, 1);
  assert.ok(close(end.x, p2.x) && close(end.y, p2.y));
});

test('an arc of poses bows outward between them instead of cutting the corner', () => {
  // A jump: rising, peak, falling. Between the rising pose and the peak, the straight midpoint is y = 175.
  const middle = curvePoint({ x: 0, y: 300 }, { x: 100, y: 200 }, { x: 200, y: 150 }, { x: 300, y: 200 }, 0.5);
  assert.ok(close(middle.x, 150));
  assert.ok(middle.y < 170, `the curve rises above the straight line (${middle.y})`);
});

test('evenly spaced poses on a straight line stay on it, at an even pace', () => {
  const points = [0, 1, 2, 3].map(i => ({ x: i * 50, y: 100 }));
  for (const t of [0.25, 0.5, 0.75]) {
    const p = curvePoint(...points, t);
    assert.ok(close(p.x, 50 + 50 * t) && close(p.y, 100));
  }
});

test('at an end of the animation the missing neighbour is the end point itself', () => {
  const p = curvePoint({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, 0.5);
  assert.ok(close(p.x, 50) && close(p.y, 0));
});
