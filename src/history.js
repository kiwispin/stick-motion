import { cloneFigures } from './project.js';

export function createSnapshot(state) {
  return {
    frames: state.frames.map(frame => cloneFigures(frame)),
    frameDelays: [...state.frameDelays],
    currentFrameIndex: state.currentFrameIndex,
    figures: cloneFigures(state.figures),
    groups: state.groups.map(group => group.clone())
  };
}

export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  capture(state) {
    if (this.undoStack.length >= this.limit) this.undoStack.shift();
    this.undoStack.push(createSnapshot(state));
    this.redoStack = [];
  }

  undo(state) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(createSnapshot(state));
    return this.undoStack.pop();
  }

  redo(state) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(createSnapshot(state));
    return this.redoStack.pop();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
