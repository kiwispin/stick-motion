import { marqueeBounds } from './marquee.js';

export function updateCursor(canvas, figures, position, handleRadius) {
  const overHandle = figures.some(figure => {
    figure.updatePositions();
    return figure.joints.some(joint => Math.hypot(position.x - joint.x, position.y - joint.y) < handleRadius * 2);
  });
  canvas.style.cursor = overHandle ? 'pointer' : 'crosshair';
}

export function findDragTarget({ figures, position, handleRadius, distanceToSegment, isPointInSpeechBubble }) {
  const hitRadius = handleRadius + 10;
  for (let index = figures.length - 1; index >= 0; index -= 1) {
    const figure = figures[index];
    figure.updatePositions();
    const root = figure.joints.find(joint => joint.parentId === null);
    if (root && Math.hypot(position.x - root.x, position.y - root.y) < hitRadius) {
      return { figure, type: 'root', joint: root, offsetX: position.x - figure.x, offsetY: position.y - figure.y };
    }
    for (const joint of figure.joints) {
      if (joint.parentId !== null && Math.hypot(position.x - joint.x, position.y - joint.y) < hitRadius) return { figure, type: 'joint', joint };
    }
  }

  for (let index = figures.length - 1; index >= 0; index -= 1) {
    const figure = figures[index];
    figure.updatePositions();
    if (isPointInSpeechBubble(figure, position)) {
      const root = figure.joints.find(joint => joint.parentId === null);
      if (root) return { figure, type: 'root', joint: root, offsetX: position.x - figure.x, offsetY: position.y - figure.y };
    }
  }

  for (let index = figures.length - 1; index >= 0; index -= 1) {
    const figure = figures[index];
    for (const joint of figure.joints) {
      if (joint.parentId === null) continue;
      const parent = figure.joints.find(item => item.id === joint.parentId);
      if (parent && distanceToSegment(position, parent, joint) < (joint.thickness || 14) * figure.scale / 2 + 5) {
        const root = figure.joints.find(item => item.parentId === null);
        if (root) return { figure, type: 'root', joint: root, offsetX: position.x - figure.x, offsetY: position.y - figure.y };
      }
    }
  }
  return null;
}

export function moveRootDrag({ target, position, figures, groups, selectedIds }) {
  const figure = target.figure;
  const nextX = position.x - target.offsetX, nextY = position.y - target.offsetY;
  const dx = nextX - figure.x, dy = nextY - figure.y;
  const ids = figure.groupId ? groups.find(group => group.id === figure.groupId)?.figureIds : selectedIds.size > 1 ? selectedIds : null;
  if (ids) ids.forEach(id => { const member = figures.find(item => item.id === id); if (member) { member.x += dx; member.y += dy; } });
  else { figure.x = nextX; figure.y = nextY; }
}

export function moveJointDrag({ target, position, updateFreeJoint, rotateHierarchy }) {
  const joint = target.joint;
  const figure = target.figure;
  const parent = figure.joints.find(item => item.id === joint.parentId);
  if (figure.type === 'speech' && joint.id === 'tail') {
    updateFreeJoint(figure, joint, position);
  } else if (parent) {
    const angle = Math.atan2(position.y - parent.y, position.x - parent.x);
    const delta = angle - joint.angle;
    joint.angle = angle;
    rotateHierarchy(figure, joint.id, delta);
  }
}

export function beginMarquee(position) {
  return { active: true, startX: position.x, startY: position.y, endX: position.x, endY: position.y };
}

export function showMarqueeElement(element, marquee) {
  const bounds = marqueeBounds(marquee);
  element.style.display = 'block';
  element.style.left = `${bounds.left}px`;
  element.style.top = `${bounds.top}px`;
  element.style.width = `${bounds.right - bounds.left}px`;
  element.style.height = `${bounds.bottom - bounds.top}px`;
}

export function updateMarqueeElement(element, marquee, position) {
  marquee.endX = position.x; marquee.endY = position.y;
  showMarqueeElement(element, marquee);
}

export function endMarquee(element, marquee) {
  marquee.active = false;
  element.style.display = 'none';
  return marqueeBounds(marquee);
}

export function marqueeCanvasBounds({ marquee, canvasRect, wrapperRect, scrollLeft, scrollTop, canvasWidth, canvasHeight, stagePadding }) {
  const bounds = marqueeBounds(marquee);
  const offsetX = canvasRect.left - wrapperRect.left + scrollLeft;
  const offsetY = canvasRect.top - wrapperRect.top + scrollTop;
  const scaleX = canvasWidth / canvasRect.width;
  const scaleY = canvasHeight / canvasRect.height;
  return {
    left: (bounds.left - offsetX) * scaleX - stagePadding,
    top: (bounds.top - offsetY) * scaleY - stagePadding,
    right: (bounds.right - offsetX) * scaleX - stagePadding,
    bottom: (bounds.bottom - offsetY) * scaleY - stagePadding
  };
}
