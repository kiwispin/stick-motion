import { expect, test } from '@playwright/test';
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
