import { expect, test } from '@playwright/test';

async function openEditor(page) {
  await page.goto('/index.html');
  await expect(page.locator('#main-canvas')).toBeVisible();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

async function viewportMetrics(page) {
  return page.evaluate(() => {
    const area = document.getElementById('canvas-area');
    const canvas = document.getElementById('main-canvas');
    const areaRect = area.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const centerX = areaRect.left + area.clientWidth / 2;
    const centerY = areaRect.top + area.clientHeight / 2;
    return {
      zoom: app.zoomLevel,
      documentPoint: {
        x: (centerX - canvasRect.left) * (canvas.width / canvasRect.width) - app.stagePadding,
        y: (centerY - canvasRect.top) * (canvas.height / canvasRect.height) - app.stagePadding
      },
      area: { left: areaRect.left, top: areaRect.top, width: area.clientWidth, height: area.clientHeight },
      canvas: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height },
      scroll: { left: area.scrollLeft, top: area.scrollTop, maxLeft: area.scrollWidth - area.clientWidth, maxTop: area.scrollHeight - area.clientHeight }
    };
  });
}

test('zoom buttons preserve a panned viewport anchor and project data', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await openEditor(page);
  await page.evaluate(() => {
    app.applyCanvasSize(1200, 700);
    app.render();
    app.centerStage();
    const area = document.getElementById('canvas-area');
    area.scrollLeft = area.scrollWidth * 0.37;
    area.scrollTop = area.scrollHeight * 0.29;
  });

  const before = await viewportMetrics(page);
  const projectBefore = await page.evaluate(() => JSON.stringify(app.serializeProject()));
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await viewportMetrics(page);
  expect(zoomed.zoom).toBeCloseTo(1.1, 6);
  expect(Math.abs(zoomed.documentPoint.x - before.documentPoint.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(zoomed.documentPoint.y - before.documentPoint.y)).toBeLessThanOrEqual(1.5);
  expect(await page.evaluate(() => JSON.stringify(app.serializeProject()))).toBe(projectBefore);

  await page.getByRole('button', { name: 'Zoom out' }).click();
  const roundTrip = await viewportMetrics(page);
  expect(roundTrip.zoom).toBeCloseTo(1, 6);
  expect(Math.abs(roundTrip.documentPoint.x - before.documentPoint.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(roundTrip.documentPoint.y - before.documentPoint.y)).toBeLessThanOrEqual(1.5);
  expect(await page.evaluate(() => JSON.stringify(app.serializeProject()))).toBe(projectBefore);
});

test('initial, new, and opened projects centre their document', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await openEditor(page);
  const initial = await viewportMetrics(page);
  expect(Math.abs(initial.documentPoint.x - 400)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(initial.documentPoint.y - 250)).toBeLessThanOrEqual(1.5);
  await page.evaluate(() => app.newProject());
  const fresh = await viewportMetrics(page);
  expect(Math.abs(fresh.documentPoint.x - 400)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(fresh.documentPoint.y - 250)).toBeLessThanOrEqual(1.5);
  await page.evaluate(() => app.applyProjectData({
    name: 'Opened dimensions', width: 1200, height: 700, fps: 12,
    frames: [[]], delays: [1], currentFrameIndex: 0, groups: [], settings: {}
  }));
  const opened = await viewportMetrics(page);
  expect(Math.abs(opened.documentPoint.x - 600)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(opened.documentPoint.y - 350)).toBeLessThanOrEqual(1.5);
});

test('fit stage centres and contains a non-default document', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 720 });
  await openEditor(page);
  await page.evaluate(() => { app.applyCanvasSize(1200, 700); app.render(); });
  await page.getByRole('button', { name: 'Fit stage to workspace' }).click();
  const metrics = await viewportMetrics(page);
  expect(Math.abs(metrics.documentPoint.x - 600)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(metrics.documentPoint.y - 350)).toBeLessThanOrEqual(1.5);
  const contained = await page.evaluate(() => {
    const area = document.getElementById('canvas-area');
    const canvas = document.getElementById('main-canvas');
    const ar = area.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const scaleX = cr.width / canvas.width, scaleY = cr.height / canvas.height;
    return {
      left: cr.left + app.stagePadding * scaleX - ar.left,
      top: cr.top + app.stagePadding * scaleY - ar.top,
      right: cr.left + (app.stagePadding + app.docWidth) * scaleX - ar.left,
      bottom: cr.top + (app.stagePadding + app.docHeight) * scaleY - ar.top,
      width: area.clientWidth,
      height: area.clientHeight
    };
  });
  expect(contained.left).toBeGreaterThanOrEqual(-0.5);
  expect(contained.top).toBeGreaterThanOrEqual(-0.5);
  expect(contained.right).toBeLessThanOrEqual(contained.width + 0.5);
  expect(contained.bottom).toBeLessThanOrEqual(contained.height + 0.5);
});

test('middle-button pan works and zoom controls stay fixed and reachable', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await openEditor(page);
  await page.evaluate(() => { app.setZoom(5, false); app.centerStage(); });
  const areaBox = await page.locator('#canvas-area').boundingBox();
  const start = { x: areaBox.x + areaBox.width / 2, y: areaBox.y + areaBox.height / 2 };
  const beforePan = await viewportMetrics(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(start.x - 80, start.y - 55);
  await page.mouse.up({ button: 'middle' });
  const afterPan = await viewportMetrics(page);
  expect(afterPan.scroll.left).toBeGreaterThan(beforePan.scroll.left);
  expect(afterPan.scroll.top).toBeGreaterThan(beforePan.scroll.top);

  const pillBefore = await page.locator('#zoom-pill').boundingBox();
  await page.evaluate(() => {
    const area = document.getElementById('canvas-area');
    area.scrollLeft = area.scrollWidth;
    area.scrollTop = area.scrollHeight;
  });
  const pillAfter = await page.locator('#zoom-pill').boundingBox();
  expect(pillAfter).toEqual(pillBefore);
  expect(pillAfter.x).toBeGreaterThanOrEqual(0);
  expect(pillAfter.y).toBeGreaterThanOrEqual(0);
  expect(pillAfter.x + pillAfter.width).toBeLessThanOrEqual(560);
  expect(pillAfter.y + pillAfter.height).toBeLessThanOrEqual(800);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
});
