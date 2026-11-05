import { expect, test } from '@playwright/test';

async function openEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

// A fresh project whose figure stands at each x in turn, Smooth on, Loop off, frame 1 showing.
async function movesProject(page, xs) {
  await page.evaluate(xs => {
    app.newProject();
    if (!app.isSmooth) app.toggleSmooth();
    if (app.isLooping) app.toggleLoop();
    xs.forEach((x, i) => {
      if (i) app.addFrame();
      app.figures[0].x = x;
      app.frames[app.currentFrameIndex] = app.figures.map(figure => figure.clone());
    });
    app.loadFrame(0, false);
  }, xs);
}

// Where Smooth puts the figure part way through frame `index`'s move; the stage is put back afterwards.
const xPartWay = (page, index, t) => page.evaluate(({ index, t }) => {
  app.renderInterpolated(app.frames[index], app.frames[index + 1], t, false);
  const x = app.figures[0].x;
  app.loadFrame(app.currentFrameIndex, false);
  return x;
}, { index, t });

const panel = page => page.evaluate(() => ({
  title: document.getElementById('frame-timing-label').textContent,
  label: document.getElementById('duration-display').textContent,
  easing: !document.getElementById('frame-ease').hidden
}));

test('with Smooth on, a frame\'s timing reads as its move to the next frame; without Smooth, as a hold', async ({ page }) => {
  await openEditor(page);
  await movesProject(page, [100, 300, 500]);
  expect(await panel(page)).toEqual({ title: 'Move to next frame', label: 'Normal speed', easing: true });
  await page.getByRole('button', { name: 'Make this move slower' }).click();
  expect(await panel(page)).toEqual({ title: 'Move to next frame', label: '1.5× slower', easing: true });
  for (let i = 0; i < 2; i += 1) await page.getByRole('button', { name: 'Make this move faster' }).click();
  expect((await panel(page)).label).toBe('2× faster'); // 1.5 → 1 → 0.5
  await expect(page.locator('#hold-short-end')).toHaveText('Faster');

  // The last frame has no move unless Loop is on.
  await page.evaluate(() => app.loadFrame(2, false));
  expect(await panel(page)).toEqual({ title: 'Hold this frame', label: '1× normal', easing: false });
  await page.getByRole('button', { name: 'Loop' }).click();
  expect(await panel(page)).toEqual({ title: 'Move to next frame', label: 'Normal speed', easing: true });

  // Smooth off: the panel is just as before.
  await page.getByRole('button', { name: 'Smooth', exact: true }).click();
  expect(await panel(page)).toEqual({ title: 'Hold this frame', label: '1× normal', easing: false });
  await expect(page.locator('#hold-short-end')).toHaveText('Shorter');
});

test('each frame\'s easing shapes its own move, shows on its thumbnail, and is one Undo step', async ({ page }) => {
  await openEditor(page);
  await movesProject(page, [100, 300, 500]);
  expect(await xPartWay(page, 0, 0.5)).toBeCloseTo(200, 5);

  await page.getByRole('radio', { name: 'Slow down' }).click();
  await expect(page.getByRole('radio', { name: 'Slow down' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ease-hint')).toContainText('Slows to a stop');
  expect(await xPartWay(page, 0, 0.5)).toBeCloseTo(250, 5); // three quarters of the way at half time
  expect(await xPartWay(page, 1, 0.5)).toBeCloseTo(400, 5); // the next move is untouched
  expect(await xPartWay(page, 0, 0)).toBeCloseTo(100, 5);
  expect(await xPartWay(page, 0, 1)).toBeCloseTo(300, 5);
  await expect(page.locator('.frame-thumb').nth(0).locator('.frame-ease')).toHaveAttribute('aria-label', 'Slows down');
  await expect(page.locator('.frame-thumb').nth(1).locator('.frame-ease')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Speed up' }).click();
  expect(await xPartWay(page, 0, 0.5)).toBeCloseTo(150, 5);
  await page.getByRole('radio', { name: 'Both' }).click();
  expect(await xPartWay(page, 0, 0.25)).toBeCloseTo(125, 5);
  expect(await xPartWay(page, 0, 0.5)).toBeCloseTo(200, 5);

  // Choosing the easing it already has adds no Undo step; each change is one.
  await page.getByRole('radio', { name: 'Both' }).click();
  await page.evaluate(() => app.undo());
  expect(await page.evaluate(() => app.frameEases[0])).toBe('in');
  await expect(page.getByRole('radio', { name: 'Speed up' })).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => { app.undo(); app.undo(); });
  expect(await page.evaluate(() => app.frameEases[0])).toBe('even');
  await expect(page.locator('.frame-thumb').nth(0).locator('.frame-ease')).toHaveCount(0);

  // The badge only shows while Smooth is on, since only Smooth eases.
  await page.getByRole('radio', { name: 'Slow down' }).click();
  await page.getByRole('button', { name: 'Smooth', exact: true }).click();
  await expect(page.locator('.frame-thumb').nth(0).locator('.frame-ease')).toHaveCount(0);
  await page.getByRole('button', { name: 'Smooth', exact: true }).click();
  await expect(page.locator('.frame-thumb').nth(0).locator('.frame-ease')).toHaveCount(1);
});

test('easing stays with its frame through duplicate, move, copy, paste, delete, and save and reopen', async ({ page }) => {
  await openEditor(page);
  await movesProject(page, [100, 300, 500]);
  const eases = () => page.evaluate(() => ({ eases: [...app.frameEases], frames: app.frames.length }));
  await page.evaluate(() => { app.setFrameEase('out'); app.loadFrame(1, false); app.setFrameEase('in'); });
  expect(await eases()).toEqual({ eases: ['out', 'in', 'even'], frames: 3 });
  await page.evaluate(() => app.duplicateFrameAtIndex(1));
  expect(await eases()).toEqual({ eases: ['out', 'in', 'in', 'even'], frames: 4 });
  await page.evaluate(() => { app.loadFrame(0, false); app.moveFrame(1); });
  expect(await eases()).toEqual({ eases: ['in', 'out', 'in', 'even'], frames: 4 });
  await page.evaluate(() => { app.copyFrames(); app.loadFrame(3, false); app.pasteFrames(); });
  expect(await eases()).toEqual({ eases: ['in', 'out', 'in', 'even', 'out'], frames: 5 });
  await page.evaluate(() => app.deleteFrameAtIndex(0));
  expect(await eases()).toEqual({ eases: ['out', 'in', 'even', 'out'], frames: 4 });

  const reopened = await page.evaluate(() => {
    const saved = JSON.parse(JSON.stringify(app.serializeProject()));
    app.newProject();
    app.applyProjectData(saved);
    return { saved: saved.eases, eases: [...app.frameEases] };
  });
  expect(reopened).toEqual({ saved: ['out', 'in', 'even', 'out'], eases: ['out', 'in', 'even', 'out'] });
});

test('a new or reopened project starts with the path off, as in SketchMotion', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => app.newProject());
  await expect(page.getByRole('button', { name: 'Path' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Path' }).click();
  expect(await page.evaluate(() => app.showPath)).toBe(true);
  // Projects saved while the path started on (nearly all of them) open without it too.
  const reopened = await page.evaluate(() => { const saved = JSON.parse(JSON.stringify(app.serializeProject())); app.applyProjectData(saved); return { saved: saved.settings.showPath, now: app.showPath }; });
  expect(reopened).toEqual({ saved: true, now: false });
  await expect(page.getByRole('button', { name: 'Path' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Path' }).click();
  await page.evaluate(() => app.newProject());
  expect(await page.evaluate(() => app.showPath)).toBe(false);
});

test('turning on Path says why when there is no path to draw', async ({ page }) => {
  await openEditor(page);
  const toast = page.locator('#sm-toast');
  const pathOn = async () => {
    await page.evaluate(() => { if (app.showPath) app.togglePath(); document.getElementById('sm-toast')?.remove(); });
    await page.getByRole('button', { name: 'Path' }).click();
  };
  await page.evaluate(() => { app.newProject(); app.selectFigure(app.figures[0]); app.render(); });
  await pathOn();
  await expect(toast).toHaveText('Add another frame to see a path.');

  await page.evaluate(() => { app.addFrame(); app.selectedFigureIds.clear(); app.figures.forEach(f => { f.selected = false; }); app.render(); });
  await pathOn();
  await expect(toast).toHaveText('Select a figure to see its path.');

  await page.evaluate(() => { app.selectFigure(app.figures[0]); app.render(); });
  await pathOn();
  await expect(toast).toHaveText('This figure is in the same place in every frame. Drag its orange root to move it.');

  // A figure that moves has a path, and no note.
  await page.evaluate(() => { app.figures[0].x += 100; app.frames[app.currentFrameIndex] = app.figures.map(f => f.clone()); app.render(); });
  await pathOn();
  await expect(toast).toHaveCount(0);
  expect(await page.evaluate(() => app.motionPaths().length)).toBe(1);

  // A figure added in this frame only has no other frame to connect to.
  await page.evaluate(() => { app.addFigure(); const added = app.figures[app.figures.length - 1]; app.selectedFigureIds.clear(); app.figures.forEach(f => { f.selected = false; }); app.selectFigure(added); app.render(); });
  await pathOn();
  await expect(toast).toHaveText('This figure is only in one frame, so it has no path yet.');
});
