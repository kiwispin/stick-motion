import { expect, test } from '@playwright/test';
import zlib from 'node:zlib';

// Autosave and project files reuse each frame's JSON from earlier saves.  Through real edits in the editor
// the saved text must stay exactly what the plain serialiser gives, and a reload must give the same project.

async function openCleanEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  if (await page.locator('#welcome-modal').isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
  await page.evaluate(async () => {
    app.invalidateStkImport();
    app.newProject();
    await app.saveLocal();
  });
}

// A Pivot 5 (a8) figure of two segments, the first curved, so flipping it gives different artwork.
function curvedFixture() {
  const payload = Buffer.alloc(3 + 2 * 23 + 2 + 10 + 2 + 2 * 2);
  payload[0] = 0xa8; payload.writeUInt16LE(2, 1);
  [[0, 80, 0], [1, 60, Math.PI / 2]].forEach(([parent, length, angle], index) => {
    const offset = 3 + index * 23;
    payload.writeUInt16LE(parent, offset); payload.writeFloatLE(length, offset + 2);
    payload.writeDoubleLE(angle, offset + 6); payload.writeFloatLE(6, offset + 14);
  });
  const tables = 3 + 2 * 23;
  payload.writeUInt16LE(1, tables); payload.writeUInt16LE(0, tables + 2); payload.writeDoubleLE(1.2, tables + 4);
  payload.writeUInt16LE(0, tables + 12);
  payload.writeUInt16LE(0, tables + 14); payload.writeUInt16LE(1, tables + 16);
  return Buffer.concat([Buffer.from([0x7a]), zlib.deflateSync(payload)]);
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('autosave writes exactly the plain project JSON through many edits, and a reload gives the same project', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openCleanEditor(page);
  await page.locator('#stk-input').setInputFiles({ name: 'curved.stk', mimeType: 'application/octet-stream', buffer: curvedFixture() });
  await expect(page.locator('#stk-import-insert')).toBeEnabled();
  await page.locator('#stk-import-insert').click();

  const result = await page.evaluate(async pixel => {
    const { serializeProject, serializeProjectJson } = await import('/src/project.js');
    const { readStoredProject } = await import('/src/storage.js');
    const mismatches = [];
    let checks = 0;
    // After each edit, an autosave (not every edit saves by itself, e.g. moving a frame) writes the plain JSON.
    const check = async label => {
      await app.saveLocal(); // commits the stage to its frame, then saves
      const stored = await readStoredProject();
      const expected = JSON.stringify(serializeProject(app));
      if (stored !== expected || serializeProjectJson(app) !== expected) mismatches.push(label);
      checks += 1;
    };
    const imported = () => app.figures.find(f => f.stkArtwork);
    const stickmen = () => app.figures.filter(f => !f.stkArtwork);
    const edits = [
      ['add stickmen', () => { app.addFigure(); app.addFigure(); }],
      ['move a figure', () => { app.saveState(); stickmen()[0].x += 37; app.render(); app.saveLocal(); }],
      ['pose a joint', () => { app.saveState(); app.rotateHierarchy(stickmen()[1], stickmen()[1].joints[1].id, 0.4); app.render(); app.saveLocal(); }],
      ['add frame', () => app.addFrame()],
      ['flip the imported figure', () => { app.selectFigure(imported()); app.flipFigure(); }],
      ['group two stickmen', () => { app.selectedFigureIds = new Set(stickmen().map(f => f.id)); app.groupSelected(); }],
      ['duplicate frame', () => app.duplicateCurrentFrame()],
      ['scale the imported figure', () => { app.selectFigure(imported()); app.scaleFigure(1.5); }],
      ['copy and paste frames', () => { app.loadFrame(0); app.copyFrames(); app.loadFrame(2); app.pasteFrames(); }],
      ['move frame earlier', () => app.moveFrame(-1)],
      ['drag a motion-path dot', () => {
        app.selectFigure(stickmen()[0]);
        const id = stickmen()[0].id, index = app.currentFrameIndex === 0 ? 1 : 0, at = app.frames[index].find(f => f.id === id);
        app.pathDrag = { id, index, start: { x: at.x, y: at.y }, moved: false };
        app.dragPathDot({ x: at.x + 40, y: at.y + 25 }); app.finishPathDrag();
      }],
      ['delete frame', () => { app.loadFrame(1); app.deleteFrame(); }],
      ['ungroup', () => { app.selectFigure(stickmen()[0]); app.ungroupSelected(); }],
      ['text', () => { app.addText(); app.updateText('He said "stkArtworkRef":"stk1"\n— café'); app.endTextEdit(); }],
      ['settings', () => { app.toggleLoop(); app.toggleOnion(); app.togglePath(); app.updateFps(18); }],
      ['frame duration', () => { app.setFrameDuration(2.5); app.endFrameDurationEdit(); }],
      ['project name', () => { app.setProjectName('Fast "save" ✓'); }],
      ['background', () => { app.restoreBackground(pixel); app.saveLocal(); }],
      ['undo twice', () => { app.undo(); app.undo(); }],
      ['redo', () => app.redo()],
      ['clear background', () => app.clearBackgroundImage()],
      ['download project file', () => { app.saveProject(); }]
    ];
    for (const [label, edit] of edits) { edit(); await check(label); }
    return { mismatches, checks, frames: app.frames.length, saved: await readStoredProject() };
  }, PIXEL);
  expect(result.mismatches).toEqual([]);
  expect(result.checks).toBeGreaterThan(20);
  expect(result.frames).toBeGreaterThan(2);
  const saved = JSON.parse(result.saved);
  expect(Object.keys(saved.stkArtworks || {}).length).toBeGreaterThan(0);

  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const reloaded = await page.evaluate(async () => {
    const { serializeProject, serializeProjectJson } = await import('/src/project.js');
    app.commitActiveFrame();
    return { plain: JSON.stringify(serializeProject(app)), fast: serializeProjectJson(app) };
  });
  expect(reloaded.fast).toBe(reloaded.plain);
  // Opening a project tidies each joint angle with atan2(sin, cos), which can move it by a rounding step
  // (0.2 opens as 0.19999999999999998), as it always has; everything else comes back exactly.
  const differences = [];
  const compare = (a, b, path) => {
    if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-12 * Math.max(1, Math.abs(a))) differences.push(path); return; }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) differences.push(path); return; }
    const keys = Object.keys(a);
    if (keys.join() !== Object.keys(b).join()) { differences.push(`${path} keys`); return; }
    keys.forEach(key => compare(a[key], b[key], `${path}.${key}`));
  };
  compare(JSON.parse(reloaded.fast), saved, 'project');
  expect(differences).toEqual([]);
  expect(errors).toEqual([]);
});

test('a downloaded project file is the same text as the plain project JSON', async ({ page }) => {
  await openCleanEditor(page);
  await page.locator('#stk-input').setInputFiles({ name: 'curved.stk', mimeType: 'application/octet-stream', buffer: curvedFixture() });
  await expect(page.locator('#stk-import-insert')).toBeEnabled();
  await page.locator('#stk-import-insert').click();
  await page.evaluate(() => { app.addFigure(); app.addFrame(); app.selectFigure(app.figures.find(f => f.stkArtwork)); app.flipFigure(); });
  const download = page.waitForEvent('download');
  await page.evaluate(() => app.saveProject());
  const file = await (await download).createReadStream();
  const chunks = [];
  for await (const chunk of file) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const expected = await page.evaluate(async () => { const { serializeProject } = await import('/src/project.js'); app.commitActiveFrame(); return JSON.stringify(serializeProject(app)); });
  expect(text).toBe(expected);
  expect(Object.keys(JSON.parse(text).stkArtworks)).toEqual(['stk1', 'stk2']);
});
