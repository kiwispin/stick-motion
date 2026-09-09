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
    figure.joints = this.joints.map(joint => joint.clone());
    return figure;
  }

  updatePositions() {
    const jointsById = {};
    this.joints.forEach(joint => { jointsById[joint.id] = joint; });
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
    const process = joint => {
      calculate(joint);
      this.joints.filter(child => child.parentId === joint.id).forEach(process);
    };
    this.joints.filter(joint => joint.parentId === null).forEach(process);
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
