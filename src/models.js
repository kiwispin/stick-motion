export const SEGMENT_LINE = 'line';
export const SEGMENT_CIRCLE = 'circle';

export class Joint {
  constructor(id, parentId, length, angle, type = SEGMENT_LINE, radius = 20, thickness = 14, filled = true, color = null, handleVisible = true) {
    this.id = id;
    this.parentId = parentId;
    this.length = length;
    this.angle = angle;
    this.type = type;
    this.radius = radius;
    this.thickness = thickness;
    this.filled = filled;
    this.color = color;
    // Decorative construction joints can remain part of the rig while their
    // pivot is hidden and unavailable for direct posing. Older figures keep
    // the original behaviour because the property defaults to true.
    this.handleVisible = handleVisible !== false;
    this.x = 0;
    this.y = 0;
  }

  clone() {
    return new Joint(this.id, this.parentId, this.length, this.angle, this.type, this.radius, this.thickness, this.filled, this.color, this.handleVisible);
  }
}

export class Figure {
  constructor() {
    this.id = Math.random().toString(36).substr(2, 9);
    this.x = 400;
    this.y = 300;
    this.joints = [];
    this.scale = 1.0;
    this.color = '#000000';
    this.selected = false;
    this.type = 'figure';
    this.text = '';
    this.groupId = null;
    // Optional, validated source-artwork data for an experimental STK figure.
    // Ordinary figures leave this null and keep the established renderer path.
    this.stkArtwork = null;
  }

  clone() {
    const figure = new Figure();
    figure.id = this.id;
    figure.x = this.x;
    figure.y = this.y;
    figure.scale = this.scale;
    figure.color = this.color;
    figure.selected = this.selected;
    figure.type = this.type;
    figure.text = this.text;
    figure.groupId = this.groupId;
    // Imported artwork is frozen and never changes, so clones share it rather than copying thousands of parts.
    figure.stkArtwork = this.stkArtwork;
    figure.joints = this.joints.map(joint => joint.clone());
    return figure;
  }

  updatePositions() {
    // Index children once, so a large imported figure costs time in proportion to its joints, not their square.
    const jointsById = {};
    const childrenByParent = new Map();
    this.joints.forEach(joint => {
      jointsById[joint.id] = joint;
      if (!childrenByParent.has(joint.parentId)) childrenByParent.set(joint.parentId, []);
      childrenByParent.get(joint.parentId).push(joint);
    });
    const calculate = joint => {
      if (joint.parentId === null) {
        joint.x = this.x;
        joint.y = this.y;
      } else {
        const parent = jointsById[joint.parentId];
        if (parent) {
          joint.x = parent.x + Math.cos(joint.angle) * (joint.length * this.scale);
          joint.y = parent.y + Math.sin(joint.angle) * (joint.length * this.scale);
        }
      }
    };
    // Walk parents before children with an explicit stack: imported figures can nest thousands of joints deep,
    // which would overflow the call stack if this recursed.  The order matches a depth-first recursion.
    const stack = [...(childrenByParent.get(null) || [])].reverse();
    let visits = 0;
    while (stack.length && visits++ <= this.joints.length) {
      const joint = stack.pop();
      calculate(joint);
      const children = childrenByParent.get(joint.id);
      if (children) for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
  }
}

export class FigureGroup {
  constructor(id, figureIds, label) {
    this.id = id;
    this.figureIds = [...figureIds];
    this.label = label || `Group ${id.substr(0, 4)}`;
  }

  clone() {
    return new FigureGroup(this.id, [...this.figureIds], this.label);
  }
}
