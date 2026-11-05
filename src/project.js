import { Figure, FigureGroup, Joint, SEGMENT_CIRCLE, SEGMENT_LINE } from './models.js';
import { MAX_IMPORTED_JOINT_LENGTH, MAX_IMPORTED_JOINTS_PER_FIGURE, settleStkArtwork, stkJoint, stkJointTemplate } from './stk-import.js';

export const MAX_PROJECT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PROJECT_FRAMES = 2000;
export const GIF_WARNING_FRAME_COUNT = 150;
export const SMOOTH_EXPORT_FPS = 60;
export const MAX_FIGURES_PER_FRAME = 250;
export const MAX_JOINTS_PER_FIGURE = 100;
export { MAX_IMPORTED_JOINTS_PER_FIGURE };
export const MAX_PROJECT_GROUPS = 250;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_JOINT_LENGTH = 10000;
export const MAX_BACKGROUND_DATA_LENGTH = 8 * 1024 * 1024;
export const MAX_PROJECT_STK_ARTWORKS = 1000;

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

export function normaliseAngle(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const angle = Number(value);
  if (!Number.isFinite(angle)) throw new Error('Invalid joint angle.');
  return Math.atan2(Math.sin(angle), Math.cos(angle));
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

export function rehydrateFigures(data, artworks = { byRef: new Map(), inline: new Map() }) {
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
    const artwork = resolveFigureArtwork(figureData, artworks, index);
    figure.stkArtwork = artwork;
    if (artwork && figureData.stkPose !== undefined) {
      figure.joints = poseJoints(artwork, figureData.stkPose, index);
      return figure;
    }
    if (figureData.stkPose !== undefined) throw new Error(`Figure ${index + 1} has a pose but no STK artwork.`);
    const hasStkArtwork = Boolean(artwork);
    const jointLimit = hasStkArtwork ? MAX_IMPORTED_JOINTS_PER_FIGURE : MAX_JOINTS_PER_FIGURE;
    const lengthLimit = hasStkArtwork ? MAX_IMPORTED_JOINT_LENGTH : MAX_JOINT_LENGTH;
    if (!Array.isArray(figureData.joints) || figureData.joints.length === 0 || figureData.joints.length > jointLimit) throw new Error(`Figure ${index + 1} has an invalid number of joints.`);
    if (hasStkArtwork) {
      const sourceSegments = artwork.segments;
      if (figureData.joints.length !== sourceSegments.length + 1) throw new Error(`Figure ${index + 1} has an invalid STK joint count.`);
      const root = figureData.joints[0];
      if (!isPlainObject(root) || root.id !== 'stk-root' || root.parentId !== null) throw new Error(`Figure ${index + 1} has an invalid STK root joint.`);
      sourceSegments.forEach((segment, segmentIndex) => {
        const jointData = figureData.joints[segmentIndex + 1];
        const expectedParent = segment.parent === 0 ? 'stk-root' : `stk-${segment.parent}`;
        if (!isPlainObject(jointData) || jointData.id !== `stk-${segment.id}` || jointData.parentId !== expectedParent) throw new Error(`Figure ${index + 1} has an invalid STK joint binding.`);
      });
    }
    figure.joints = figureData.joints.map((jointData, jointIndex) => {
      if (!isPlainObject(jointData)) throw new Error('A joint is malformed.');
      const id = safeId(jointData.id, `joint ${jointIndex + 1}`);
      const parentId = jointData.parentId === null || jointData.parentId === undefined ? null : safeId(jointData.parentId, 'parent');
      const type = jointData.type === undefined ? SEGMENT_LINE : jointData.type;
      if (type !== SEGMENT_LINE && type !== SEGMENT_CIRCLE) throw new Error('Invalid joint type.');
      return new Joint(id, parentId, safeNumber(jointData.length, 0, 0, lengthLimit, 'joint length'), normaliseAngle(jointData.angle), type, safeNumber(jointData.radius, 20, 0, 5000, 'joint radius'), safeNumber(jointData.thickness, 14, 1, 500, 'joint thickness'), jointData.filled !== false, safeColor(jointData.color, null, 'joint color'), jointData.handleVisible !== false);
    });
    validateJointTree(figure.joints);
    return figure;
  });
  if (new Set(figures.map(figure => figure.id)).size !== figures.length) throw new Error('Figure ids must be unique within a frame.');
  return figures;
}

// Version 6 projects store each imported artwork once, in `stkArtworks`; figures refer to it by key and keep
// only an `stkPose` of [length, angle] per joint.  Version 5 and earlier embedded the artwork in every frame;
// identical copies are shared once loaded.
function readArtworkTable(table) {
  const byRef = new Map();
  if (table === undefined || table === null) return byRef;
  if (!isPlainObject(table)) throw new Error('The STK artwork table is malformed.');
  const entries = Object.entries(table);
  if (entries.length > MAX_PROJECT_STK_ARTWORKS) throw new Error(`Projects can contain at most ${MAX_PROJECT_STK_ARTWORKS} imported STK artworks.`);
  for (const [ref, artwork] of entries) byRef.set(safeId(ref, 'artwork reference'), settleStkArtwork(artwork));
  return byRef;
}

function resolveFigureArtwork(figureData, artworks, index) {
  if (figureData.stkArtworkRef !== undefined && figureData.stkArtworkRef !== null) {
    const artwork = artworks.byRef.get(safeId(figureData.stkArtworkRef, 'artwork reference'));
    if (!artwork) throw new Error(`Figure ${index + 1} refers to missing STK artwork.`);
    return artwork;
  }
  if (figureData.stkArtwork === undefined || figureData.stkArtwork === null) return null;
  const key = JSON.stringify(figureData.stkArtwork);
  if (!artworks.inline.has(key)) artworks.inline.set(key, settleStkArtwork(figureData.stkArtwork));
  return artworks.inline.get(key);
}

function poseJoints(artwork, pose, index) {
  const template = stkJointTemplate(artwork);
  if (!Array.isArray(pose) || pose.length !== template.length) throw new Error(`Figure ${index + 1} has an invalid STK pose.`);
  return template.map((joint, jointIndex) => {
    const entry = pose[jointIndex];
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'number')) throw new Error(`Figure ${index + 1} has an invalid STK pose.`);
    return stkJoint(joint, safeNumber(entry[0], 0, 0, MAX_IMPORTED_JOINT_LENGTH, 'joint length'), normaliseAngle(entry[1]));
  });
}

export function normaliseProject(data) {
  if (!isPlainObject(data)) throw new Error('Project data is missing.');
  const width = clampDimension(data.width, 800);
  const height = clampDimension(data.height, 500);
  if (Array.isArray(data.frames) && data.frames.length > MAX_PROJECT_FRAMES) throw new Error(`Projects can contain at most ${MAX_PROJECT_FRAMES} frames.`);
  const artworks = { byRef: readArtworkTable(data.stkArtworks), inline: new Map() };
  let frames = Array.isArray(data.frames) ? data.frames.map(frame => rehydrateFigures(frame, artworks)) : [];
  if (frames.length === 0 && Array.isArray(data.figures)) frames = [rehydrateFigures(data.figures, artworks)];
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

// An imported figure is saved as a pose only when its joints are exactly the ones its artwork implies, so
// nothing is lost; any other figure keeps its full joint list (without the derived x/y positions).
function jointsMatchTemplate(joints, template) {
  return joints.length === template.length && joints.every((joint, index) => {
    const expected = template[index];
    return joint.id === expected.id && joint.parentId === expected.parentId && joint.type === SEGMENT_LINE && joint.radius === 20 &&
      joint.thickness === expected.thickness && joint.filled === true && joint.color === expected.color && joint.handleVisible === expected.handleVisible;
  });
}

function serializeFigure(figure, artworkRefs, stkArtworks) {
  const { joints, stkArtwork, ...fields } = figure;
  const data = { ...fields };
  if (stkArtwork) {
    if (!artworkRefs.has(stkArtwork)) {
      const ref = `stk${artworkRefs.size + 1}`;
      artworkRefs.set(stkArtwork, ref);
      stkArtworks[ref] = stkArtwork;
    }
    data.stkArtworkRef = artworkRefs.get(stkArtwork);
    if (jointsMatchTemplate(joints, stkJointTemplate(stkArtwork))) {
      data.stkPose = joints.map(joint => [joint.length, joint.angle]);
      return data;
    }
  }
  data.joints = joints.map(({ id, parentId, length, angle, type, radius, thickness, filled, color, handleVisible }) =>
    ({ id, parentId, length, angle, type, radius, thickness, filled, color, handleVisible }));
  return data;
}

export function serializeProject(state) {
  const artworkRefs = new Map();
  const stkArtworks = {};
  const frames = state.frames.map(frame => frame.map(figure => serializeFigure(figure, artworkRefs, stkArtworks)));
  return projectData(state, frames, artworkRefs.size ? stkArtworks : null);
}

// The saved project around its frames and artwork table, in the saved key order.
function projectData(state, frames, stkArtworks) {
  return {
    version: 6,
    name: state.projectName || state.name || 'Untitled animation',
    width: state.docWidth,
    height: state.docHeight,
    fps: state.fps,
    frames,
    ...(stkArtworks ? { stkArtworks } : {}),
    delays: state.frameDelays,
    currentFrameIndex: state.currentFrameIndex,
    groups: state.groups,
    backgroundData: state.backgroundData,
    settings: {
      isLooping: state.isLooping,
      isSmooth: state.isSmooth,
      showOnion: state.showOnion,
      showPivots: state.showPivots,
      showPath: state.showPath,
      onionBefore: state.onionBefore,
      onionAfter: state.onionAfter,
      fileSaved: state.fileSaved === true
    }
  };
}

// ── Fast saving ──────────────────────────────────────────────────────────────────────────────────────────
// Autosave runs after nearly every edit, and stringifying a large project whole stalls the editor (about
// 100 ms for 300 frames of 15 stickmen at a 4x CPU slowdown).  serializeProjectJson(state) returns exactly
// JSON.stringify(serializeProject(state)), byte for byte, but reuses each frame's JSON from earlier saves,
// so a save costs time in proportion to what changed.
//
// This is safe because a stored frame is never edited in place: an edit puts a new frame array in its place
// (commitActiveFrame, setStoredGroupIds, dragging a motion-path dot, pasting frames), and Undo snapshots
// already share frame arrays on the same promise.  Drawing a stored frame recomputes its joints' x/y, but
// those are not saved.  Imported artwork is frozen, so its JSON is cached too.
//
// A frame's JSON depends on the rest of the project only through its artwork references ("stk1", "stk2", ...),
// numbered in first-use order across all frames.  So each frame is cached as the text around its references
// plus the artwork each one names, and the numbers are filled in as the project is put together.
const frameJsonCache = new WeakMap(); // frame array -> { parts, artworks }: its JSON is parts[0], ref 1, parts[1], ...
const artworkJsonCache = new WeakMap(); // frozen artwork -> its JSON
let backgroundJsonCache = { data: null, json: 'null' }; // the background image (a data URI of up to 8 MB) and its JSON

// The listed members of an object as JSON, in order and without the braces: '"a":1,"b":2'.  Members that
// JSON leaves out (undefined values) are left out here too.
function membersJson(object, keys) {
  return JSON.stringify(Object.fromEntries(keys.map(key => [key, object[key]]))).slice(1, -1);
}

function frameJson(frame) {
  const cached = frameJsonCache.get(frame);
  if (cached) return cached;
  const parts = [], artworks = [], refs = new Map(), table = {};
  let text = ['[']; // the part being gathered, joined into one flat string when it is complete
  frame.forEach((figure, index) => {
    if (index) text.push(',');
    const data = serializeFigure(figure, refs, table);
    if (!figure.stkArtwork) { text.push(JSON.stringify(data)); return; }
    // Split the figure at its artwork reference, whose number is only known when the project is put together.
    const keys = Object.keys(data), at = keys.indexOf('stkArtworkRef');
    const before = membersJson(data, keys.slice(0, at)), after = membersJson(data, keys.slice(at + 1));
    text.push('{', before, before ? ',' : '', '"stkArtworkRef":');
    parts.push(text.join(''));
    artworks.push(figure.stkArtwork);
    text = [after ? ',' : '', after, '}'];
  });
  text.push(']');
  parts.push(text.join(''));
  const entry = { parts, artworks };
  frameJsonCache.set(frame, entry);
  return entry;
}

function artworkJson(artwork) {
  if (artworkJsonCache.has(artwork)) return artworkJsonCache.get(artwork);
  const json = JSON.stringify(artwork);
  // Settled artwork is deep-frozen, so it can never differ from this JSON.  Anything else is not kept.
  if (artwork && typeof artwork === 'object' && Object.isFrozen(artwork)) artworkJsonCache.set(artwork, json);
  return json;
}

function backgroundJson(data) {
  if (backgroundJsonCache.data !== data) backgroundJsonCache = { data, json: JSON.stringify(data) };
  return backgroundJsonCache.json;
}

export function serializeProjectJson(state) {
  const refs = new Map(); // artwork -> its number, given in first-use order just as serializeProject gives them
  const frameTexts = state.frames.map(frame => {
    const { parts, artworks } = frameJson(frame);
    const text = [parts[0]];
    artworks.forEach((artwork, index) => {
      if (!refs.has(artwork)) refs.set(artwork, refs.size + 1);
      text.push(`"stk${refs.get(artwork)}"`, parts[index + 1]);
    });
    return text;
  });
  // The text is gathered as pieces and joined once, so the browser copies the (possibly many-megabyte)
  // result a single time and hands IndexedDB one flat string.
  const pieces = ['{'];
  const data = projectData(state, null, refs.size ? {} : null);
  for (const key of Object.keys(data)) {
    const start = pieces.length;
    if (pieces.length > 1) pieces.push(',');
    if (key === 'frames') {
      pieces.push('"frames":[');
      frameTexts.forEach((text, index) => pieces.push(index ? ',' : '', ...text));
      pieces.push(']');
    } else if (key === 'stkArtworks') {
      pieces.push('"stkArtworks":{');
      [...refs.keys()].forEach((artwork, index) => pieces.push(index ? ',' : '', `"stk${index + 1}":`, artworkJson(artwork)));
      pieces.push('}');
    } else if (key === 'backgroundData' && typeof data.backgroundData === 'string') {
      pieces.push('"backgroundData":', backgroundJson(data.backgroundData));
    } else {
      const member = membersJson(data, [key]);
      if (member) pieces.push(member); else pieces.length = start; // a member JSON leaves out, like an undefined value
    }
  }
  pieces.push('}');
  return pieces.join('');
}
