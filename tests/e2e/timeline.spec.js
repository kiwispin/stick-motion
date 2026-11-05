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

// Where the figure stands in frame `index`: its root on screen, the stage pixel on its path dot's blue rim,
// and the stage's units per screen pixel.
const rootPoint = (page, index) => page.evaluate(index => {
  const figure = app.frames[index][0], box = app.canvas.getBoundingClientRect(), scale = box.width / app.canvas.width, k = app.pathScale();
  const [r, g, b] = app.ctx.getImageData(Math.floor(app.stagePadding + figure.x + 5 * k), Math.floor(app.stagePadding + figure.y), 1, 1).data;
  return { r, g, b, x: figure.x, y: figure.y, k, clientX: box.left + (app.stagePadding + figure.x) * scale, clientY: box.top + (app.stagePadding + figure.y) * scale };
}, index);

// Four frames of an arc, frame 3 showing, the figure selected, Path on.
async function arcProject(page) {
  await page.evaluate(() => {
    app.newProject();
    if (!app.showPath) app.togglePath(); // the path starts off
    [[200, 300], [300, 220], [400, 200], [500, 220]].forEach(([x, y], i) => {
      if (i) app.addFrame();
      app.figures[0].x = x; app.figures[0].y = y;
      app.frames[app.currentFrameIndex] = app.figures.map(figure => figure.clone());
    });
    app.loadFrame(2, false); app.selectedFigureIds.clear(); app.selectFigure(app.figures[0]); app.render();
  });
}

test('the selected figure shows its path across frames, and clicking a dot goes to that frame', async ({ page }) => {
  await openEditor(page);
  await arcProject(page);
  expect(blue(await rootPoint(page, 0))).toBe(true); // every other frame has a dot with a blue rim
  expect(blue(await rootPoint(page, 3))).toBe(true);

  // Hovering a dot names its frame.
  const dot = await rootPoint(page, 0);
  await page.mouse.move(dot.clientX, dot.clientY);
  expect(await page.evaluate(() => app.pathHover?.index)).toBe(0);
  await page.mouse.down(); await page.mouse.up();
  expect(await page.evaluate(() => ({ frame: app.currentFrameIndex, selected: app._getSelectedFigureIds().length }))).toEqual({ frame: 0, selected: 1 });

  // Path off, or nothing selected, hides it.
  await page.getByRole('button', { name: 'Path' }).click();
  expect(blank(await rootPoint(page, 3))).toBe(true);
  await page.getByRole('button', { name: 'Path' }).click();
  expect(blue(await rootPoint(page, 3))).toBe(true);
  await page.keyboard.press('Escape');
  expect(blank(await rootPoint(page, 3))).toBe(true);
});

test('dragging a path dot moves the figure in that frame, as one Undo step', async ({ page }) => {
  await openEditor(page);
  await arcProject(page);
  const dot = await rootPoint(page, 3);
  await page.mouse.move(dot.clientX, dot.clientY);
  await page.mouse.down();
  await page.mouse.move(dot.clientX + 30, dot.clientY + 20, { steps: 5 });
  await page.mouse.up();
  const moved = await page.evaluate(() => ({ frame: app.currentFrameIndex, x: app.frames[3][0].x, y: app.frames[3][0].y, here: app.frames[2][0].x }));
  expect(moved.frame).toBe(2); // a drag stays on this frame
  expect(moved.x).toBeCloseTo(dot.x + 30 * dot.k, 0);
  expect(moved.y).toBeCloseTo(dot.y + 20 * dot.k, 0);
  expect(moved.here).toBe(400); // the current frame is untouched
  await page.evaluate(() => app.undo());
  expect(await page.evaluate(() => [app.frames[3][0].x, app.frames[3][0].y])).toEqual([500, 220]);
});

test('the path keeps its size on screen at any zoom', async ({ page }) => {
  await openEditor(page);
  await arcProject(page);
  const atZoom = async zoom => { await page.evaluate(zoom => { app.zoomLevel = zoom; app.updateCanvasLayout(); app.render(); }, zoom); return rootPoint(page, 3); };
  for (const zoom of [0.5, 1, 2]) {
    const point = await atZoom(zoom);
    expect(point.k).toBeCloseTo(1 / zoom, 2);
    expect(blue(point), `rim at zoom ${zoom}`).toBe(true);
  }
});

test('D duplicates the frame, A adds one, and the arrow keys step through frames', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 2);
  await page.locator('#main-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('d');
  expect(await page.evaluate(() => ({ count: app.frames.length, frame: app.currentFrameIndex, same: app.frames[1][0].x === app.frames[0][0].x }))).toEqual({ count: 3, frame: 1, same: true });
  await page.keyboard.press('a');
  expect(await page.evaluate(() => ({ count: app.frames.length, frame: app.currentFrameIndex }))).toEqual({ count: 4, frame: 2 });
  await page.keyboard.press('ArrowLeft');
  expect(await frameIndex(page)).toBe(1);
  await page.keyboard.press('ArrowRight');
  expect(await frameIndex(page)).toBe(2);
  // Typing in the project name never adds or duplicates frames.
  await page.locator('#project-name').fill('Dad');
  await page.locator('#project-name').press('a');
  expect(await page.evaluate(() => app.frames.length)).toBe(4);
  // While playing, the keys do nothing.
  await page.locator('#main-canvas').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => app.play());
  await page.keyboard.press('d');
  expect(await page.evaluate(() => { const count = app.frames.length; app.stop(); return count; })).toBe(4);
});

test('copied frames paste after the current frame as one Undo step, keeping each figure for tweening', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 4);
  await expect(page.getByRole('button', { name: 'Paste frames' })).toBeDisabled();
  await page.locator('.frame-thumb').nth(1).click();
  await page.locator('.frame-thumb').nth(2).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Copy frames' }).click();
  await expect(page.locator('#sm-toast')).toContainText('Copied 2 frames');
  await page.locator('.frame-thumb').nth(3).click();
  await page.getByRole('button', { name: 'Paste frames' }).click();
  await expect(page.locator('#sm-toast')).toContainText('Pasted 2 frames as frames 5–6');
  const after = await page.evaluate(() => ({
    xs: app.frames.map(frame => Math.round(frame[0].x)),
    sameFigure: new Set(app.frames.map(frame => frame[0].id)).size === 1,
    current: app.currentFrameIndex, selected: [...app.selectedFrames].sort()
  }));
  expect(after).toEqual({ xs: [400, 430, 460, 490, 430, 460], sameFigure: true, current: 4, selected: [4, 5] });
  // Pasted frames are copies: changing one leaves the originals alone.
  await page.evaluate(() => { app.frames[4][0].x = 999; });
  expect(await page.evaluate(() => app.frames[1][0].x)).toBe(430);
  await page.evaluate(() => app.undo());
  expect(await page.evaluate(() => app.frames.length)).toBe(4);
});

test('frames pasted into another project drop groups that project does not have', async ({ page }) => {
  await openEditor(page);
  const groupIds = await page.evaluate(() => {
    app.newProject(); app.addFigure();
    app.selectedFigureIds = new Set(app.figures.map(figure => figure.id)); app.groupSelected();
    app.copyFrames();
    app.newProject(); app.pasteFrames();
    return app.frames[1].map(figure => figure.groupId);
  });
  expect(groupIds).toEqual([null, null]);
});

test('the playback bar never overlaps or cuts off a button, from phone to wide screens', async ({ page }) => {
  await openEditor(page);
  for (const width of [1920, 1440, 1366, 1280, 1100, 1024, 900, 800, 700]) {
    await page.setViewportSize({ width, height: 800 });
    const fit = await page.evaluate(() => {
      const bar = document.getElementById('playback-bar'), box = bar.getBoundingClientRect();
      const [left, centre, right] = ['frame-counter-wrap', 'pb-center', 'pb-right'].map(id => document.getElementById(id).getBoundingClientRect());
      const buttons = [...bar.querySelectorAll('button')].filter(button => button.offsetParent);
      const scrolls = bar.scrollWidth > bar.clientWidth + 1;
      return {
        overlap: left.right > centre.left + 1 || centre.right > right.left + 1,
        cutOff: !scrolls && buttons.some(button => { const b = button.getBoundingClientRect(); return b.left < box.left - 1 || b.right > box.right + 1; }),
        wrapped: buttons.some(button => button.getBoundingClientRect().height > 40)
      };
    });
    expect(fit, `${width}px wide`).toEqual({ overlap: false, cutOff: false, wrapped: false });
  }
});

test('Hold this frame steps through clear lengths from any value, one Undo at a time', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 2);
  await page.evaluate(() => { if (app.isSmooth) app.toggleSmooth(); }); // with Smooth on it reads as a move's speed (easing.spec.js)
  const hold = () => page.evaluate(() => ({ delay: app.frameDelays[app.currentFrameIndex], label: document.getElementById('duration-display').textContent, slider: Number(document.getElementById('frame-duration').value) }));
  await expect(page.locator('#duration-display')).toHaveText('1× normal');
  await page.evaluate(() => app.setFrameDuration(1.3)); // an in-between value from the slider, or an older project
  await page.getByRole('button', { name: 'Show this frame for longer' }).click();
  expect(await hold()).toEqual({ delay: 1.5, label: '1.5× longer', slider: 1.5 });
  await page.getByRole('button', { name: 'Show this frame for longer' }).click();
  expect(await hold()).toEqual({ delay: 2, label: '2× longer', slider: 2 });
  await expect(page.locator('.frame-thumb').nth(0).locator('.frame-delay')).toHaveText('2.0×');
  await page.evaluate(() => app.undo());
  expect(await hold()).toEqual({ delay: 1.5, label: '1.5× longer', slider: 1.5 });
  for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Show this frame for less time' }).click();
  expect(await hold()).toEqual({ delay: 0.2, label: '0.2× shorter', slider: 0.2 }); // 1.5 → 1 → 0.5 → 0.2
  await page.getByRole('button', { name: 'Show this frame for less time' }).click();
  await page.getByRole('button', { name: 'Show this frame for less time' }).click();
  expect((await hold()).delay).toBe(0.1); // the shortest; another step does nothing
});

test('tools show their names where the screen is tall enough, and hover tips where it is not', async ({ page }) => {
  await openEditor(page);
  const stickman = () => page.evaluate(() => { const style = getComputedStyle(document.getElementById('tool-stick'), '::after'); return { content: style.content, opacity: style.opacity, position: style.position }; });
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(await stickman()).toEqual({ content: '"Stickman"', opacity: '1', position: 'static' });
  await page.setViewportSize({ width: 1280, height: 650 });
  // The hover tip, once its 0.15 s fade has run.
  await expect.poll(stickman).toEqual({ content: '"Add Stickman"', opacity: '0', position: 'absolute' });
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

test('Delete on a clicked frame removes that frame; Backspace there does nothing; figures still delete as before', async ({ page }) => {
  await openEditor(page);
  await framesProject(page, 4);
  await page.locator('.frame-thumb').nth(1).click();
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => ({ frames: app.frames.length, figures: app.figures.length }))).toEqual({ frames: 4, figures: 1 });
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => app.frames.map(frame => Math.round(frame[0].x)))).toEqual([400, 460, 490]);
  // Focus moves to the frame now in its place, so Delete can be pressed again.
  await expect(page.locator('.frame-thumb').nth(1)).toBeFocused();
  await page.evaluate(() => app.undo());
  expect(await page.evaluate(() => app.frames.length)).toBe(4);
  // Picked frames go together.
  await page.locator('.frame-thumb').nth(1).click();
  await page.locator('.frame-thumb').nth(2).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => app.frames.length)).toBe(2);
  // On the stage, Delete still removes the selected figure, not the frame.
  await page.evaluate(() => { app.selectFigure(app.figures[0]); document.activeElement?.blur(); });
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => ({ frames: app.frames.length, figures: app.figures.length }))).toEqual({ frames: 2, figures: 0 });
});

test('the top bar fits without cutting anything off, down to the compact layout', async ({ page }) => {
  await openEditor(page);
  for (const width of [1366, 1100, 1000, 900, 820, 781]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => {
      const bar = document.getElementById('topbar'), right = bar.getBoundingClientRect().right;
      return Math.max(...[...bar.children].filter(child => child.offsetParent).map(child => child.getBoundingClientRect().right)) - right;
    });
    expect(overflow, `${width}px wide`).toBeLessThanOrEqual(0);
  }
  // Folded buttons keep their names.
  await page.setViewportSize({ width: 820, height: 800 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});
