import assert from 'node:assert/strict';
import test from 'node:test';
import { Figure, Joint } from '../src/models.js';

test('joint positions follow the hierarchy whatever order joints are listed in', () => {
  const figure = new Figure();
  figure.x = 10; figure.y = 20; figure.scale = 2;
  figure.joints = [new Joint('root', null, 0, 0), new Joint('late-child', 'middle', 5, Math.PI / 2), new Joint('middle', 'root', 10, 0)];
  figure.updatePositions();
  assert.deepEqual(figure.joints.map(joint => [joint.id, Math.round(joint.x), Math.round(joint.y)]), [['root', 10, 20], ['late-child', 30, 30], ['middle', 30, 20]]);
});

test('large figures compute their joint positions in linear time', () => {
  const figure = new Figure();
  figure.joints = [new Joint('root', null, 0, 0), ...Array.from({ length: 20000 }, (_, index) => new Joint(`joint-${index}`, 'root', 1, index))];
  const started = performance.now();
  figure.updatePositions();
  assert.ok(performance.now() - started < 500, 'a 20,000-joint figure must not take quadratic time');
  assert.ok(Math.abs(figure.joints[1].x - (figure.x + 1)) < 1e-9);
});
