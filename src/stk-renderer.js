import { getStkNodes, isStkCircleSegment, isStkFilledCircleSegment, isStkPictureSegment, orderedStkDrawItems, pointOnStkSegment, stkImageBytes, validateStkArtwork } from './stk-import.js';

const EPSILON = 1e-8;

// ── Pictures ─────────────────────────────────────────────────────
// Drawing is synchronous but decoding a PNG is not, so each picture table is decoded in the background the
// first time its figure is drawn (or when loadStkPictures asks).  Until then its pictures are left out;
// once every decode in progress has finished, the listeners are told so they can draw again.
const decodedImages = new WeakMap(); // image entry -> { bitmap } or { failed: true }
const imageLoads = new WeakMap(); // picture table -> Promise
const readyListeners = new Set();
let loadsInProgress = 0;

export function onStkPicturesReady(listener) {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

async function decodeImage(image) {
  try {
    if (typeof globalThis.createImageBitmap !== 'function' || typeof Blob !== 'function') throw new Error('Image decoding is unavailable.');
    const bitmap = await globalThis.createImageBitmap(new Blob([stkImageBytes(image)], { type: 'image/png' }));
    if (bitmap.width !== image.width || bitmap.height !== image.height) throw new Error('The decoded picture does not match its recorded size.');
    decodedImages.set(image, { bitmap });
  } catch {
    // An image the browser cannot decode is left out, like one still decoding.
    decodedImages.set(image, { failed: true });
  }
}

function loadImages(images) {
  if (!imageLoads.has(images)) {
    loadsInProgress += 1;
    imageLoads.set(images, Promise.all(images.map(decodeImage)).then(() => {
      loadsInProgress -= 1;
      if (loadsInProgress === 0) for (const listener of readyListeners) { try { listener(); } catch (error) { console.error(error); } }
    }));
  }
  return imageLoads.get(images);
}

// Resolves once every picture of the given artworks has been decoded (or found undecodable); exports wait
// on this so no frame is drawn without its pictures.
export function loadStkPictures(artworks) {
  const list = Array.isArray(artworks) ? artworks : [artworks];
  return Promise.all(list.map(artwork => Array.isArray(artwork?.images) && artwork.images.length ? loadImages(artwork.images) : null)).then(() => undefined);
}

// The canvas transform that draws a picture on its segment: a similarity that puts image pixel (x1, y1)
// on the segment's start and (x2, y2) on its end, reflected across the segment when mirrored.  Returns
// null when the segment has no length, as nothing then shows.
export function stkPictureTransform(start, end, image, mirrored) {
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  const span = Math.hypot(image.x2 - image.x1, image.y2 - image.y1);
  if (!(chord > EPSILON) || !(span > 0)) return null;
  const scale = chord / span;
  const theta = Math.atan2(end.y - start.y, end.x - start.x), alpha = Math.atan2(image.y2 - image.y1, image.x2 - image.x1);
  const flip = mirrored ? -1 : 1;
  const [ct, st, ca, sa] = [Math.cos(theta), Math.sin(theta), Math.cos(alpha), Math.sin(alpha)];
  const a = scale * (ct * ca + flip * st * sa), c = scale * (ct * sa - flip * st * ca);
  const b = scale * (st * ca - flip * ct * sa), d = scale * (st * sa + flip * ct * ca);
  return { a, b, c, d, e: start.x - (a * image.x1 + c * image.y1), f: start.y - (b * image.x1 + d * image.y1), scale };
}

function drawPicture(context, artwork, segment, node) {
  const image = artwork.images?.[segment.image];
  const bitmap = image && decodedImages.get(image)?.bitmap;
  if (!bitmap || typeof context.drawImage !== 'function') return;
  const transform = stkPictureTransform(node.start, node.end, image, segment.imageMirror === 1);
  if (!transform) return;
  context.save();
  context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  // Pivot enlarges pictures with hard pixel edges; the scale on screen includes the view's own zoom.
  const screen = typeof context.getTransform === 'function' ? context.getTransform() : null;
  const screenScale = Number.isFinite(screen?.a) ? Math.sqrt(Math.abs(screen.a * screen.d - screen.b * screen.c)) : transform.scale;
  context.imageSmoothingEnabled = !(screenScale > 1);
  context.drawImage(bitmap, 0, 0);
  context.restore();
}

function rgbColor(color, fallback = '#000000') {
  return Array.isArray(color) ? `rgb(${color[0]},${color[1]},${color[2]})` : fallback;
}

function rgbaColor(color, transparency) {
  const rgb = Array.isArray(color) ? color : [0, 0, 0];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${1 - (Number(transparency) || 0) / 255})`;
}

// Pivot 5 gradients run from the segment colour at its start to the gradient colour at its end, each
// with its own transparency, so the stops carry the alpha instead of globalAlpha.
function segmentGradient(context, segment, node) {
  if (!Array.isArray(segment.gradient) || typeof context.createLinearGradient !== 'function') return null;
  const gradient = context.createLinearGradient(node.start.x, node.start.y, node.end.x, node.end.y);
  if (!gradient || typeof gradient.addColorStop !== 'function') return null;
  gradient.addColorStop(0, rgbaColor(segment.color, segment.transparency));
  gradient.addColorStop(1, rgbaColor(segment.gradient, segment.gradient[3]));
  return gradient;
}

// The Pivot 5 figure outline (header bit 0x40): [thickness, R, G, B, transparency], drawn beneath
// the whole figure by widening every painted item by the thickness on each side.
function figureOutline(artwork) {
  const trailer = artwork.figureTrailer;
  return Array.isArray(trailer) && trailer[0] > 0 ? { thickness: trailer[0], color: trailer.slice(1, 4), transparency: trailer[4] } : null;
}

function drawStkOutline(context, artwork, figure, nodes, outline) {
  const grow = outline.thickness * figure.scale;
  context.save();
  applyStkTransparency(context, outline);
  context.strokeStyle = rgbColor(outline.color); context.fillStyle = context.strokeStyle;
  context.lineJoin = 'round';
  for (const item of orderedStkDrawItems(artwork)) {
    if (item < artwork.segments.length) {
      const segment = artwork.segments[item];
      const node = nodes[segment.id];
      const circle = isStkCircleSegment(artwork, segment);
      // Pivot does not trace the outline around pictures.
      if (isStkPictureSegment(artwork, segment)) continue;
      if (!node || (segment.width <= 0 && !isStkFilledCircleSegment(artwork, segment)) || (Number(segment.transparency) >= 255 && !segment.gradient)) continue;
      const width = (Number(segment.width) || 0) * figure.scale;
      if (circle) {
        const center = { x: (node.start.x + node.end.x) / 2, y: (node.start.y + node.end.y) / 2 };
        const chord = Math.hypot(node.end.x - node.start.x, node.end.y - node.start.y);
        context.beginPath();
        if (segment.type === 4) { context.lineWidth = width + 2 * grow; context.arc(center.x, center.y, chord / 2, 0, Math.PI * 2); context.stroke(); }
        else { context.arc(center.x, center.y, Math.max(0, (chord + width) / 2 + grow), 0, Math.PI * 2); context.fill(); }
      } else {
        context.lineCap = artwork.wrapper === 0x7a && segment.type === 6 ? 'square' : 'round';
        context.lineWidth = width + 2 * grow;
        context.beginPath(); context.moveTo(node.start.x, node.start.y); appendArcPath(context, segment, node, false, figure.scale); context.stroke();
      }
    } else {
      const polygon = artwork.polygons[item - artwork.segments.length];
      if (!polygon || Number(polygon.transparency) >= 255) continue;
      context.beginPath(); appendPolygonPath(context, artwork, nodes, polygon, figure.scale);
      context.lineWidth = 2 * grow; context.fill(); context.stroke();
    }
  }
  context.restore();
}

function applyStkTransparency(context, item) {
  const transparency = Number.isInteger(item?.transparency) ? item.transparency : 0;
  const inheritedAlpha = Number.isFinite(Number(context.globalAlpha)) ? Number(context.globalAlpha) : 1;
  context.globalAlpha = inheritedAlpha * (1 - transparency / 255);
}

function appendArcPath(context, segment, node, reverse = false, scale = 1) {
  const start = node.start;
  const end = node.end;
  const chordX = end.x - start.x;
  const chordY = end.y - start.y;
  const chord = Math.hypot(chordX, chordY);
  const chordAngle = chord > EPSILON ? Math.atan2(chordY, chordX) : segment.angle;
  const bend = Number(segment.bend) || 0;
  if (Math.abs(bend) < EPSILON) {
    context.lineTo(reverse ? start.x : end.x, reverse ? start.y : end.y);
    return;
  }
  // Interpolation can transiently collapse a chord.  Keep the artwork joined
  // at that endpoint rather than drawing a detached fallback source arc.
  if (chord <= EPSILON) {
    context.lineTo(reverse ? start.x : end.x, reverse ? start.y : end.y);
    return;
  }
  const radiusSigned = chord > EPSILON ? chord / (2 * Math.sin(bend / 2)) : (segment.length * scale) / bend;
  const tangent = chordAngle - bend / 2;
  const center = { x: start.x - radiusSigned * Math.sin(tangent), y: start.y + radiusSigned * Math.cos(tangent) };
  const begin = bend > 0 ? tangent - Math.PI / 2 : tangent + Math.PI / 2;
  const finish = begin + bend;
  context.arc(center.x, center.y, Math.abs(radiusSigned), reverse ? finish : begin, reverse ? begin : finish, reverse ? bend > 0 : bend < 0);
}

function drawCircle(context, node, segment, figureScale) {
  const center = { x: (node.start.x + node.end.x) / 2, y: (node.start.y + node.end.y) / 2 };
  const currentChord = Math.hypot(node.end.x - node.start.x, node.end.y - node.start.y);
  const radius = (currentChord + (Number(segment.width) || 0) * figureScale) / 2 || (Number(segment.width) || 1) * figureScale / 2;
  context.beginPath(); context.arc(center.x, center.y, Math.max(0, radius), 0, Math.PI * 2);
  if (segment.filled !== false) context.fill();
  else context.stroke();
}

// Type 4: a ring, i.e. a hollow circle on the chord stroked at the segment width (the context line width),
// e.g. a tyre around its rim.
function drawRing(context, node) {
  const center = { x: (node.start.x + node.end.x) / 2, y: (node.start.y + node.end.y) / 2 };
  context.beginPath(); context.arc(center.x, center.y, Math.hypot(node.end.x - node.start.x, node.end.y - node.start.y) / 2, 0, Math.PI * 2);
  context.stroke();
}

function drawLegacyHollowCircle(context, node, segment, figureScale) {
  const center = { x: (node.start.x + node.end.x) / 2, y: (node.start.y + node.end.y) / 2 };
  const radius = Math.max(0, Math.hypot(node.end.x - node.start.x, node.end.y - node.start.y) / 2);
  context.save();
  context.fillStyle = '#ffffff';
  context.lineWidth = Math.max(0.65, (Number(segment.width) || 0) * figureScale);
  context.beginPath(); context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fill(); context.stroke();
  context.restore();
}

function appendPolygonPath(context, artwork, nodes, polygon, figureScale) {
  const refs = polygon.vertices;
  const first = nodes[refs[0]].end;
  context.moveTo(first.x, first.y);
  for (let index = 0; index < refs.length; index += 1) {
    const current = refs[index];
    const next = refs[(index + 1) % refs.length];
    if (next > 0 && artwork.segments[next - 1]?.parent === current) {
      appendArcPath(context, artwork.segments[next - 1], nodes[next], false, figureScale);
    } else if (current > 0 && artwork.segments[current - 1]?.parent === next) {
      appendArcPath(context, artwork.segments[current - 1], nodes[current], true, figureScale);
    } else {
      context.lineTo(nodes[next].end.x, nodes[next].end.y);
    }
  }
  context.closePath();
}

export function drawStkFigure({ context, figure, showHandles = false, handleRadius = 4, drawSelection = true }) {
  if (!figure?.stkArtwork) return false;
  validateStkArtwork(figure.stkArtwork);
  figure.updatePositions();
  const artwork = figure.stkArtwork;
  const nodes = getStkNodes(figure);
  const joints = new Map(figure.joints.map(joint => [joint.id, joint]));
  context.lineCap = 'round'; context.lineJoin = 'round';
  if (artwork.images) loadStkPictures(artwork);
  const outline = figureOutline(artwork);
  if (outline) drawStkOutline(context, artwork, figure, nodes, outline);
  for (const item of orderedStkDrawItems(artwork)) {
    if (item < artwork.segments.length) {
      const segment = artwork.segments[item];
      const node = nodes[segment.id];
      // Pictures take their place in the draw order like any other part.
      if (node && isStkPictureSegment(artwork, segment)) { drawPicture(context, artwork, segment, node); continue; }
      if (!node || (segment.width <= 0 && !isStkFilledCircleSegment(artwork, segment))) continue;
      context.save();
      const gradient = segmentGradient(context, segment, node);
      if (!gradient) applyStkTransparency(context, segment);
      context.strokeStyle = gradient || rgbColor(segment.color, node.joint.color || figure.color);
      context.fillStyle = context.strokeStyle;
      context.lineWidth = Math.max(0.65, segment.width * figure.scale);
      if (isStkCircleSegment(artwork, segment)) {
        if (segment.type === 1) drawLegacyHollowCircle(context, node, segment, figure.scale);
        else if (segment.type === 4) drawRing(context, node);
        else drawCircle(context, node, segment, figure.scale);
      }
      else {
        context.beginPath(); context.moveTo(node.start.x, node.start.y); appendArcPath(context, segment, node, false, figure.scale);
        context.lineCap = artwork.wrapper === 0x7a && segment.type === 6 ? 'square' : 'round';
        context.stroke();
      }
      context.restore();
    } else {
      const polygon = artwork.polygons[item - artwork.segments.length];
      if (!polygon) continue;
      context.save(); context.beginPath();
      applyStkTransparency(context, polygon);
      appendPolygonPath(context, artwork, nodes, polygon, figure.scale);
      context.fillStyle = rgbColor(polygon.color, figure.color); context.fill();
      context.restore();
    }
  }
  if (!showHandles) return true;
  for (const joint of figure.joints) {
    if (joint.handleVisible === false) continue;
    context.beginPath();
    let radius = handleRadius;
    if (joint.parentId === null) { context.fillStyle = '#f97316'; radius += 2; } else context.fillStyle = '#ef4444';
    context.arc(joint.x, joint.y, radius, 0, Math.PI * 2);
    context.fill();
  }
  if (drawSelection && figure.selected) {
    const root = joints.get('stk-root') || figure.joints.find(joint => joint.parentId === null);
    if (root) { context.beginPath(); context.arc(root.x, root.y, handleRadius + 5, 0, Math.PI * 2); context.strokeStyle = 'rgba(59,130,246,0.5)'; context.lineWidth = 1.5; context.stroke(); }
  }
  return true;
}

export function getStkArtworkBounds(figure, includeHandles = false) {
  if (!figure?.stkArtwork) return null;
  validateStkArtwork(figure.stkArtwork);
  figure.updatePositions();
  const nodes = getStkNodes(figure);
  const xs = [], ys = [];
  const add = (point, pad = 0) => { xs.push(point.x - pad, point.x + pad); ys.push(point.y - pad, point.y + pad); };
  const arcRefs = new Set();
  for (const polygon of figure.stkArtwork.polygons) {
    if (Number(polygon.transparency) >= 255) continue;
    for (let index = 0; index < polygon.vertices.length; index += 1) {
      const current = polygon.vertices[index], next = polygon.vertices[(index + 1) % polygon.vertices.length];
      if (next > 0 && figure.stkArtwork.segments[next - 1]?.parent === current) arcRefs.add(next);
      else if (current > 0 && figure.stkArtwork.segments[current - 1]?.parent === next) arcRefs.add(current);
    }
  }
  for (const segment of figure.stkArtwork.segments) {
    // A picture covers its whole image, placed on the segment; its size is known before it is decoded.
    if (isStkPictureSegment(figure.stkArtwork, segment)) {
      const image = figure.stkArtwork.images[segment.image];
      const node = nodes[segment.id];
      const transform = stkPictureTransform(node.start, node.end, image, segment.imageMirror === 1);
      if (transform) for (const [x, y] of [[0, 0], [image.width, 0], [0, image.height], [image.width, image.height]]) add({ x: transform.a * x + transform.c * y + transform.e, y: transform.b * x + transform.d * y + transform.f });
      continue;
    }
    const fullyTransparent = Number(segment.transparency) >= 255 && !(Array.isArray(segment.gradient) && segment.gradient[3] < 255);
    // A transparent construction segment can still be the curved boundary of
    // an opaque polygon. Keep its path for the polygon's fit envelope, but do
    // not add stroke padding for the invisible segment itself.
    if (fullyTransparent && !arcRefs.has(segment.id)) continue;
    const node = nodes[segment.id];
    const isCircle = isStkCircleSegment(figure.stkArtwork, segment);
    if (segment.width <= 0 && !isStkFilledCircleSegment(figure.stkArtwork, segment) && !arcRefs.has(segment.id)) continue;
    const steps = Math.max(8, Math.ceil(Math.abs(segment.bend || 0) * 32 / Math.PI));
    const chordLength = Math.hypot(node.end.x - node.start.x, node.end.y - node.start.y);
    const chordAngle = Math.atan2(node.end.y - node.start.y, node.end.x - node.start.x);
    const squareCap = figure.stkArtwork.wrapper === 0x7a && segment.type === 6;
    const pad = fullyTransparent ? 0 : isCircle ? (chordLength + segment.width * figure.scale) / 2 : segment.width * figure.scale / 2 * (squareCap ? Math.SQRT2 : 1);
    if (isCircle) {
      add({ x: (node.start.x + node.end.x) / 2, y: (node.start.y + node.end.y) / 2 }, pad);
      continue;
    }
    for (let index = 0; index <= steps; index += 1) add(pointOnStkSegment(segment, node.start, index / steps, chordLength, chordAngle, figure.scale), pad);
    // Add exact axis extrema so fit does not depend on sample spacing.
    if (Math.abs(segment.bend || 0) > EPSILON) {
      for (let q = -16; q <= 16; q += 1) {
        const tangent = chordAngle - (segment.bend || 0) / 2;
        const t = (q * Math.PI / 2 - tangent) / segment.bend;
        if (t > 0 && t < 1) add(pointOnStkSegment(segment, node.start, t, chordLength, chordAngle, figure.scale), pad);
      }
    }
  }
  for (const polygon of figure.stkArtwork.polygons) {
    if (Number(polygon.transparency) >= 255) continue;
    for (const reference of polygon.vertices) add(nodes[reference].end);
  }
  if (includeHandles) for (const joint of figure.joints) if (joint.handleVisible !== false) add({ x: joint.x, y: joint.y }, handleRadiusSafe(figure.scale));
  if (!xs.length) return { minX: figure.x - 1, maxX: figure.x + 1, minY: figure.y - 1, maxY: figure.y + 1 };
  const grow = (figureOutline(figure.stkArtwork)?.thickness || 0) * figure.scale;
  // A loop rather than Math.min(...xs): detailed figures sample hundreds of thousands of points, more
  // arguments than a single call can take.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of xs) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  for (const y of ys) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX: minX - grow, maxX: maxX + grow, minY: minY - grow, maxY: maxY + grow };
}

function handleRadiusSafe(scale) { return Math.max(1, 5 / Math.max(0.01, scale)); }
