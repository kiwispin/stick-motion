export function marqueeBounds(marquee) {
  return { left: Math.min(marquee.startX, marquee.endX), top: Math.min(marquee.startY, marquee.endY), right: Math.max(marquee.startX, marquee.endX), bottom: Math.max(marquee.startY, marquee.endY) };
}

export function isMeaningfulMarquee(marquee, threshold = 4) {
  const bounds = marqueeBounds(marquee);
  return bounds.right - bounds.left > threshold || bounds.bottom - bounds.top > threshold;
}
