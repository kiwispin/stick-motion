import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

function fixture({ type = 0 } = {}) {
  const payload = Buffer.alloc(25);
  payload[0] = 1;
  payload[1] = 0; payload[2] = 1;
  payload.writeFloatLE(60, 5);
  payload.writeDoubleLE(0, 9);
  payload.writeFloatLE(8, 17);
  payload[21] = type;
  payload.writeUInt16LE(3133, 23);
  return Buffer.concat([Buffer.from([0x79]), zlib.deflateSync(payload)]);
}

async function openCleanEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  if (await page.locator('#welcome-modal').isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
  await page.evaluate(async () => {
    app.invalidateStkImport();
    app.newProject();
    app.figures = [];
    app.frames = [[]];
    app.currentFrameIndex = 0;
    app.selectedFigureIds.clear();
    await app.saveLocal();
  });
}

// A Pivot 5 (a8) figure made of one long chain of `count` segments.
function detailedFixture(count) {
  const payload = Buffer.alloc(3 + count * 23 + 4 + count * 2);
  payload[0] = 0xa8; payload.writeUInt16LE(count, 1);
  for (let index = 0; index < count; index += 1) {
    const offset = 3 + index * 23;
    payload.writeUInt16LE(index, offset);
    payload.writeFloatLE(0.2, offset + 2);
    payload.writeDoubleLE(0.002 * index, offset + 6);
    payload.writeFloatLE(2, offset + 14);
    payload[offset + 19] = index % 50 ? 1 : 0;
  }
  const tables = 3 + count * 23 + 4;
  for (let index = 0; index < count; index += 1) payload.writeUInt16LE(index, tables + index * 2);
  return Buffer.concat([Buffer.from([0x7a]), zlib.deflateSync(payload)]);
}

test('a very detailed imported figure can be posed, animated, undone, saved and reopened', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openCleanEditor(page);
  await page.locator('#stk-input').setInputFiles({ name: 'detailed.stk', mimeType: 'application/octet-stream', buffer: detailedFixture(6000) });
  await expect(page.locator('#stk-import-insert')).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('#stk-import-warnings')).toContainText('6,000 parts');
  await page.locator('#stk-import-insert').click();
  const result = await page.evaluate(async () => {
    const detailed = () => app.figures.find(figure => figure.stkArtwork);
    for (let frame = 0; frame < 4; frame += 1) {
      app.addFrame();
      app.saveState();
      app.rotateHierarchy(detailed(), 'stk-1', 0.2); // the whole 6,000-deep chain below the first segment
      app.render(); app.saveLocal();
    }
    app.undo(); app.redo();
    await app.localSaveQueue;
    const saved = app.serializeProject();
    return {
      frames: app.frames.length,
      parts: detailed().stkArtwork.segments.length,
      artworks: new Set(app.frames.map(frame => frame.find(figure => figure.stkArtwork).stkArtwork)).size,
      savedArtworks: Object.keys(saved.stkArtworks).length,
      poseKbPerFrame: Math.round(JSON.stringify(saved.frames[1]).length / 1024)
    };
  });
  // The artwork is saved once; each frame adds only the pose, about 45 bytes per part.
  expect(result).toMatchObject({ frames: 5, parts: 6000, artworks: 1, savedArtworks: 1 });
  expect(result.poseKbPerFrame).toBeLessThan(400);
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  expect(await page.evaluate(() => ({ frames: app.frames.length, parts: app.frames[0].find(figure => figure.stkArtwork)?.stkArtwork.segments.length }))).toEqual({ frames: 5, parts: 6000 });
  expect(errors).toEqual([]);
});

// A Pivot 5 (a8) figure of two segments, the first curved.
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

test('an imported figure plays smoothly and flips, including across a flip between frames', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openCleanEditor(page);
  await page.locator('#stk-input').setInputFiles({ name: 'curved.stk', mimeType: 'application/octet-stream', buffer: curvedFixture() });
  await expect(page.locator('#stk-import-insert')).toBeEnabled();
  await page.locator('#stk-import-insert').click();
  const flips = await page.evaluate(() => {
    const figure = () => app.figures.find(f => f.stkArtwork);
    const select = () => { app.figures.forEach(f => { f.selected = f === figure(); }); app.selectedFigureIds = new Set([figure().id]); };
    const original = figure().stkArtwork;
    app.addFrame(); select(); app.flipFigure();
    const flipped = figure().stkArtwork;
    app.addFrame(); select(); app.flipFigure();
    const back = figure().stkArtwork;
    figure().x += 40; app.render();
    return { bends: [original.segments[0].bend, flipped.segments[0].bend], backIsOriginal: back === original, flippedFrozen: Object.isFrozen(flipped) };
  });
  expect(flips).toEqual({ bends: [1.2, -1.2], backIsOriginal: true, flippedFrozen: true });
  // Smooth playback blends curves across the flip without touching the stored artwork.
  expect(await page.evaluate(() => app.isSmooth)).toBe(true);
  await page.evaluate(() => { app.loadFrame(0, false); app.play(); });
  await expect.poll(() => page.evaluate(() => app.currentFrameIndex), { timeout: 5000 }).toBeGreaterThan(0);
  const midway = await page.evaluate(() => {
    app.stop();
    const [first, second] = app.frames;
    app.renderInterpolated(first, second, 0.5);
    return { bend: app.figures.find(f => f.stkArtwork).stkArtwork.segments[0].bend, stored: first.find(f => f.stkArtwork).stkArtwork.segments[0].bend };
  });
  expect(midway).toEqual({ bend: 0, stored: 1.2 });
  await page.evaluate(async () => { app.loadFrame(0, false); await app.saveLocal(); });
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  expect(await page.evaluate(() => app.frames.map(frame => frame.find(f => f.stkArtwork).stkArtwork.segments[0].bend))).toEqual([1.2, -1.2, 1.2]);
  expect(errors).toEqual([]);
});

test('STK import warnings are shown as plain text, never as markup', async ({ page }) => {
  const importerPath = path.join(path.dirname(test.info().config.configFile), 'src', 'stk-import.js');
  await page.route('**/src/stk-import.js', async route => {
    let source = await readFile(importerPath, 'utf8');
    source = source.replace('export async function decodeStk(', 'async function originalDecodeStk(');
    source += '\nexport async function decodeStk(input) { const decoded = await originalDecodeStk(input); return { ...decoded, warnings: [...(decoded.warnings || []), \'<img src="x" onerror="window.injected=true">Check this part\'] }; }\n';
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: source });
  });
  await openCleanEditor(page);
  await page.locator('#stk-input').setInputFiles({ name: 'synthetic-line.stk', mimeType: 'application/octet-stream', buffer: fixture() });
  await expect(page.locator('#stk-import-warnings')).toContainText('<img src="x" onerror="window.injected=true">Check this part');
  expect(await page.locator('#stk-import-warnings img').count()).toBe(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('STK preview cancel is non-mutating; confirmed import is additive, undoable, and durable', async ({ page }) => {
  await openCleanEditor(page);
  const before = await page.evaluate(() => JSON.stringify(app.serializeProject()));
  await page.locator('#stk-input').setInputFiles({ name: 'synthetic-line.stk', mimeType: 'application/octet-stream', buffer: fixture() });
  await expect(page.locator('#stk-import-status')).toContainText('Ready to preview');
  await expect(page.locator('#stk-import-insert')).toBeEnabled();
  await page.locator('#stk-import-cancel').click();
  await expect.poll(() => page.evaluate(() => JSON.stringify(app.serializeProject()))).toBe(before);

  await page.locator('#stk-input').setInputFiles({ name: 'synthetic-line.stk', mimeType: 'application/octet-stream', buffer: fixture() });
  await expect(page.locator('#stk-import-insert')).toBeEnabled();
  await page.evaluate(() => app.confirmStkImport());
  await expect.poll(() => page.evaluate(() => app.figures.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => Boolean(app.figures[0].stkArtwork))).toBe(true);
  await page.evaluate(() => app.undo());
  await expect.poll(() => page.evaluate(() => app.figures.length)).toBe(0);
  await page.evaluate(() => app.redo());
  await expect.poll(() => page.evaluate(() => app.figures.length)).toBe(1);
  await page.evaluate(async () => app.saveLocal());
  await page.reload();
  await expect.poll(() => page.evaluate(() => app.figures.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => app.figures[0].stkArtwork.segments.length)).toBe(1);
});

test('unsupported STK feature fails in preview without replacing the current project', async ({ page }) => {
  await openCleanEditor(page);
  const before = await page.evaluate(() => JSON.stringify(app.serializeProject()));
  await page.locator('#stk-input').setInputFiles({ name: 'unsupported-type.stk', mimeType: 'application/octet-stream', buffer: fixture({ type: 6 }) });
  await expect(page.locator('#stk-import-status')).toContainText('unsupported type');
  await expect(page.locator('#stk-import-insert')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => JSON.stringify(app.serializeProject()))).toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('#stk-import-modal')).not.toHaveClass(/show/);
});
