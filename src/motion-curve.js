// Curved motion between frames, as SketchMotion's "Curved" uses: between p1 and p2, a cubic whose ends
// follow the neighbouring points p0 and p3 (a Catmull-Rom spline written as a Bezier curve). It passes
// through every frame's point, so a jump made of a few poses plays as an arc instead of a zig-zag.
// At an end of the animation, pass the end point itself as its missing neighbour.
export function curvePoint(p0, p1, p2, p3, t) {
  const along = (a, b, c, d) => {
    const c1 = b + (c - a) / 6, c2 = c - (d - b) / 6;
    return (1 - t) ** 3 * b + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * c;
  };
  return { x: along(p0.x, p1.x, p2.x, p3.x), y: along(p0.y, p1.y, p2.y, p3.y) };
}

// How a move from one frame to the next spends its time, chosen per frame: 'even' keeps one speed, 'in' starts
// slowly and speeds up (a ball dropping), 'out' slows to a stop (a ball at the top of a throw), and 'inout'
// does both (a swing).  easeProgress takes the share of the move's time gone (0 to 1) and gives the share
// of the way travelled.  The curves are gravity's own: something speeding up or slowing down steadily.
export const EASES = ['even', 'in', 'out', 'inout'];
export function easeProgress(ease, t) {
  if (ease === 'in') return t * t;
  if (ease === 'out') return 1 - (1 - t) * (1 - t);
  if (ease === 'inout') return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  return t;
}
