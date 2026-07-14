const HALF_PI = Math.PI / 2;

export const STARTER_TEMPLATES = {
  walk: { label: 'Walk', description: '8-pose in-place walk cycle' },
  jump: { label: 'Jump', description: '9-pose jump and landing' },
  wave: { label: 'Wave', description: '8-pose greeting gesture' },
  blank: { label: 'Blank canvas', description: 'One empty frame' }
};

function findJoint(figure, id) {
  return figure.joints.find(item => item.id === id);
}

function setAngles(figure, angles) {
  Object.entries(angles).forEach(([id, angle]) => {
    const item = findJoint(figure, id);
    if (item) item.angle = angle;
  });
}

function targetLeg(figure, kneeId, footId, target, bend = 1) {
  const knee = findJoint(figure, kneeId), foot = findJoint(figure, footId);
  if (!knee || !foot) return;
  const dx = target.x - figure.x, dy = target.y - figure.y;
  const length1 = knee.length * figure.scale, length2 = foot.length * figure.scale;
  const distance = Math.max(0.001, Math.min(length1 + length2 - 0.001, Math.hypot(dx, dy)));
  const direction = Math.atan2(dy, dx);
  const cosine = (length1 ** 2 + distance ** 2 - length2 ** 2) / (2 * length1 * distance);
  knee.angle = direction + bend * Math.acos(Math.max(-1, Math.min(1, cosine)));
  const kneeX = figure.x + Math.cos(knee.angle) * length1;
  const kneeY = figure.y + Math.sin(knee.angle) * length1;
  foot.angle = Math.atan2(target.y - kneeY, target.x - kneeX);
}

function createPose(base, pose) {
  const figure = base.clone();
  figure.selected = false;
  figure.x = pose.x ?? 400;
  figure.y = pose.y;
  setAngles(figure, { abs: -HALF_PI, chest: -HALF_PI, neck: -HALF_PI, ...pose.angles });
  if (pose.leftFoot) targetLeg(figure, 'lKnee', 'lFoot', pose.leftFoot, pose.leftBend ?? 1);
  if (pose.rightFoot) targetLeg(figure, 'rKnee', 'rFoot', pose.rightFoot, pose.rightBend ?? -1);
  figure.updatePositions();
  return [figure];
}

function walkFrames(base) {
  const ground = 384;
  const poses = [
    { y: 320, leftFoot: { x: 426, y: ground }, rightFoot: { x: 374, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.2, lElbow: 2.02, lHand: 2.2, rShldr: -0.55, rElbow: -0.36, rHand: -0.55 } },
    { y: 325, leftFoot: { x: 423, y: ground }, rightFoot: { x: 382, y: 383 }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.35, lElbow: 2.18, lHand: 2.35, rShldr: -0.35, rElbow: -0.18, rHand: -0.35 } },
    { y: 321, leftFoot: { x: 416, y: ground }, rightFoot: { x: 400, y: 374 }, leftBend: -1, rightBend: -1, angles: { lShldr: 2.65, lElbow: 2.5, lHand: 2.65, rShldr: -0.05, rElbow: 0.1, rHand: -0.05 } },
    { y: 317, leftFoot: { x: 408, y: ground }, rightFoot: { x: 416, y: 382 }, leftBend: -1, rightBend: -1, angles: { lShldr: 2.9, lElbow: 2.76, lHand: 2.9, rShldr: 0.2, rElbow: 0.34, rHand: 0.2 } },
    { y: 320, leftFoot: { x: 374, y: ground }, rightFoot: { x: 426, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 3.65, lElbow: 3.46, lHand: 3.65, rShldr: 0.95, rElbow: 0.76, rHand: 0.95 } },
    { y: 325, leftFoot: { x: 382, y: 383 }, rightFoot: { x: 423, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 3.45, lElbow: 3.28, lHand: 3.45, rShldr: 0.8, rElbow: 0.63, rHand: 0.8 } },
    { y: 321, leftFoot: { x: 400, y: 374 }, rightFoot: { x: 416, y: ground }, leftBend: 1, rightBend: 1, angles: { lShldr: 3.15, lElbow: 3, lHand: 3.15, rShldr: 0.5, rElbow: 0.35, rHand: 0.5 } },
    { y: 317, leftFoot: { x: 416, y: 382 }, rightFoot: { x: 408, y: ground }, leftBend: 1, rightBend: 1, angles: { lShldr: 2.9, lElbow: 2.76, lHand: 2.9, rShldr: 0.2, rElbow: 0.34, rHand: 0.2 } }
  ];
  return poses.map(pose => createPose(base, pose));
}

function jumpFrames(base) {
  const ground = 388;
  const poses = [
    { y: 320, leftFoot: { x: 384, y: ground }, rightFoot: { x: 416, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.9, lElbow: 2.7, lHand: 2.8, rShldr: 0.24, rElbow: 0.44, rHand: 0.34 } },
    { y: 342, leftFoot: { x: 384, y: ground }, rightFoot: { x: 416, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.15, lElbow: 2.45, lHand: 2.62, rShldr: 0.98, rElbow: 0.7, rHand: 0.52 } },
    { y: 323, leftFoot: { x: 390, y: ground }, rightFoot: { x: 410, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 3.85, lElbow: 4.25, lHand: 4.4, rShldr: -0.7, rElbow: -1.1, rHand: -1.25 } },
    { y: 278, angles: { lKnee: 1.28, lFoot: 1.48, rKnee: 1.86, rFoot: 1.66, lShldr: 3.95, lElbow: 4.35, lHand: 4.48, rShldr: -0.8, rElbow: -1.2, rHand: -1.35 } },
    { y: 246, leftFoot: { x: 372, y: 300 }, rightFoot: { x: 428, y: 300 }, leftBend: -1, rightBend: 1, angles: { lShldr: 3.75, lElbow: 4.12, lHand: 4.28, rShldr: -0.6, rElbow: -0.98, rHand: -1.15 } },
    { y: 278, angles: { lKnee: 1.4, lFoot: 1.5, rKnee: 1.74, rFoot: 1.64, lShldr: 3.55, lElbow: 3.88, lHand: 4.02, rShldr: -0.42, rElbow: -0.76, rHand: -0.9 } },
    { y: 320, leftFoot: { x: 386, y: ground }, rightFoot: { x: 414, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.55, lElbow: 2.72, lHand: 2.86, rShldr: 0.58, rElbow: 0.42, rHand: 0.28 } },
    { y: 342, leftFoot: { x: 384, y: ground }, rightFoot: { x: 416, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.35, lElbow: 2.52, lHand: 2.68, rShldr: 0.78, rElbow: 0.62, rHand: 0.48 } },
    { y: 320, leftFoot: { x: 384, y: ground }, rightFoot: { x: 416, y: ground }, leftBend: -1, rightBend: 1, angles: { lShldr: 2.9, lElbow: 2.7, lHand: 2.8, rShldr: 0.24, rElbow: 0.44, rHand: 0.34 } }
  ];
  return poses.map(pose => createPose(base, pose));
}

function waveFrames(base) {
  const standing = { leftFoot: { x: 384, y: 388 }, rightFoot: { x: 416, y: 388 }, leftBend: -1, rightBend: 1 };
  const poses = [
    { ...standing, y: 320, angles: { lShldr: 2.94, lElbow: 2.72, lHand: 2.86, rShldr: 0.2, rElbow: 0.48, rHand: 0.28 } },
    { ...standing, y: 320, angles: { lShldr: 2.88, lElbow: 2.68, lHand: 2.82, rShldr: -0.48, rElbow: -1.3, rHand: -1.12 } },
    { ...standing, y: 319, angles: { abs: -1.6, chest: -1.6, lShldr: 2.82, lElbow: 2.62, lHand: 2.78, rShldr: -0.58, rElbow: -1.5, rHand: -2.18 } },
    { ...standing, y: 319, angles: { abs: -1.6, chest: -1.6, lShldr: 2.82, lElbow: 2.62, lHand: 2.78, rShldr: -0.5, rElbow: -1.28, rHand: -0.62 } },
    { ...standing, y: 319, angles: { abs: -1.6, chest: -1.6, lShldr: 2.82, lElbow: 2.62, lHand: 2.78, rShldr: -0.58, rElbow: -1.5, rHand: -2.18 } },
    { ...standing, y: 319, angles: { abs: -1.6, chest: -1.6, lShldr: 2.82, lElbow: 2.62, lHand: 2.78, rShldr: -0.5, rElbow: -1.28, rHand: -0.62 } },
    { ...standing, y: 320, angles: { lShldr: 2.88, lElbow: 2.68, lHand: 2.82, rShldr: -0.25, rElbow: -0.85, rHand: -0.55 } },
    { ...standing, y: 320, angles: { lShldr: 2.94, lElbow: 2.72, lHand: 2.86, rShldr: 0.2, rElbow: 0.48, rHand: 0.28 } }
  ];
  return poses.map(pose => createPose(base, pose));
}

export function buildStarterFrames(type, baseFigure) {
  if (type === 'blank') return [[]];
  if (!baseFigure) throw new Error('A base figure is required.');
  if (type === 'walk') return walkFrames(baseFigure);
  if (type === 'jump') return jumpFrames(baseFigure);
  if (type === 'wave') return waveFrames(baseFigure);
  throw new Error('Unknown starter template.');
}
