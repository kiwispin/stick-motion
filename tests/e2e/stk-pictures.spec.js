import { expect, test } from '@playwright/test';
import { sampleFigure, stkFile } from '../stk-picture-fixture.mjs';

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

// Counts the pure red and pure blue pixels (the two rows of the sample picture) on a canvas.
async function pictureColours(page, selector) {
  return page.evaluate(selector => {
    const canvas = selector === 'stage' ? app.canvas : document.querySelector(selector);
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, blue = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 240 && data[index + 1] < 15 && data[index + 2] < 15) red += 1;
      if (data[index] < 15 && data[index + 1] < 15 && data[index + 2] > 240) blue += 1;
    }
    return { red, blue };
  }, selector);
}

test('a figure with pictures imports, draws, saves, reopens and exports with its pictures', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openCleanEditor(page);
  await page.locator('#stk-input').setInputFiles({ name: 'pictures.stk', mimeType: 'application/octet-stream', buffer: stkFile(sampleFigure()) });
  await expect(page.locator('#stk-import-insert')).toBeEnabled();
  await expect(page.locator('#stk-import-warnings')).toContainText('Pictures are drawn');
  // The preview is drawn again once the picture has been decoded.
  await expect.poll(async () => (await pictureColours(page, '#stk-import-preview')).red).toBeGreaterThan(50);
  await page.locator('#stk-import-insert').click();
  await expect.poll(async () => (await pictureColours(page, 'stage')).red).toBeGreaterThan(50);
  expect((await pictureColours(page, 'stage')).blue).toBeGreaterThan(50);
  await expect.poll(async () => (await pictureColours(page, '.frame-thumb canvas')).red).toBeGreaterThan(0);

  await page.evaluate(async () => { await app.saveLocal(); });
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  expect(await page.evaluate(() => app.figures[0].stkArtwork.images.length)).toBe(1);
  await expect.poll(async () => (await pictureColours(page, 'stage')).red).toBeGreaterThan(50);
  await expect.poll(async () => (await pictureColours(page, '.frame-thumb canvas')).red).toBeGreaterThan(0);

  // Reopen the saved project as fresh artwork, whose pictures are not decoded yet, and export a GIF at once:
  // every exported frame must still show the picture.
  const download = page.waitForEvent('download');
  const frames = await page.evaluate(async () => {
    app.addFrame();
    app.applyProjectData(JSON.parse(JSON.stringify(app.serializeProject())));
    const checks = [];
    const render = app.renderFrameToCtx.bind(app);
    app.renderFrameToCtx = (...args) => {
      const canvas = render(...args);
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index] > 240 && data[index + 1] < 15 && data[index + 2] < 15) red += 1;
      checks.push(red);
      return canvas;
    };
    await app.exportGif();
    return checks;
  });
  expect(frames.length).toBeGreaterThan(1);
  for (const red of frames) expect(red).toBeGreaterThan(50);
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.gif$/);
  expect(errors).toEqual([]);
});
