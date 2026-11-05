import { expect, test } from '@playwright/test';

async function openEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

// A fresh project with `count` frames, the figure further right in each, and frame 1 showing.
async function framesProject(page, count) {
  await page.evaluate(count => {
    app.newProject();
    for (let i = 0; i < count; i += 1) {
      if (i) { app.addFrame(); app.figures[0].x += 30; }
      app.frames[app.currentFrameIndex] = app.figures.map(figure => figure.clone());
    }
    app.loadFrame(0, false);
  }, count);
}

const frameIndex = page => page.evaluate(() => app.currentFrameIndex);
const thumbCentre = (page, index) => page.locator('.frame-thumb').nth(index).evaluate(thumb => { const box = thumb.getBoundingClientRect(); return box.left + box.width / 2; });

test('dragging along the scrub bar flips through frames, and its playhead follows', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 6);
  const scrub = page.locator('#frame-scrub');
  const bar = await scrub.boundingBox();
  const y = bar.y + bar.height / 2;
  await page.mouse.move(await thumbCentre(page, 0), y);
  await page.mouse.down();
  await page.mouse.move(await thumbCentre(page, 2), y, { steps: 4 });
  expect(await frameIndex(page)).toBe(2);
  await page.mouse.move(await thumbCentre(page, 4), y, { steps: 4 });
  await page.mouse.up();
  expect(await frameIndex(page)).toBe(4);
  await expect(page.locator('.frame-playhead')).toHaveText('5');
  await expect(scrub).toHaveAttribute('aria-valuetext', 'Frame 5 of 6');
  expect(await page.locator('.frame-scrub-tick').count()).toBe(6);
  // The playhead sits over the current thumbnail.
  const playhead = await page.locator('.frame-playhead').boundingBox();
  expect(Math.abs(playhead.x + playhead.width / 2 - await thumbCentre(page, 4))).toBeLessThan(2);
  // Each frame kept its own pose while being flipped through.
  expect(await page.evaluate(() => app.frames.map(frame => Math.round(frame[0].x)))).toEqual([400, 430, 460, 490, 520, 550]);
});

test('scrubbing stops playback, and the scrub bar and Home and End step through frames from the keyboard', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 5);
  await page.evaluate(() => app.play());
  const bar = await page.locator('#frame-scrub').boundingBox();
  await page.mouse.click(await thumbCentre(page, 3), bar.y + bar.height / 2);
  expect(await page.evaluate(() => ({ playing: app.isPlaying, frame: app.currentFrameIndex }))).toEqual({ playing: false, frame: 3 });
  await page.locator('#frame-scrub').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await frameIndex(page)).toBe(2);
  await page.keyboard.press('End');
  expect(await frameIndex(page)).toBe(4);
  await page.keyboard.press('Home');
  expect(await frameIndex(page)).toBe(0);
  // Home and End also work away from the scrub bar.
  await page.locator('#main-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('End');
  expect(await frameIndex(page)).toBe(4);
});

test('? opens Help, which lists the new keys', async ({ page }) => {
  await openEditor(page);
  await page.locator('#main-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await expect(page.locator('#help-modal')).toHaveClass(/show/);
  await expect(page.locator('#help-modal')).toContainText('Home / End');
});

// The stage pixel on the torso of the figure as it stands in frame `index` (just above its root).
const torsoPixel = (page, index) => page.evaluate(index => {
  const figure = app.frames[index][0];
  const [r, g, b] = app.ctx.getImageData(app.stagePadding + figure.x, app.stagePadding + figure.y - 12, 1, 1).data;
  return { r, g, b };
}, index);
const blank = ({ r, g, b }) => r > 250 && g > 250 && b > 250;
const grey = ({ r, g, b }) => r < 240 && Math.abs(r - b) < 6;
const blue = ({ r, b }) => b > r + 20;

test('onion skin shows earlier frames faded and later frames in blue, as set in its menu', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 5);
  await page.evaluate(() => app.loadFrame(2, false));
  // By default only the frame before shows.
  expect(blank(await torsoPixel(page, 0))).toBe(true);
  expect(grey(await torsoPixel(page, 1))).toBe(true);
  expect(blank(await torsoPixel(page, 3))).toBe(true);

  await page.locator('#btn-onion-settings').click();
  await expect(page.locator('#onion-menu')).toBeVisible();
  await page.getByRole('button', { name: 'Show more earlier frames' }).click();
  await page.getByRole('button', { name: 'Show more later frames' }).click();
  await expect(page.locator('#onion-before-val')).toHaveText('2');
  await expect(page.locator('#onion-after-val')).toHaveText('1');
  const twoBack = await torsoPixel(page, 0), oneBack = await torsoPixel(page, 1);
  expect(grey(twoBack) && grey(oneBack) && twoBack.r > oneBack.r).toBe(true); // further back is fainter
  expect(blue(await torsoPixel(page, 3))).toBe(true);
  expect(blank(await torsoPixel(page, 4))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#onion-menu')).toBeHidden();
  await expect(page.locator('#btn-onion-settings')).toBeFocused();

  // The counts are saved with the project, and switching Onion off hides it all.
  await page.evaluate(() => app.localSaveQueue);
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  expect(await page.evaluate(() => [app.onionBefore, app.onionAfter])).toEqual([2, 1]);
  await page.evaluate(() => { app.loadFrame(2, false); app.toggleOnion(); });
  expect(blank(await torsoPixel(page, 1)) && blank(await torsoPixel(page, 3))).toBe(true);
});

test('Undo keeps 100 steps', async ({ page }) => {
  await openEditor(page);
  const steps = await page.evaluate(() => {
    app.newProject();
    for (let i = 0; i < 120; i += 1) { app.saveState(); app.figures[0].x += 1; }
    let undone = 0;
    while (app.history.undoStack.length) { app.undo(); undone += 1; }
    return undone;
  });
  expect(steps).toBe(100);
});
