import { Figure, FigureGroup, Joint, SEGMENT_CIRCLE, SEGMENT_LINE } from './models.js';

export const MAX_PROJECT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PROJECT_FRAMES = 500;
export const MAX_FIGURES_PER_FRAME = 250;
export const MAX_JOINTS_PER_FIGURE = 100;
export const MAX_PROJECT_GROUPS = 250;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_BACKGROUND_DATA_LENGTH = 8 * 1024 * 1024;

export function cloneFigures(figures) {
  return figures.map(figure => figure.clone());
}

export function clampDimension(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(64, Math.min(4096, number)) : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeNumber(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`Invalid ${label}.`);
  return number;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error(`Invalid ${label} id.`);
  return value;
}

function safeText(value, fallback, max, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function safeColor(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function validateJointTree(joints) {
  const jointsById = new Map(joints.map(joint => [joint.id, joint]));
  if (jointsById.size !== joints.length) throw new Error('Joint ids must be unique.');
  joints.forEach(joint => {
    if (joint.parentId !== null && !jointsById.has(joint.parentId)) throw new Error('A joint has an unknown parent.');
  });
  joints.forEach(joint => {
    const visited = new Set();
    let current = joint;
    while (current.parentId !== null) {
      if (visited.has(current.id)) throw new Error('Joint hierarchy contains a cycle.');
      visited.add(current.id);
      current = jointsById.get(current.parentId);
    }
  });
}

export function rehydrateFigures(data) {
  if (!Array.isArray(data)) throw new Error('A frame is not a figure list.');
  if (data.length > MAX_FIGURES_PER_FRAME) throw new Error(`A frame can contain at most ${MAX_FIGURES_PER_FRAME} figures.`);
  const figures = data.map((figureData, index) => {
    if (!isPlainObject(figureData)) throw new Error('A figure is malformed.');
    const figure = new Figure();
    figure.id = safeId(figureData.id, `figure ${index + 1}`);
    figure.x = safeNumber(figureData.x, 400, -100000, 100000, 'figure position');
    figure.y = safeNumber(figureData.y, 300, -100000, 100000, 'figure position');
    figure.scale = safeNumber(figureData.scale, 1, 0.05, 100, 'figure scale');
    figure.color = safeColor(figureData.color, '#000000', 'figure color');
    figure.selected = figureData.selected === true;
    figure.type = safeText(figureData.type, 'figure', 32, 'figure type');
    figure.text = safeText(figureData.text, '', MAX_TEXT_LENGTH, 'figure text');
    figure.groupId = figureData.groupId === null || figureData.groupId === undefined ? null : safeId(figureData.groupId, 'group');
    if (!Array.isArray(figureData.joints) || figureData.joints.length === 0 || figureData.joints.length > MAX_JOINTS_PER_FIGURE) throw new Error(`Figure ${index + 1} has an invalid number of joints.`);
    figure.joints = figureData.joints.map((jointData, jointIndex) => {
      if (!isPlainObject(jointData)) throw new Error('A joint is malformed.');
      const id = safeId(jointData.id, `joint ${jointIndex + 1}`);
      const parentId = jointData.parentId === null || jointData.parentId === undefined ? null : safeId(jointData.parentId, 'parent');
      const type = jointData.type === undefined ? SEGMENT_LINE : jointData.type;
      if (type !== SEGMENT_LINE && type !== SEGMENT_CIRCLE) throw new Error('Invalid joint type.');
      return new Joint(id, parentId, safeNumber(jointData.length, 0, 0, 10000, 'joint length'), safeNumber(jointData.angle, 0, -Math.PI * 2, Math.PI * 2, 'joint angle'), type, safeNumber(jointData.radius, 20, 0, 5000, 'joint radius'), safeNumber(jointData.thickness, 14, 1, 500, 'joint thickness'), jointData.filled !== false, safeColor(jointData.color, null, 'joint color'));
    });
    validateJointTree(figure.joints);
    return figure;
  });
  if (new Set(figures.map(figure => figure.id)).size !== figures.length) throw new Error('Figure ids must be unique within a frame.');
  return figures;
}

export function normaliseProject(data) {
  if (!isPlainObject(data)) throw new Error('Project data is missing.');
  const width = clampDimension(data.width, 800);
  const height = clampDimension(data.height, 500);
  if (Array.isArray(data.frames) && data.frames.length > MAX_PROJECT_FRAMES) throw new Error(`Projects can contain at most ${MAX_PROJECT_FRAMES} frames.`);
  let frames = Array.isArray(data.frames) ? data.frames.map(rehydrateFigures) : [];
  if (frames.length === 0 && Array.isArray(data.figures)) frames = [rehydrateFigures(data.figures)];
  if (frames.length === 0) frames = [[]];
  const delays = frames.map((_, index) => {
    const value = Array.isArray(data.delays) ? Number(data.delays[index]) : 1;
    return Number.isFinite(value) ? Math.max(0.1, Math.min(10, value)) : 1;
  });
  const index = Math.max(0, Math.min(Number.isInteger(data.currentFrameIndex) ? data.currentFrameIndex : 0, frames.length - 1));
  if (Array.isArray(data.groups) && data.groups.length > MAX_PROJECT_GROUPS) throw new Error(`Projects can contain at most ${MAX_PROJECT_GROUPS} groups.`);
  const groups = Array.isArray(data.groups) ? data.groups.map((group, groupIndex) => {
    if (!isPlainObject(group) || !Array.isArray(group.figureIds) || group.figureIds.length > MAX_FIGURES_PER_FRAME) throw new Error('A group is malformed.');
    const ids = group.figureIds.map(id => safeId(id, 'group member'));
    if (new Set(ids).size !== ids.length) throw new Error('Group member ids must be unique.');
    return new FigureGroup(safeId(group.id, `group ${groupIndex + 1}`), ids, safeText(group.label, undefined, 80, 'group label'));
  }) : [];
  if (new Set(groups.map(group => group.id)).size !== groups.length) throw new Error('Group ids must be unique.');
  const settings = isPlainObject(data.settings) ? data.settings : {};
  const name = safeText(data.name, 'Untitled animation', 80, 'project name').trim() || 'Untitled animation';
  const backgroundData = typeof data.backgroundData === 'string' && data.backgroundData.length <= MAX_BACKGROUND_DATA_LENGTH && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(data.backgroundData) ? data.backgroundData : null;
  return { name, width, height, fps: Math.max(1, Math.min(30, parseInt(data.fps, 10) || 12)), frames, delays, index, groups, backgroundData, settings };
}

export function serializeProject(state) {
  return {
    version: 5,
    name: state.projectName || state.name || 'Untitled animation',
    width: state.docWidth,
    height: state.docHeight,
    fps: state.fps,
    frames: state.frames,
    delays: state.frameDelays,
    currentFrameIndex: state.currentFrameIndex,
    groups: state.groups,
    backgroundData: state.backgroundData,
    settings: {
      isLooping: state.isLooping,
      isSmooth: state.isSmooth,
      showOnion: state.showOnion,
      showPivots: state.showPivots
    }
  };
}
