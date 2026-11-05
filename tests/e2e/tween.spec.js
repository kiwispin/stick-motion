import { expect, test } from '@playwright/test';

async function openEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

// Two frames: the stick figure, then the same figure with both arms swung 120° about the shoulders,
// moved right and made bigger.
async function swingProject(page) {
  await page.evaluate(() => {
    app.newProject();
    app.frames[0] = [app.figures[0].clone()];
    app.addFrame();
    const figure = app.figures[0];
    app.rotateHierarchy(figure, 'lShldr', -2.1); app.rotateHierarchy(figure, 'rShldr', 2.1);
    figure.x += 100; figure.scale = 1.5;
    app.frames[1] = app.figures.map(f => f.clone());
  });
}

// The tweened figure at t: its root, scale, and each arm's shoulder-to-hand reach relative to its scale.
const tweenAt = (page, t) => page.evaluate(t => {
  app.renderInterpolated(app.frames[0], app.frames[1], t, false);
  const figure = app.figures[0], joint = id => figure.joints.find(j => j.id === id);
  const reach = side => Math.hypot(joint(`${side}Hand`).x - joint(`${side}Shldr`).x, joint(`${side}Hand`).y - joint(`${side}Shldr`).y) / figure.scale;
  return { x: figure.x, scale: figure.scale, left: reach('l'), right: reach('r') };
}, t);

test('Smooth keeps every limb its length through a turn, and moves and scales the figure evenly', async ({ page }) => {
  await openEditor(page);
  await swingProject(page);
  const start = await tweenAt(page, 0);
  for (const t of [0.25, 0.5, 0.75]) {
    const step = await tweenAt(page, t);
    expect(Math.abs(step.left - start.left) / start.left, `left arm at ${t}`).toBeLessThan(0.001);
    expect(Math.abs(step.right - start.right) / start.right, `right arm at ${t}`).toBeLessThan(0.001);
    expect(step.x).toBeCloseTo(start.x + 100 * t, 6);
    expect(step.scale).toBeCloseTo(1 + 0.5 * t, 6);
  }
});

test('the first and last in-between poses are exactly the two frames', async ({ page }) => {
  await openEditor(page);
  await swingProject(page);
  const gap = await page.evaluate(() => {
    const positions = figure => { figure.updatePositions(); return figure.joints.map(j => [j.x, j.y]); };
    const worst = (t, frame) => {
      app.renderInterpolated(app.frames[0], app.frames[1], t, false);
      const got = positions(app.figures[0]), want = positions(app.frames[frame][0].clone());
      return Math.max(...got.map(([x, y], i) => Math.hypot(x - want[i][0], y - want[i][1])));
    };
    return { start: worst(0, 0), end: worst(1, 1) };
  });
  expect(gap.start).toBeLessThan(1e-9);
  expect(gap.end).toBeLessThan(1e-9);
});

test('a joint turns the shorter way round, even across the half-turn mark', async ({ page }) => {
  await openEditor(page);
  const angle = await page.evaluate(() => {
    app.newProject();
    const figure = app.figures[0], hand = () => figure.joints.find(j => j.id === 'lHand');
    hand().angle = 3.0; app.frames[0] = [figure.clone()];
    hand().angle = -3.0; app.frames[1] = [figure.clone()];
    app.renderInterpolated(app.frames[0], app.frames[1], 0.5, false);
    return app.figures[0].joints.find(j => j.id === 'lHand').angle;
  });
  // From 3.0 to -3.0 rad is 0.28 rad the short way, past π; the long way would pass through 0.
  expect(Math.cos(angle)).toBeLessThan(-0.99);
});

// A jump made of five poses: rising, peak, falling.
async function jumpProject(page) {
  await page.evaluate(() => {
    app.newProject();
    [[100, 300], [200, 200], [300, 150], [400, 200], [500, 300]].forEach(([x, y], i) => {
      if (i) app.addFrame();
      app.figures[0].x = x; app.figures[0].y = y;
      app.frames[app.currentFrameIndex] = app.figures.map(figure => figure.clone());
    });
    app.loadFrame(0, false);
  });
}
const rootBetween = (page, from, t) => page.evaluate(({ from, t }) => {
  app.renderInterpolated(app.frames[from], app.frames[from + 1], t, false);
  const point = { x: app.figures[0].x, y: app.figures[0].y };
  app.loadFrame(app.currentFrameIndex, false); // put the frame back on the stage, as stopping playback does
  return point;
}, { from, t });

test('Curved Smooth swings the figure through its poses on a curve; Straight stays the default', async ({ page }) => {
  await openEditor(page);
  await jumpProject(page);
  expect(await page.evaluate(() => app.motionCurve)).toBe('straight');
  expect(await rootBetween(page, 1, 0.5)).toEqual({ x: 250, y: 175 }); // straight: the midpoint

  await page.locator('#btn-smooth-settings').click();
  await expect(page.locator('#smooth-menu')).toBeVisible();
  await page.getByRole('radio', { name: 'Curved' }).click();
  await expect(page.getByRole('radio', { name: 'Curved' })).toHaveAttribute('aria-checked', 'true');
  const curved = await rootBetween(page, 1, 0.5);
  expect(curved.x).toBeCloseTo(250, 6);
  expect(curved.y).toBeLessThan(170); // above the straight line, on the arc
  // Each pose is still reached exactly.
  expect(await rootBetween(page, 1, 1)).toEqual({ x: 300, y: 150 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#smooth-menu')).toBeHidden();
  await expect(page.locator('#btn-smooth-settings')).toBeFocused();

  // Saved with the project.
  await page.evaluate(() => app.localSaveQueue);
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  expect(await page.evaluate(() => app.motionCurve)).toBe('curved');
});

test('Curved treats the first and last frames as ends, and curves the loop back to the start', async ({ page }) => {
  await openEditor(page);
  await jumpProject(page);
  await page.evaluate(() => app.setMotionCurve('curved'));
  // The first stretch starts on the line towards frame 2, with no hook back towards the last frame.
  const early = await rootBetween(page, 0, 0.1);
  expect(early.x).toBeGreaterThan(100);
  expect(early.y).toBeLessThan(300);
  // Looping from the last frame back to the first still tweens, and passes between them.
  const wrap = await page.evaluate(() => { app.renderInterpolated(app.frames[4], app.frames[0], 0.5, false); return app.figures[0].x; });
  expect(wrap).toBeGreaterThan(100);
  expect(wrap).toBeLessThan(500);
});
