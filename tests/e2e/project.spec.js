import { expect, test } from '@playwright/test';
import { Figure } from '../../src/models.js';
import { GIF_WARNING_FRAME_COUNT, MAX_PROJECT_FILE_BYTES, SMOOTH_EXPORT_FPS, normaliseProject, serializeProject } from '../../src/project.js';
import { History } from '../../src/history.js';
import { renderDocument } from '../../src/renderer.js';
import { createFrameSchedule, createStoredZip, pickWebmMimeType } from '../../src/export-utils.js';
import { beginMarquee, findDragTarget, marqueeCanvasBounds, moveJointDrag, moveRootDrag, updateMarqueeElement } from '../../src/drag-controller.js';

function validProject() {
  return {
    version: 4,
    width: 800,
    height: 500,
    fps: 12,
    frames: [[{
      id: 'figure1', x: 400, y: 300, scale: 1, color: '#000000', selected: false, type: 'figure', text: '', groupId: null,
      joints: [
        { id: 'root', parentId: null, length: 0, angle: 0, type: 'line', radius: 20, thickness: 14, filled: true, color: null },
        { id: 'arm', parentId: 'root', length: 30, angle: 1, type: 'line', radius: 20, thickness: 14, filled: true, color: null }
      ]
    }]],
    delays: [1], currentFrameIndex: 0, groups: [], settings: {}
  };
}

test('project module rebuilds validated model instances', () => {
  const project = normaliseProject(validProject());
  expect(project.frames).toHaveLength(1);
  expect(project.frames[0][0]).toBeInstanceOf(Figure);
  expect(project.frames[0][0].joints[1].parentId).toBe('root');
});

test('project module accepts and normalises accumulated multi-turn joint angles', () => {
  const projectData = validProject();
  projectData.frames[0][0].joints[1].angle = -8.566402320633376;

  const project = normaliseProject(projectData);

  expect(project.frames[0][0].joints[1].angle).toBeCloseTo(-2.2832170134537895);
});

test('project module accepts large classroom animations and keeps a consistent safety limit', () => {
  const largeProject = validProject();
  largeProject.frames = Array.from({ length: 802 }, () => validProject().frames[0]);
  largeProject.delays = Array(802).fill(1);
  expect(normaliseProject(largeProject).frames).toHaveLength(802);

  largeProject.frames = Array.from({ length: 2001 }, () => []);
  expect(() => normaliseProject(largeProject)).toThrow('Projects can contain at most 2000 frames.');
});

test('project file limit accommodates larger classroom projects', () => {
  expect(MAX_PROJECT_FILE_BYTES).toBe(25 * 1024 * 1024);
});

test('project module rejects cyclic joint imports and serializes app state', () => {
  const invalid = validProject();
  invalid.frames[0][0].joints[0].parentId = 'arm';
  expect(() => normaliseProject(invalid)).toThrow('Joint hierarchy contains a cycle.');

  const state = { ...normaliseProject(validProject()), docWidth: 800, docHeight: 500, fps: 12, frameDelays: [1], currentFrameIndex: 0, isLooping: true, isSmooth: true, showOnion: true, showPivots: true, backgroundData: null };
  const serialized = serializeProject(state);
  expect(serialized.version).toBe(5);
  expect(serialized.frames[0][0].id).toBe('figure1');
  expect(serialized.name).toBe('Untitled animation');
});

test('history module restores independent undo and redo snapshots', () => {
  const project = normaliseProject(validProject());
  const state = { ...project, frameDelays: project.delays, figures: project.frames[0].map(figure => figure.clone()) };
  const history = new History(2);
  history.capture(state);
  state.figures[0].x = 99;
  const undo = history.undo(state);
  expect(undo.figures[0].x).toBe(400);
  undo.figures[0].x = 7;
  const redo = history.redo(state);
  expect(redo.figures[0].x).toBe(99);
  expect(state.figures[0].x).toBe(99);
});

test('renderer module paints the document and delegates each figure', () => {
  const calls = [];
  const context = { fillStyle: '', fillRect: (...args) => calls.push(['fill', ...args]), drawImage: (...args) => calls.push(['background', ...args]) };
  const figure = { updatePositions: () => calls.push(['position']) };
  renderDocument({ context, width: 800, height: 500, backgroundImage: { id: 'background' }, figures: [figure], showHandles: true, drawFigure: (item, handles) => calls.push(['figure', item, handles]) });
  expect(context.fillStyle).toBe('#ffffff');
  expect(calls.map(call => call[0])).toEqual(['fill', 'background', 'position', 'figure']);
  expect(calls[3][2]).toBe(true);
});

test('renderer can omit the stage and background for transparent artwork', () => {
  const calls = [];
  const context = { clearRect: (...args) => calls.push(['clear', ...args]), drawImage: (...args) => calls.push(['background', ...args]) };
  renderDocument({ context, width: 800, height: 500, backgroundImage: { id: 'background' }, figures: [{ updatePositions: () => calls.push(['position']) }], transparent: true, drawFigure: () => calls.push(['figure']) });
  expect(calls.map(call => call[0])).toEqual(['clear', 'position', 'figure']);
});

test('export utilities create a standards-shaped ZIP archive', async () => {
  const zip = await createStoredZip([{ name: 'frame-001.png', data: new Uint8Array([137, 80, 78, 71]) }], new Date(2026, 0, 1));
  const bytes = new Uint8Array(await zip.arrayBuffer());
  expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
  expect(new DataView(bytes.buffer).getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  expect(zip.type).toBe('application/zip');
});

test('export frame schedules preserve FPS and per-frame duration', () => {
  const normal = createFrameSchedule({ fps: 10, multiplier: 2 });
  const faster = createFrameSchedule({ fps: 20, multiplier: 2 });
  const smoothGif = createFrameSchedule({ fps: 10, multiplier: 2, smooth: true, quantumMs: 10 });

  expect(normal.reduce((total, delay) => total + delay, 0)).toBe(200);
  expect(faster.reduce((total, delay) => total + delay, 0)).toBe(100);
  expect(smoothGif.reduce((total, delay) => total + delay, 0)).toBe(200);
  expect(smoothGif.every(delay => delay >= 10)).toBe(true);
});

test('WebM export prefers VP8 and falls back to VP9 or generic WebM', () => {
  const both = { isTypeSupported: type => type === 'video/webm;codecs=vp8' || type === 'video/webm;codecs=vp9' };
  const vp9Only = { isTypeSupported: type => type === 'video/webm;codecs=vp9' };
  const generic = { isTypeSupported: type => type === 'video/webm' };
  expect(pickWebmMimeType(both)).toBe('video/webm;codecs=vp8');
  expect(pickWebmMimeType(vp9Only)).toBe('video/webm;codecs=vp9');
  expect(pickWebmMimeType(generic)).toBe('video/webm');
  expect(pickWebmMimeType(null)).toBe('');
});

test('long GIF warning threshold is above 150 frames', () => {
  expect(GIF_WARNING_FRAME_COUNT).toBe(150);
  expect(SMOOTH_EXPORT_FPS).toBe(60);
});

test('drag controller moves selected groups, joints, and marquee bounds', () => {
  const project = normaliseProject(validProject());
  const figure = project.frames[0][0];
  const companion = figure.clone();
  companion.id = 'figure2'; companion.x = 500; companion.y = 300;
  figure.groupId = 'group1'; companion.groupId = 'group1';
  moveRootDrag({ target: { figure, offsetX: 10, offsetY: 20 }, position: { x: 450, y: 360 }, figures: [figure, companion], groups: [{ id: 'group1', figureIds: [figure.id, companion.id] }], selectedIds: new Set([figure.id, companion.id]) });
  expect([figure.x, figure.y, companion.x, companion.y]).toEqual([440, 340, 540, 340]);

  figure.updatePositions();
  const arm = figure.joints.find(joint => joint.id === 'arm');
  const rotated = [];
  moveJointDrag({ target: { figure, joint: arm }, position: { x: figure.x, y: figure.y + 30 }, updateFreeJoint: () => { throw new Error('unexpected free-joint movement'); }, rotateHierarchy: (_figure, id, delta) => rotated.push([id, delta]) });
  expect(arm.angle).toBeCloseTo(Math.PI / 2);
  expect(rotated[0][0]).toBe('arm');

  const marquee = beginMarquee({ x: 90, y: 50 });
  const element = { style: {} };
  updateMarqueeElement(element, marquee, { x: 30, y: 110 });
  expect(element.style).toMatchObject({ left: '30px', top: '50px', width: '60px', height: '60px' });
  expect(marqueeCanvasBounds({ marquee, canvasRect: { left: 20, top: 40, width: 400, height: 200 }, wrapperRect: { left: 0, top: 0 }, scrollLeft: 10, scrollTop: 5, canvasWidth: 800, canvasHeight: 400, stagePadding: 20 })).toEqual({ left: -20, top: -10, right: 100, bottom: 110 });
});

test('drag controller preserves handle, bubble, and segment hit priority', () => {
  const figure = normaliseProject(validProject()).frames[0][0];
  const arm = figure.joints.find(joint => joint.id === 'arm');
  arm.length = 100;
  figure.updatePositions();
  const options = { figures: [figure], handleRadius: 4, distanceToSegment: (point, start, end) => {
    const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared));
    return Math.hypot(point.x - (start.x + t * (end.x - start.x)), point.y - (start.y + t * (end.y - start.y)));
  }, isPointInSpeechBubble: () => false };
  expect(findDragTarget({ ...options, position: { x: figure.x, y: figure.y } }).type).toBe('root');
  expect(findDragTarget({ ...options, position: { x: arm.x, y: arm.y } })).toMatchObject({ type: 'joint', joint: arm });
  expect(findDragTarget({ ...options, position: { x: (figure.x + arm.x) / 2, y: (figure.y + arm.y) / 2 } }).type).toBe('root');
  expect(findDragTarget({ ...options, position: { x: 0, y: 0 } })).toBeNull();
});
