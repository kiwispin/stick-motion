export function getCanvasPosition(canvas, event, isTouch, stagePadding) {
  const rect = canvas.getBoundingClientRect();
  const point = isTouch ? event.touches[0] : event;
  return { x: (point.clientX - rect.left) * (canvas.width / rect.width) - stagePadding, y: (point.clientY - rect.top) * (canvas.height / rect.height) - stagePadding };
}

export function getWrapperPosition(area, event, isTouch) {
  const rect = area.getBoundingClientRect();
  const point = isTouch ? event.touches[0] : event;
  return { x: point.clientX - rect.left + area.scrollLeft, y: point.clientY - rect.top + area.scrollTop };
}

export function distanceToSegment(point, start, end) {
  const lengthSquared = (start.x - end.x) ** 2 + (start.y - end.y) ** 2;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * (end.x - start.x)), point.y - (start.y + ratio * (end.y - start.y)));
}

export function isPointInSpeechBubble(figure, point) {
  if (figure.type !== 'speech') return false;
  const handle = figure.joints.find(joint => joint.id === 'handle');
  let angle = 0;
  let scale = figure.scale || 1;
  if (handle) { angle = Math.atan2(handle.y - figure.y, handle.x - figure.x); scale = Math.max(0.1, Math.hypot(handle.x - figure.x, handle.y - figure.y) / 40); }
  const dx = point.x - figure.x, dy = point.y - figure.y, cos = Math.cos(angle), sin = Math.sin(angle);
  const x = (cos * dx + sin * dy) / scale, y = (-sin * dx + cos * dy) / scale;
  return (x >= -90 && x <= 90 && y >= -47 && y <= 47) || (x >= -72 && x <= -10 && y >= 36 && y <= 77);
}
