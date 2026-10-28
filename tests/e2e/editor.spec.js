import { expect, test } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Tests that patch a module read it from disk rather than route.fetch(), so they never depend on the server under load.
const projectFile = (...parts) => path.join(path.dirname(test.info().config.configFile), ...parts);

async function openEditor(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto('/index.html');
    await expect(page.locator('#main-canvas')).toBeVisible();
    try {
      await page.waitForFunction(() => window.app?.frames?.length > 0, null, { timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

test('starts with a usable first frame and persists the active pose after reload', async ({ page }) => {
  await openEditor(page);
  await expect(page.locator('#frame-counter')).toContainText('Frame 1 of 1');

  await page.evaluate(() => {
    app.newProject();
    app.figures[0].x = 123;
    app.figures[0].y = 234;
    app.render();
    app.saveLocal();
  });
  await expect(page.locator('#storage-status')).toHaveText('Saved');
  await page.reload();
  await expect(page.locator('#main-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({ x: app.figures[0].x, y: app.figures[0].y }))).toEqual({ x: 123, y: 234 });
});

test('names and recovers the latest local project after reload', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { app.newProject(); app.setProjectName('Rocket rehearsal'); });
  await expect(page.locator('#storage-status')).toHaveText('Saved');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveValue('Rocket rehearsal');
  await expect(page.locator('#storage-status')).toHaveText('Recovered draft');
  await expect(page.locator('#storage-indicator')).toHaveAttribute('title', /Choose New to start fresh/);
});

async function seedUnreadableDraft(page) {
  return page.evaluate(async () => {
    app.newProject(); app.setProjectName('Keep me'); app.saveLocal(); await app.localSaveQueue;
    const project = JSON.parse(JSON.stringify(app.serializeProject()));
    project.frames[0][0].scale = 0.001; // outside the range the loader accepts
    const payload = JSON.stringify(project);
    await window.reviewStore('put', 'current', payload);
    return payload;
  });
}

async function installStoreHelper(page) {
  await page.addInitScript(() => {
    window.reviewStore = (op, key, value) => new Promise((resolve, reject) => {
      const open = indexedDB.open('stickmotion', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('projects');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('projects', op === 'get' ? 'readonly' : 'readwrite');
        const request = op === 'get' ? tx.objectStore('projects').get(key) : tx.objectStore('projects').put(value, key);
        tx.oncomplete = () => { open.result.close(); resolve(request.result); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

test('an autosave that cannot be reopened is kept as a backup instead of being overwritten', async ({ page }) => {
  await installStoreHelper(page);
  await openEditor(page);
  const original = await seedUnreadableDraft(page);

  await openEditor(page);
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText("Your last project couldn't be reopened");
  await expect.poll(() => page.evaluate(() => window.reviewStore('get', 'unreadable-backup'))).toBe(original);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('stickmotion-unreadable-backup.json');
  const saved = await stat(await download.path());
  expect(saved.size).toBe(Buffer.byteLength(original));
});

test('autosave pauses rather than overwrite an unreadable draft it could not back up', async ({ page }) => {
  await page.route('**/src/storage.js', async route => {
    let source = await readFile(projectFile('src', 'storage.js'), 'utf8');
    source = source.replace('export function writeUnreadableBackup(', 'function originalWriteUnreadableBackup(');
    source += '\nexport function writeUnreadableBackup() { return Promise.reject(new Error("Reviewer simulated backup failure")); }\n';
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: source });
  });
  await installStoreHelper(page);
  await openEditor(page);
  const original = await seedUnreadableDraft(page);

  await openEditor(page);
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#storage-status')).toHaveText('Autosave paused');
  await page.evaluate(async () => { app.figures[0].x += 50; app.saveLocal(); await app.localSaveQueue; });
  expect(await page.evaluate(() => window.reviewStore('get', 'current'))).toBe(original);
});

test('opening a project file asks before replacing the current animation', async ({ page }) => {
  await openEditor(page);
  const project = await page.evaluate(() => {
    app.newProject(); app.setProjectName('Current work'); app.figures[0].x = 111; app.saveLocal();
    const incoming = JSON.parse(JSON.stringify(app.serializeProject()));
    incoming.name = 'Incoming project'; incoming.frames[0][0].x = 222;
    return incoming;
  });
  const current = () => page.evaluate(() => ({ name: app.projectName, x: app.frames[0][0].x }));
  const choose = () => page.locator('#load-input').setInputFiles({ name: 'incoming.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });

  await choose();
  await expect(page.locator('#confirm-title')).toHaveText('Open project?');
  await expect(page.locator('#confirm-msg')).toContainText('"Incoming project" replaces "Current work"');
  await page.locator('#confirm-cancel').click();
  expect(await current()).toEqual({ name: 'Current work', x: 111 });

  await choose();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#sm-toast')).toContainText('Opened Incoming project');
  expect(await current()).toEqual({ name: 'Incoming project', x: 222 });
});

test('only the newest tab autosaves, so an older tab cannot overwrite newer work', async ({ context }) => {
  const older = await context.newPage();
  await openEditor(older);
  await older.evaluate(async () => { app.newProject(); app.setProjectName('Shared work'); app.figures[0].x = 111; app.saveLocal(); await app.localSaveQueue; });

  const newer = await context.newPage();
  await openEditor(newer);
  await expect(newer.locator('#project-name')).toHaveValue('Shared work');
  await expect(older.locator('#confirm-title')).toHaveText('StickMotion is open in another tab');
  await expect(older.locator('#storage-status')).toHaveText('Autosave paused');

  await newer.evaluate(async () => { app.figures[0].x = 333; app.saveLocal(); await app.localSaveQueue; });
  await older.evaluate(async () => { app.figures[0].x = 999; app.saveLocal(); await app.localSaveQueue; });

  await Promise.all([older.waitForEvent('load'), older.locator('#confirm-ok').click()]); // "Use this tab"
  await older.waitForFunction(() => window.app?.frames?.length > 0);
  expect(await older.evaluate(() => app.frames[0][0].x)).toBe(333);
  await expect(newer.locator('#confirm-title')).toHaveText('StickMotion is open in another tab');
  await expect(newer.locator('#storage-status')).toHaveText('Autosave paused');
});

test('reports Saving until the latest queued autosave settles', async ({ page }) => {
  await page.route('**/src/storage.js', async route => {
    let source = await readFile(projectFile('src', 'storage.js'), 'utf8');
    source = source.replace('export function writeStoredProject(', 'function originalWriteStoredProject(');
    source += '\nexport function writeStoredProject(payload) { if (window.reviewFailWrites) return Promise.reject(new Error("Reviewer simulated storage failure")); if (!window.reviewHoldWrites) return originalWriteStoredProject(payload); return new Promise((resolve, reject) => { window.reviewWriteGates.push(() => originalWriteStoredProject(payload).then(resolve, reject)); }); }\n';
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: source });
  });
  await openEditor(page);

  const immediate = await page.evaluate(async () => {
    app.closeWelcome();
    await app.localSaveQueue;
    window.reviewWriteGates = [];
    window.reviewHoldWrites = true;
    app.newProject();
    app.setProjectName('Latest queued name');
    app.figures[0].x = 222;
    app.saveLocal();
    return { status: document.getElementById('storage-status').textContent, running: app.localSaveRunning, pending: app.pendingLocalSave !== null };
  });
  expect(immediate).toEqual({ status: 'Saving', running: true, pending: true });
  await page.evaluate(() => window.reviewWriteGates.shift()());
  await page.waitForFunction(() => window.reviewWriteGates.length === 1);
  await expect(page.locator('#storage-status')).toHaveText('Saving');
  await page.evaluate(async () => {
    window.reviewHoldWrites = false;
    window.reviewWriteGates.shift()();
    await app.localSaveQueue;
  });
  await expect(page.locator('#storage-status')).toHaveText('Saved');
  const persisted = await page.evaluate(async () => JSON.parse(await (await import('./src/storage.js')).readStoredProject()));
  expect(persisted.name).toBe('Latest queued name');
  expect(persisted.frames[0][0].x).toBe(222);

  await page.evaluate(async () => {
    window.reviewFailWrites = true;
    app.setProjectName('Failed write');
    await app.localSaveQueue;
  });
  await expect(page.locator('#storage-status')).toHaveText('Save failed');
  await page.evaluate(async () => {
    window.reviewFailWrites = false;
    app.setProjectName('Retry success');
    await app.localSaveQueue;
  });
  await expect(page.locator('#storage-status')).toHaveText('Saved');

  await page.evaluate(() => {
    window.reviewHoldWrites = true;
    app.setProjectName('Older valid snapshot');
    const bad = {};
    bad.self = bad;
    app.backgroundData = bad;
    app.saveLocal();
  });
  await expect(page.locator('#storage-status')).toHaveText('Save failed');
  await page.evaluate(async () => {
    window.reviewHoldWrites = false;
    window.reviewWriteGates.shift()();
    await app.localSaveQueue;
  });
  await expect(page.locator('#storage-status')).toHaveText('Save failed');
  await page.evaluate(async () => {
    app.backgroundData = null;
    app.setProjectName('Recovered after serialization error');
    await app.localSaveQueue;
  });
  await expect(page.locator('#storage-status')).toHaveText('Saved');
});

test('background image button clears only the background and can set it again', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(async () => {
    app.newProject();
    app.figures[0].x = 123;
    app.addFrame();
    app.figures[0].x = 234;
    await app.saveLocal();
  });
  const before = await page.evaluate(() => {
    const project = app.serializeProject();
    project.backgroundData = null;
    return JSON.parse(JSON.stringify(project, (_key, value) => typeof value === 'number' ? Number(value.toPrecision(15)) : value));
  });
  const backgroundData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ef4444'; context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png');
  });

  await page.getByRole('button', { name: 'Open settings' }).click();
  const toggle = page.locator('#bg-toggle-button');
  await expect(toggle).toHaveAttribute('aria-label', 'Set Background Image');
  await page.evaluate(data => {
    window.reviewOriginalImage = window.Image;
    window.reviewPendingBackgroundImage = null;
    window.Image = function DelayedImage() { window.reviewPendingBackgroundImage = this; };
    app.restoreBackground(data);
  }, backgroundData);
  await expect(toggle).toHaveAttribute('aria-label', 'Clear Background Image');
  await toggle.click();
  await page.evaluate(() => {
    window.reviewPendingBackgroundImage.onload();
    window.Image = window.reviewOriginalImage;
    delete window.reviewOriginalImage;
    delete window.reviewPendingBackgroundImage;
  });
  await expect(toggle).toHaveAttribute('aria-label', 'Set Background Image');
  await page.locator('#bg-input').setInputFiles({
    name: 'tiny-red.png',
    mimeType: 'image/png',
    buffer: Buffer.from(backgroundData.split(',')[1], 'base64')
  });
  await expect(toggle).toHaveAttribute('aria-label', 'Clear Background Image');
  const withBackground = await page.evaluate(() => Array.from(app.renderFrameToCtx(false, false).getContext('2d').getImageData(0, 0, 1, 1).data));
  expect(withBackground).toEqual([239, 68, 68, 255]);

  await page.evaluate(async () => { await app.saveLocal(); });
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length === 2);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.locator('#bg-toggle-button')).toHaveAttribute('aria-label', 'Clear Background Image');

  await page.locator('#bg-toggle-button').click();
  await expect(page.locator('#bg-toggle-button')).toHaveAttribute('aria-label', 'Set Background Image');
  const afterClear = await page.evaluate(() => {
    const project = app.serializeProject();
    project.backgroundData = null;
    const stableProject = JSON.parse(JSON.stringify(project, (_key, value) => typeof value === 'number' ? Number(value.toPrecision(15)) : value));
    return {
      project: stableProject,
      backgroundData: app.backgroundData,
      bgImage: app.bgImage,
      pixel: Array.from(app.renderFrameToCtx(false, false).getContext('2d').getImageData(0, 0, 1, 1).data)
    };
  });
  expect(afterClear.project).toEqual(before);
  expect(afterClear.backgroundData).toBeNull();
  expect(afterClear.bgImage).toBeNull();
  expect(afterClear.pixel).toEqual([255, 255, 255, 255]);

  await page.locator('#bg-input').setInputFiles({
    name: 'tiny-red-again.png',
    mimeType: 'image/png',
    buffer: Buffer.from(backgroundData.split(',')[1], 'base64')
  });
  await expect(toggle).toHaveAttribute('aria-label', 'Clear Background Image');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Set Background Image');
  await page.evaluate(async () => { await app.saveLocal(); });
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length === 2);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.locator('#bg-toggle-button')).toHaveAttribute('aria-label', 'Set Background Image');
  const afterReload = await page.evaluate(() => {
    const project = app.serializeProject();
    project.backgroundData = null;
    const stableProject = JSON.parse(JSON.stringify(project, (_key, value) => typeof value === 'number' ? Number(value.toPrecision(15)) : value));
    return { project: stableProject, backgroundData: app.backgroundData, bgImage: app.bgImage };
  });
  expect(afterReload.project).toEqual(before);
  expect(afterReload.backgroundData).toBeNull();
  expect(afterReload.bgImage).toBeNull();
  await page.evaluate(() => app.newProject());
  await expect(page.locator('#bg-toggle-button')).toHaveAttribute('aria-label', 'Set Background Image');
});

test('large local projects recover through IndexedDB autosave', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(async () => {
    app.newProject();
    const source = app.frames[0][0];
    app.frames = Array.from({ length: 580 }, (_, frameIndex) => Array.from({ length: 8 }, (_, figureIndex) => {
      const figure = source.clone();
      figure.id = `figure-${frameIndex}-${figureIndex}`;
      figure.x = 120 + figureIndex * 20;
      figure.y = 120 + (frameIndex % 20) * 10;
      return figure;
    }));
    app.frameDelays = Array(580).fill(1);
    app.currentFrameIndex = 579;
    app.figures = app.frames[579].map(figure => figure.clone());
    await app.saveLocal();
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => app.frames.length), { timeout: 30_000 }).toBe(580);
  await expect(page.locator('#storage-status')).toHaveText('Recovered draft');
});

test('allows spaces while typing a project name', async ({ page }) => {
  await openEditor(page);
  const projectName = page.locator('#project-name');
  await projectName.fill('Rocket');
  await projectName.press('Space');
  await expect(projectName).toHaveValue('Rocket ');
  await projectName.pressSequentially('rehearsal');
  await expect(projectName).toHaveValue('Rocket rehearsal');
  await projectName.press('Tab');
  await expect(projectName).toHaveValue('Rocket rehearsal');
});

test('help provides a repeatable student quick-start walkthrough', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Open help and shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Help & Shortcuts' })).toBeVisible();
  await page.getByRole('button', { name: 'Show quick start' }).click();
  const welcome = page.getByRole('dialog', { name: 'Welcome to StickMotion' });
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText('Press Space to add a frame');
  await page.getByRole('button', { name: 'Start animating' }).click();
  await expect(welcome).not.toBeVisible();
});

test('project handoff files use the student project name', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { app.newProject(); app.setProjectName('Rocket rehearsal'); });
  const projectDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await projectDownload).suggestedFilename()).toBe('rocket-rehearsal.json');
  await expect(page.locator('#sm-toast')).toContainText('Saved rocket-rehearsal.json');

  const frameDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Open export options' }).click();
  await page.getByRole('button', { name: 'Current frame PNG', exact: true }).click();
  expect((await frameDownload).suggestedFilename()).toBe('rocket-rehearsal-frame-001.png');
  await expect(page.locator('#sm-toast')).toContainText('Exported rocket-rehearsal-frame-001.png');
});

test('export menu provides GIF, WebM, PNG, and PNG ZIP downloads', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { app.newProject(); app.setProjectName('Export demo'); app.isSmooth=false; app.isLooping=false; app.fps=30; app.frameDelays=[3]; });

  await page.getByRole('button', { name: 'Open export options' }).click();
  for (const name of ['GIF animation', 'Video (WebM)', 'Current frame PNG', 'PNG frames ZIP']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Transparent PNG', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'SVG artwork', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#export-menu')).toBeHidden();

  let downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Open export options' }).click();
  await page.getByRole('button', { name: 'PNG frames ZIP', exact: true }).click();
  const zipDownload = await downloadPromise;
  expect(zipDownload.suggestedFilename()).toBe('export-demo-png-frames.zip');
  expect((await stat(await zipDownload.path())).size).toBeGreaterThan(100);

  downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Open export options' }).click();
  await page.getByRole('button', { name: 'Video (WebM)', exact: true }).click();
  const videoDownload = await downloadPromise;
  expect(videoDownload.suggestedFilename()).toBe('export-demo.webm');
  expect((await stat(await videoDownload.path())).size).toBeGreaterThan(100);
});

test('donkey library entry keeps a compact set of useful pivots through save and reload', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Open model library' }).click();
  await expect(page.getByRole('dialog', { name: 'Model Library' })).toContainText('Donkey');

  const result = await page.evaluate(async () => {
    app.newProject();
    app.figures = [];
    app.frames = [[]];
    app.frameDelays = [1];
    app.currentFrameIndex = 0;
    app.addFromLibrary('donkey');
    await app.saveLocal();
    const before = app.figures[0];
    const visible = before.joints.filter(joint => joint.handleVisible !== false).map(joint => joint.id);
    const hidden = before.joints.filter(joint => joint.handleVisible === false).map(joint => joint.id);
    const saved = JSON.parse(JSON.stringify(app.serializeProject()));
    app.applyProjectData(saved);
    const restored = app.figures[0];
    const byId = id => restored.joints.find(joint => joint.id === id);
    restored.updatePositions();
    const bodyBefore = { x: byId('belly').x, y: byId('belly').y };
    const pollBefore = { x: byId('poll').x, y: byId('poll').y };
    const muzzleBefore = { x: byId('muzzle').x, y: byId('muzzle').y };
    const earBefore = { x: byId('ear').x, y: byId('ear').y };
    const pose = (id, delta) => {
      byId(id).angle += delta;
      app.rotateHierarchy(restored, id, delta);
      restored.updatePositions();
    };
    pose('ear', 0.3);
    const afterEar = { ear: { x: byId('ear').x, y: byId('ear').y }, muzzle: { x: byId('muzzle').x, y: byId('muzzle').y } };
    pose('muzzle', -0.2);
    const afterMuzzle = { muzzle: { x: byId('muzzle').x, y: byId('muzzle').y }, poll: { x: byId('poll').x, y: byId('poll').y } };
    pose('poll', 0.2);
    const afterPoll = { poll: { x: byId('poll').x, y: byId('poll').y }, body: { x: byId('belly').x, y: byId('belly').y } };
    return {
      visible, hidden,
      restoredHidden: restored.joints.filter(joint => joint.handleVisible === false).map(joint => joint.id),
      bodyBefore, pollBefore, muzzleBefore, earBefore, afterEar, afterMuzzle, afterPoll
    };
  });

  expect(result.visible).toEqual(expect.arrayContaining(['root', 'belly', 'rump', 'tailTip', 'poll', 'muzzle', 'ear', 'farFrontKnee', 'farFrontFoot', 'farRearKnee', 'farRearFoot', 'nearFrontKnee', 'nearFrontFoot', 'nearRearKnee', 'nearRearFoot']));
  expect(result.hidden).toEqual(expect.arrayContaining(['tailBase', 'shoulder', 'noseBase', 'skull', 'earBase', 'eyeAnchor', 'eye']));
  expect(result.restoredHidden).toEqual(result.hidden);
  expect(result.afterEar.ear).not.toEqual(result.earBefore);
  expect(result.afterEar.muzzle).toEqual(result.muzzleBefore);
  expect(result.afterMuzzle.muzzle).not.toEqual(result.muzzleBefore);
  expect(result.afterMuzzle.poll).toEqual(result.pollBefore);
  expect(result.afterPoll.poll).not.toEqual(result.pollBefore);
  expect(result.afterPoll.body).toEqual(result.bodyBefore);
});

test('elephant library entry preserves the approved rig through save, reload, hierarchy posing, and cloning', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    app.newProject();
    app.figures = [];
    app.frames = [[]];
    app.frameDelays = [1];
    app.currentFrameIndex = 0;
    app.openLibrary();
  });
  const library = page.getByRole('dialog', { name: 'Model Library' });
  await expect(library).toContainText('Elephant');
  await library.getByRole('button', { name: /Elephant/ }).click();
  await page.evaluate(() => app.localSaveQueue);

  const beforeReload = await page.evaluate(() => {
    const figure = app.figures[0];
    const clone = figure.clone();
    const originalTrunk = figure.joints.find(joint => joint.id === 'trunkUpper');
    const clonedTrunk = clone.joints.find(joint => joint.id === 'trunkUpper');
    clonedTrunk.angle += 0.4;
    const byId = id => figure.joints.find(joint => joint.id === id);
    return {
      color: figure.color,
      positionAndScale: { x: figure.x, y: figure.y, scale: figure.scale },
      jointCount: figure.joints.length,
      visibleCount: figure.joints.filter(joint => joint.handleVisible !== false).length,
      hiddenCount: figure.joints.filter(joint => joint.handleVisible === false).length,
      visible: figure.joints.filter(joint => joint.handleVisible !== false).map(joint => joint.id),
      hidden: figure.joints.filter(joint => joint.handleVisible === false).map(joint => joint.id),
      earColor: byId('ear').color,
      eyeColor: byId('eye').color,
      rootLinks: ['rump', 'farFrontHip', 'nearFrontHip', 'headBase'].map(id => ({ id, length: byId(id).length, angle: byId(id).angle })),
      cloneIsIndependent: clonedTrunk.angle !== originalTrunk.angle,
      cloneKeepsHiddenHandles: clone.joints.filter(joint => joint.handleVisible === false).length === 13
    };
  });

  expect(beforeReload.color).toBe('#8c8b78');
  expect(beforeReload.positionAndScale).toEqual({ x: 400, y: 300, scale: 1 });
  expect(beforeReload.jointCount).toBe(30);
  expect(beforeReload.visibleCount).toBe(17);
  expect(beforeReload.hiddenCount).toBe(13);
  expect(beforeReload.visible).toEqual(expect.arrayContaining([
    'root', 'rump', 'farRearKnee', 'farRearFoot', 'farFrontKnee', 'farFrontFoot',
    'tailTip', 'nearRearKnee', 'nearRearFoot', 'nearFrontKnee', 'nearFrontFoot',
    'head', 'trunkUpper', 'trunkMiddle', 'trunkLower', 'trunkTip', 'ear'
  ]));
  expect(beforeReload.hidden).toEqual(expect.arrayContaining([
    'farRearHip', 'farFrontHip', 'tailBase', 'bodyMass', 'nearRearHip', 'nearFrontHip',
    'headBase', 'skullAnchor', 'skull', 'trunkBase', 'earBase', 'eyeAnchor', 'eye'
  ]));
  expect(beforeReload.earColor).toBeNull();
  expect(beforeReload.eyeColor).toBe('#ffffff');
  expect(beforeReload.rootLinks).toEqual([
    { id: 'rump', length: 89.05054744357274, angle: 3.107897546243777 },
    { id: 'farFrontHip', length: 34.43835071544513, angle: 0.45066132608063364 },
    { id: 'nearFrontHip', length: 18.38477631085024, angle: 1.1801892830972098 },
    { id: 'headBase', length: 55.31726674375732, angle: -0.8621700546672264 }
  ]);
  expect(beforeReload.cloneIsIndependent).toBe(true);
  expect(beforeReload.cloneKeepsHiddenHandles).toBe(true);

  await page.reload();
  await expect(page.locator('#main-canvas')).toBeVisible();
  await page.waitForFunction(() => window.app?.figures?.[0]?.joints?.length === 30);
  const afterReload = await page.evaluate(() => {
    const figure = app.figures[0];
    figure.updatePositions();
    const ids = figure.joints.map(joint => joint.id);
    const positions = () => Object.fromEntries(figure.joints.map(joint => [joint.id, { x: joint.x, y: joint.y }]));
    const pose = (id, delta) => {
      const before = positions();
      const joint = figure.joints.find(item => item.id === id);
      joint.angle += delta;
      app.rotateHierarchy(figure, id, delta);
      figure.updatePositions();
      return ids.filter(jointId => Math.hypot(figure.joints.find(item => item.id === jointId).x - before[jointId].x, figure.joints.find(item => item.id === jointId).y - before[jointId].y) > 0.01);
    };
    const trunkBefore = figure.joints.map(joint => ({ id: joint.id, length: joint.length }));
    const results = {
      head: pose('head', 0.15),
      ear: pose('ear', -0.25),
      trunk: pose('trunkMiddle', -0.25),
      leg: pose('nearFrontKnee', 0.2),
      tail: pose('tailTip', 0.2)
    };
    const lengthsUnchanged = figure.joints.every((joint, index) => joint.length === trunkBefore[index].length);
    return {
      color: figure.color,
      jointCount: figure.joints.length,
      hidden: figure.joints.filter(joint => joint.handleVisible === false).map(joint => joint.id),
      parents: Object.fromEntries(['head', 'eyeAnchor', 'eye', 'earBase', 'ear', 'trunkBase', 'trunkUpper', 'trunkMiddle', 'trunkLower', 'trunkTip', 'nearFrontHip', 'nearFrontKnee', 'nearFrontFoot', 'tailBase', 'tailTip'].map(id => [id, figure.joints.find(joint => joint.id === id).parentId])),
      results,
      lengthsUnchanged
    };
  });

  expect(afterReload.color).toBe('#8c8b78');
  expect(afterReload.jointCount).toBe(30);
  expect(afterReload.hidden).toHaveLength(13);
  expect(afterReload.hidden).toEqual(expect.arrayContaining(beforeReload.hidden));
  expect(afterReload.parents).toEqual({
    head: 'headBase', eyeAnchor: 'head', eye: 'eyeAnchor', earBase: 'head', ear: 'earBase',
    trunkBase: 'head', trunkUpper: 'trunkBase', trunkMiddle: 'trunkUpper', trunkLower: 'trunkMiddle', trunkTip: 'trunkLower',
    nearFrontHip: 'root', nearFrontKnee: 'nearFrontHip', nearFrontFoot: 'nearFrontKnee', tailBase: 'rump', tailTip: 'tailBase'
  });
  expect(afterReload.results.head).toEqual(expect.arrayContaining(['head', 'eye', 'ear', 'trunkBase', 'trunkUpper', 'trunkMiddle', 'trunkLower', 'trunkTip']));
  for (const id of ['rump', 'nearFrontKnee', 'nearFrontFoot', 'tailTip']) expect(afterReload.results.head).not.toContain(id);
  expect(afterReload.results.ear).toEqual(['ear']);
  expect(afterReload.results.trunk).toEqual(['trunkMiddle', 'trunkLower', 'trunkTip']);
  expect(afterReload.results.leg).toEqual(['nearFrontKnee', 'nearFrontFoot']);
  expect(afterReload.results.tail).toEqual(['tailTip']);
  expect(afterReload.lengthsUnchanged).toBe(true);
});

test('elephant ear follows the selected colour while its white eye and rig survive reload', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    app.newProject();app.figures = [];app.frames = [[]];app.currentFrameIndex = 0;
    app.addFromLibrary('elephant');
  });
  const geometry = () => page.evaluate(() => app.figures[0].joints.map(({ id, parentId, length, angle, radius, thickness, handleVisible }) => ({ id, parentId, length, angle, radius, thickness, handleVisible })));
  const before = await geometry();
  const pixels = () => page.evaluate(() => {
    const f = app.figures[0];f.updatePositions();
    const canvas = document.createElement('canvas');canvas.width = 800;canvas.height = 500;
    const context = canvas.getContext('2d'), previous = app.ctx;
    try { app.ctx = context;app.drawFigure(f, false); } finally { app.ctx = previous; }
    const sample = (id, dx = 0) => { const j = f.joints.find(j => j.id === id);return [...context.getImageData(Math.round(j.x + dx), Math.round(j.y), 1, 1).data]; };
    return { body: sample('rump'), ear: sample('ear', -12), eye: sample('eye') };
  });
  for (const [hex, rgb] of [['#000000', [0, 0, 0]], ['#ef4444', [239, 68, 68]]]) {
    await page.getByRole('button', { name: `Set figure color to ${hex}`, exact: true }).click();
    expect(await pixels()).toEqual({ body: [...rgb, 255], ear: [...rgb, 255], eye: [255, 255, 255, 255] });
    expect(await geometry()).toEqual(before);
  }
  await page.evaluate(async () => { await app.saveLocal(); });
  await page.reload();
  await page.waitForFunction(() => window.app?.figures?.[0]?.joints?.some(j => j.id === 'trunkTip'));
  expect(await pixels()).toEqual({ body: [239, 68, 68, 255], ear: [239, 68, 68, 255], eye: [255, 255, 255, 255] });
  expect(await geometry()).toEqual(before);
});

test('smooth PNG frame exports include interpolated samples', async ({ page }) => {
  await openEditor(page);
  const renderedFrames = await page.evaluate(async () => {
    app.newProject();
    const first = app.frames[0].map(figure => figure.clone());
    const second = first.map(figure => { const clone = figure.clone(); clone.x += 80; return clone; });
    app.frames = [first, second];
    app.frameDelays = [1, 1];
    app.currentFrameIndex = 0;
    app.figures = first.map(figure => figure.clone());
    app.isSmooth = true;
    app.isLooping = true;
    const originalCanvasToBlob = app.canvasToBlob;
    const originalDownloadBlob = app.downloadBlob;
    let count = 0;
    app.canvasToBlob = async () => { count += 1; return new Blob(['frame'], { type: 'image/png' }); };
    app.downloadBlob = () => {};
    try { await app.exportPngFramesZip(); } finally { app.canvasToBlob = originalCanvasToBlob; app.downloadBlob = originalDownloadBlob; }
    return count;
  });
  expect(renderedFrames).toBe(10);
});

test('long GIF exports explain the tradeoff and offer video', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    app.newProject();
    const frame = app.frames[0].map(figure => figure.clone());
    app.frames = Array.from({ length: 151 }, () => frame.map(figure => figure.clone()));
    app.frameDelays = Array(151).fill(1);
    app.__gifWarningVideoChoice = false;
    app.exportVideo = () => { app.__gifWarningVideoChoice = true; };
  });
  expect(await page.evaluate(() => app.shouldWarnForGif())).toBe(true);

  await page.getByRole('button', { name: 'Open export options' }).click();
  await page.getByRole('button', { name: 'GIF animation', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Long GIF warning' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('151 frames');
  await expect(warning).toContainText('Google Classroom');
  await expect(warning.getByRole('button', { name: 'Export Video (recommended)' })).toBeEnabled();
  await expect(warning.getByRole('button', { name: 'Export GIF Anyway' })).toBeVisible();

  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(warning).not.toBeVisible();
  await page.evaluate(() => app.showGifWarning());
  await warning.getByRole('button', { name: 'Export Video (recommended)' }).click();
  await expect(warning).not.toBeVisible();
  expect(await page.evaluate(() => app.__gifWarningVideoChoice)).toBe(true);
  expect(await page.evaluate(() => app.shouldWarnForGif())).toBe(true);
  expect(await page.evaluate(() => {
    app.frames = app.frames.slice(0, 150);
    return app.shouldWarnForGif();
  })).toBe(false);
});

test('selection and grouping feedback gives students a clear next action', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.newProject();
    app.deselectAll();
    const selectionHint = document.getElementById('panel-sel-label').textContent;
    app.addFigure();
    app.selectedFigureIds = new Set(app.figures.map(figure => figure.id));
    app.syncSelectionUI();
    app.groupSelected();
    const grouped = document.getElementById('sm-toast').textContent;
    app.ungroupSelected();
    return { selectionHint, grouped, ungrouped: document.getElementById('sm-toast').textContent };
  });
  expect(result).toEqual({ selectionHint: 'Select a figure on the stage', grouped: 'Grouped 2 figures', ungrouped: 'Ungrouped 2 figures' });
});

test('withdrawn starter templates have no student-facing entry point', async ({ page }) => {
  await openEditor(page);
  await expect(page.getByRole('button', { name: 'Templates' })).toHaveCount(0);
  await expect(page.locator('#templates-modal')).toHaveCount(0);
  const controls = await page.evaluate(() => ({
    openTemplates: typeof app.openTemplates,
    applyTemplate: typeof app.applyTemplate
  }));
  expect(controls).toEqual({ openTemplates: 'undefined', applyTemplate: 'undefined' });
});

test('timeline reuses unchanged thumbnails but never shows a stale one', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(async () => {
    app.newProject();
    for (let i = 1; i < 6; i++) { app.figures[0].x = 100 + i * 40; app.saveLocal(); app.addFrame(); }
    app.updateTimeline(); // every stored thumbnail is now cached

    let renders = 0;
    const original = app.renderTimelineThumbnail;
    app.renderTimelineThumbnail = function (...args) { renders++; return original.apply(this, args); };
    app.addFrame();
    const rendersForAddFrame = renders;
    app.renderTimelineThumbnail = original;

    const thumb = index => document.querySelector(`.frame-thumb[data-frame-index="${index}"] canvas`).toDataURL();
    app.loadFrame(1); app.loadFrame(3);
    const beforeEdit = thumb(1);
    app.loadFrame(1); app.figures[0].x += 150; app.saveLocal(); app.loadFrame(3); app.updateTimeline();
    const editShows = thumb(1) !== beforeEdit;

    // A live pose drawn into a thumbnail, then discarded without saving, must not stand in for the stored frame.
    app.loadFrame(2); app.figures[0].x += 300; app.render();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    app.loadFrame(4, false); app.updateTimeline();
    const expected = app.newThumbnailCanvas(); app.renderTimelineThumbnail(expected, app.frames[2]);
    const discardedEditHidden = thumb(2) === expected.toDataURL();

    const beforeResize = thumb(1);
    app.applyCanvasSize(400, 500); app.updateTimeline();
    const resizeShows = thumb(1) !== beforeResize;

    const source = document.createElement('canvas'); source.width = 2; source.height = 2;
    const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#16a34a'; sourceContext.fillRect(0, 0, 2, 2);
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source.toDataURL('image/png'); });
    const beforeBackground = thumb(1);
    app.bgImage = image; app.updateTimeline();
    const backgroundShows = thumb(1) !== beforeBackground;
    return { rendersForAddFrame, editShows, discardedEditHidden, resizeShows, backgroundShows };
  });
  expect(result).toEqual({ rendersForAddFrame: 2, editShows: true, discardedEditHidden: true, resizeShows: true, backgroundShows: true });
});

test('timeline previews show the actual frame and do not rebuild for duration scrubbing', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(async () => {
    app.newProject();
    app.addText();
    app.updateText('Hello');
    const speech = app.createSpeechBubble();
    speech.text = 'Look'; speech.x = 560; speech.y = 230;
    app.figures.push(speech);
    app.frames[0] = app.cloneFigures(app.figures);

    const source = document.createElement('canvas');
    source.width = 2; source.height = 2;
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#16a34a'; sourceContext.fillRect(0, 0, 2, 2);
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source.toDataURL('image/png'); });
    app.bgImage = image;

    const drawn = [];
    const drawFigure = app.drawFigure;
    app.drawFigure = function (figure, handles) { drawn.push({ type: figure.type, handles }); return drawFigure.call(this, figure, handles); };
    app.updateTimeline();
    app.drawFigure = drawFigure;

    const thumbnail = document.querySelector('.frame-thumb[data-frame-index="0"] canvas');
    const before = thumbnail.toDataURL();
    app.figures[0].x += 120;
    app.render();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const after = thumbnail.toDataURL();

    let timelineRebuilds = 0;
    const updateTimeline = app.updateTimeline;
    app.updateTimeline = function () { timelineRebuilds++; return updateTimeline.apply(this, arguments); };
    app.setFrameDuration(2);
    app.updateTimeline = updateTimeline;
    const pixels = thumbnail.getContext('2d').getImageData(0, 0, thumbnail.width, thumbnail.height).data;
    let greenPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] === 22 && pixels[index + 1] === 163 && pixels[index + 2] === 74) greenPixels++;
    return { drawn, beforeChanged: before !== after, greenPixels, timelineRebuilds, duration: app.frameDelays[0] };
  });
  expect(result.drawn).toEqual(expect.arrayContaining([
    { type: 'text', handles: false },
    { type: 'speech', handles: false }
  ]));
  expect(result.beforeChanged).toBe(true);
  expect(result.greenPixels).toBeGreaterThan(4000);
  expect(result.timelineRebuilds).toBe(0);
  expect(result.duration).toBe(2);
});

test('GIF export shows progress, cancels safely, and allows a later export', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(async () => {
    const nativeGIF = window.GIF;
    class ControlledGIF {
      static instances = [];
      constructor() { this.listeners = {}; this.aborted = false; ControlledGIF.instances.push(this); }
      on(event, listener) { this.listeners[event] = listener; }
      emit(event, value) { if (this.listeners[event]) this.listeners[event](value); }
      addFrame() {}
      abort() { this.aborted = true; this.emit('abort'); }
      render() {
        this.emit('progress', 0.5);
        if (ControlledGIF.instances.length > 1) requestAnimationFrame(() => this.emit('finished', new Blob(['gif'], { type: 'image/gif' })));
      }
    }
    window.GIF = ControlledGIF;
    try {
      app.newProject();
      app.figures[0].x = 173;
      app.render();
      app.exportGif();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const first = ControlledGIF.instances[0];
      const beforeCancel = {
        modalVisible: document.getElementById('loading-modal').classList.contains('show'),
        status: document.getElementById('gif-export-status').textContent,
        disabled: document.getElementById('btn-export').disabled,
        focusedCancel: document.activeElement.id === 'gif-export-cancel'
      };
      document.getElementById('gif-export-cancel').click();
      first.emit('finished', new Blob(['stale'], { type: 'image/gif' }));
      const afterCancel = {
        modalVisible: document.getElementById('loading-modal').classList.contains('show'),
        activeExport: !!app.gifExport,
        encoderAborted: first.aborted,
        restoredX: app.figures[0].x,
        toast: document.getElementById('sm-toast').textContent,
        exportEnabled: !document.getElementById('btn-export').disabled
      };
      app.exportGif();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { beforeCancel, afterCancel, laterExport: { activeExport: !!app.gifExport, toast: document.getElementById('sm-toast').textContent } };
    } finally {
      window.GIF = nativeGIF;
    }
  });
  expect(result.beforeCancel).toEqual({ modalVisible: true, status: 'Encoding GIF: 50%', disabled: true, focusedCancel: true });
  expect(result.afterCancel).toEqual({ modalVisible: false, activeExport: false, encoderAborted: true, restoredX: 173, toast: 'GIF export cancelled', exportEnabled: true });
  expect(result.laterExport).toEqual({ activeExport: false, toast: 'Exported untitled-animation.gif' });
});

test('GIF and WebM exports use FPS and frame duration timing', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(async () => {
    const nativeGIF = window.GIF;
    const nativeMediaRecorder = window.MediaRecorder;
    const nativeCaptureStream = HTMLCanvasElement.prototype.captureStream;
    const nativeSetTimeout = window.setTimeout;
    const nativeDownloadBlob = app.downloadBlob;
    const nativeAnchorClick = HTMLAnchorElement.prototype.click;

    class TimingGIF {
      static instances = [];
      constructor() { this.listeners = {}; this.delays = []; TimingGIF.instances.push(this); }
      on(event, listener) { this.listeners[event] = listener; }
      emit(event, value) { if (this.listeners[event]) this.listeners[event](value); }
      addFrame(_context, options) { this.delays.push(options.delay); }
      render() { requestAnimationFrame(() => this.emit('finished', new Blob(['gif'], { type: 'image/gif' }))); }
      abort() {}
    }

    class TimingRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      static instances = [];
      constructor() { super(); this.state = 'inactive'; this.actions = []; TimingRecorder.instances.push(this); }
      start() { this.state = 'recording'; queueMicrotask(() => this.dispatchEvent(new Event('start'))); }
      requestData() {
        this.actions.push('requestData');
        queueMicrotask(() => {
          const dataEvent = new Event('dataavailable');
          Object.defineProperty(dataEvent, 'data', { value: new Blob(['webm'], { type: 'video/webm' }) });
          this.dispatchEvent(dataEvent);
        });
      }
      stop() {
        this.actions.push('stop');
        this.state = 'inactive';
        const dataEvent = new Event('dataavailable');
        Object.defineProperty(dataEvent, 'data', { value: new Blob(['webm'], { type: 'video/webm' }) });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event('stop'));
      }
    }

    const track = { requestFrame() {}, stop() {} };
    const captureRates = [];
    window.GIF = TimingGIF;
    window.MediaRecorder = TimingRecorder;
    HTMLCanvasElement.prototype.captureStream = rate => { captureRates.push(rate); return { getVideoTracks: () => [track], getTracks: () => [track] }; };
    HTMLAnchorElement.prototype.click = () => {};
    app.downloadBlob = () => {};

    const prepare = (fps, multiplier) => {
      app.newProject();
      app.fps = fps;
      app.frameDelays = [multiplier];
      app.isSmooth = true;
      app.isLooping = true;
    };
    const waitForGif = async () => {
      while (app.gifExport) await new Promise(resolve => requestAnimationFrame(resolve));
      return TimingGIF.instances.at(-1).delays;
    };

    try {
      prepare(10, 2);
      app.exportGif();
      const gifSlow = await waitForGif();
      prepare(20, 2);
      app.exportGif();
      const gifFast = await waitForGif();

      const runVideo = async (fps, multiplier, smooth = false) => {
        prepare(fps, multiplier);
        app.isSmooth = smooth;
        const originalRenderInterpolated = app.renderInterpolated;
        let interpolationCount = 0;
        app.renderInterpolated = (...args) => { interpolationCount += 1; return originalRenderInterpolated.apply(app, args); };
        const waits = [];
        window.setTimeout = (callback, delay, ...args) => {
          waits.push(delay);
          return nativeSetTimeout(callback, 0, ...args);
        };
        await app.exportVideo();
        window.setTimeout = nativeSetTimeout;
        app.renderInterpolated = originalRenderInterpolated;
        return { waits: waits.filter(delay => delay <= 1000), captureRate: captureRates.at(-1), interpolationCount, actions: TimingRecorder.instances.at(-1).actions };
      };

      return { gifSlow, gifFast, videoSlow: await runVideo(10, 2), videoFast: await runVideo(20, 2), videoSmooth: await runVideo(20, 1, true) };
    } finally {
      window.GIF = nativeGIF;
      window.MediaRecorder = nativeMediaRecorder;
      HTMLCanvasElement.prototype.captureStream = nativeCaptureStream;
      window.setTimeout = nativeSetTimeout;
      app.downloadBlob = nativeDownloadBlob;
      HTMLAnchorElement.prototype.click = nativeAnchorClick;
    }
  });

  expect(result.gifSlow.reduce((total, delay) => total + delay, 0)).toBe(200);
  expect(result.gifFast.reduce((total, delay) => total + delay, 0)).toBe(100);
  expect(result.videoSlow.waits.reduce((total, delay) => total + delay, 0)).toBe(200);
  expect(result.videoFast.waits.reduce((total, delay) => total + delay, 0)).toBe(100);
  expect(result.videoSmooth.waits.reduce((total, delay) => total + delay, 0)).toBe(50);
  expect(result.videoSmooth.captureRate).toBe(60);
  expect(result.videoSlow.interpolationCount).toBe(0);
  expect(result.videoFast.interpolationCount).toBe(0);
  expect(result.videoSmooth.interpolationCount).toBeGreaterThan(0);
  expect(result.videoSmooth.actions).toEqual(['requestData', 'stop']);
});

async function setUpTwoPosePlayback(page) {
  return page.evaluate(async () => {
    app.newProject(); app.isSmooth = true; app.isLooping = true; app.updateFps(2);
    app.figures[0].x = 100; app.saveLocal();
    app.addFrame(); app.figures[0].x = 500; app.saveLocal();
    app.loadFrame(0); await app.localSaveQueue;
    return app.frames.map(frame => frame[0].x);
  });
}
const storedPoses = page => page.evaluate(async () => { await app.localSaveQueue; return app.frames.map(frame => frame[0].x); });

test('stopping playback with the mouse never stores an in-between pose', async ({ page }) => {
  await openEditor(page);
  expect(await setUpTwoPosePlayback(page)).toEqual([100, 500]);
  await page.click('#btn-play');
  await page.waitForTimeout(250); // FPS 2: halfway between the two poses
  await page.click('#btn-stop');
  expect(await storedPoses(page)).toEqual([100, 500]);
  expect(await page.evaluate(() => app.figures[0].x)).toBe(100);
});

test('choosing a frame or pasting during playback never stores an in-between pose', async ({ page }) => {
  await openEditor(page);
  expect(await setUpTwoPosePlayback(page)).toEqual([100, 500]);
  await page.click('#btn-play');
  await page.waitForTimeout(250);
  await page.locator('.frame-thumb[data-frame-index="1"]').click();
  await page.evaluate(() => app.stop());
  expect(await storedPoses(page)).toEqual([100, 500]);

  await page.evaluate(() => { app.loadFrame(0); app.selectFigure(app.figures[1] || app.figures[0]); app.copySelected(); });
  await page.click('#btn-play');
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+v');
  const result = await page.evaluate(async () => { await app.localSaveQueue; return { playing: app.isPlaying, firstFigureX: app.frames.map(frame => frame[0].x) }; });
  expect(result).toEqual({ playing: false, firstFigureX: [100, 500] });
});

test('with Loop off, smooth playback draws the exact final pose before stopping', async ({ page }) => {
  await openEditor(page);
  const drawnOnLastFrame = await page.evaluate(async () => {
    app.newProject(); app.isSmooth = true; app.isLooping = false; app.updateFps(4);
    app.figures[0].x = 100; app.saveLocal(); app.addFrame(); app.figures[0].x = 500; app.saveLocal(); app.loadFrame(0);
    const seen = [];
    const original = app.render.bind(app);
    app.render = () => { if (app.isPlaying && app.currentFrameIndex === 1) seen.push(app.figures[0].x); return original(); };
    app.play();
    await new Promise(resolve => { const wait = () => (app.isPlaying ? requestAnimationFrame(wait) : resolve()); wait(); });
    app.render = original;
    return seen;
  });
  expect(drawnOnLastFrame).toContain(500);
});

test('autosave never stores a pose that a running export is rendering', async ({ page }) => {
  await openEditor(page);
  const stored = await page.evaluate(async () => {
    app.newProject(); app.figures[0].x = 100; app.saveLocal(); await app.localSaveQueue;
    const stage = app.figures;
    const results = {};
    for (const flag of ['asyncExport', 'gifExport']) {
      app[flag] = { cancelled: false };
      app.figures = stage.map(figure => { const copy = figure.clone(); copy.x = 999; return copy; });
      app.saveLocal(); await app.localSaveQueue;
      results[flag] = app.frames[0][0].x;
      app[flag] = null; app.figures = stage;
    }
    return results;
  });
  expect(stored).toEqual({ asyncExport: 100, gifExport: 100 });
});

test('onion skin only draws an actual previous frame', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.newProject();
    app.showOnion = true;
    const original = app.drawFigure.bind(app);
    const countGhosts = () => {
      const calls = [];
      app.drawFigure = (figure, handles) => { calls.push(handles); return original(figure, handles); };
      app.render();
      app.drawFigure = original;
      return calls.filter(handles => handles === false).length;
    };
    app.figures[0].x += 60;
    const firstFrameGhosts = countGhosts();
    app.addFrame();
    app.figures[0].x += 60;
    const laterFrameGhosts = countGhosts();
    return { firstFrameGhosts, laterFrameGhosts };
  });
  expect(result).toEqual({ firstFrameGhosts: 0, laterFrameGhosts: 1 });
});

test('regrouping figures leaves no empty or stale groups behind', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.newProject(); app.addFigure(); app.addFigure();
    const [a, b, c] = app.figures.map(figure => figure.id);
    const group = (...ids) => { app.selectedFigureIds = new Set(ids); app.groupSelected(); };
    const snapshot = () => ({
      groups: app.groups.map(g => ({ label: g.label, members: [...g.figureIds].sort() })),
      groupIds: app.figures.map(figure => figure.groupId === null ? null : app.groups.find(g => g.id === figure.groupId)?.label)
    });
    group(a, b); group(a, b);
    const afterRegroup = snapshot();
    group(b, c); // b leaves the a+b group, which is left with only a
    const afterMove = snapshot();
    app.ungroupSelected(app.groups[0].id); group(a, b); group(a, c);
    return { afterRegroup, afterMove, labelsUnique: new Set(app.groups.map(g => g.label)).size === app.groups.length };
  });
  expect(result.afterRegroup.groups).toHaveLength(1);
  expect(result.afterRegroup.groupIds).toEqual([result.afterRegroup.groups[0].label, result.afterRegroup.groups[0].label, null]);
  expect(result.afterMove.groups).toHaveLength(1);
  expect(result.afterMove.groupIds[0]).toBeNull();
  expect(result.labelsUnique).toBe(true);
});

test('selection, grouping, deletion, and undo preserve editor state', async ({ page }) => {
  await openEditor(page);
  const state = await page.evaluate(() => {
    app.newProject();
    app.addFigure();
    const ids = app.figures.map(figure => figure.id);
    app.selectedFigureIds = new Set(ids);
    app.syncSelectionUI();
    app.groupSelected();
    const grouped = { figures: app.figures.length, groups: app.groups.length, selected: app.selectedFigureIds.size };
    app.deleteSelectedFigure();
    const deleted = app.figures.length;
    app.undo();
    return { grouped, deleted, restored: app.figures.length, groupsAfterUndo: app.groups.length };
  });

  expect(state.grouped).toEqual({ figures: 2, groups: 1, selected: 2 });
  expect(state.deleted).toBe(0);
  expect(state.restored).toBe(2);
  expect(state.groupsAfterUndo).toBe(1);
});

test('frame creation is undoable through the student keyboard shortcut', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => app.newProject());
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => app.frames.length)).toBe(2);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => app.frames.length)).toBe(1);
});

test('dropping something other than a frame onto the timeline changes nothing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.newProject();
    for (const x of [100, 200, 300]) { if (x > 100) app.addFrame(); app.figures[0].x = x; app.saveLocal(); }
    const thumb = index => document.querySelector(`.frame-thumb[data-frame-index="${index}"]`);
    const drag = (type, index) => thumb(index).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    drag('drop', 1); // e.g. an image dragged in from the desktop
    const afterForeignDrop = app.frames.map(frame => frame?.[0]?.x);
    drag('dragstart', 0); drag('drop', 2); // a real reorder
    const afterReorder = app.frames.map(frame => frame?.[0]?.x);
    drag('drop', 1); // a later foreign drop must not reuse the old drag
    return { afterForeignDrop, afterReorder, afterSecondForeignDrop: app.frames.map(frame => frame?.[0]?.x) };
  });
  expect(result).toEqual({ afterForeignDrop: [100, 200, 300], afterReorder: [200, 300, 100], afterSecondForeignDrop: [200, 300, 100] });
  expect(errors).toEqual([]);
});

test('frame selection follows Undo and project opening, so Delete removes the frame on screen', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    const threeFrames = () => { app.newProject(); for (const x of [100, 200, 300]) { if (x > 100) app.addFrame(); app.figures[0].x = x; app.saveLocal(); } };
    threeFrames();
    app.loadFrame(1); app.duplicateCurrentFrame(); app.undo();
    const viewingAfterUndo = app.figures[0].x;
    app.deleteFrame();
    const afterUndo = app.frames.map(frame => frame[0].x);

    threeFrames(); app.loadFrame(0);
    const project = JSON.parse(JSON.stringify(app.serializeProject()));
    app.selectedFrames = new Set([1, 2]);
    app.applyProjectData(project);
    app.deleteFrame();
    return { viewingAfterUndo, afterUndo, afterOpen: app.frames.map(frame => frame[0].x) };
  });
  expect(result).toEqual({ viewingAfterUndo: 200, afterUndo: [100, 300], afterOpen: [200, 300] });
});

test('deleting every frame is refused instead of wiping the project', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.newProject(); app.setProjectName('My scene'); app.addFigure(); app.addFigure(); app.saveLocal();
    app.deleteFrameAtIndex(0);
    const afterSingle = { frames: app.frames.length, figures: app.figures.length, name: app.projectName };
    app.figures[0].x = 100; app.saveLocal(); app.addFrame(); app.figures[0].x = 200; app.saveLocal();
    app.selectedFrames = new Set([0, 1]);
    app.deleteFrame();
    return { afterSingle, afterAll: { frames: app.frames.length, firstFigureX: app.frames.map(frame => frame[0].x), name: app.projectName } };
  });
  expect(result).toEqual({
    afterSingle: { frames: 1, figures: 3, name: 'My scene' },
    afterAll: { frames: 2, firstFigureX: [100, 200], name: 'My scene' }
  });
  await expect(page.locator('#sm-toast')).toContainText('at least one frame');
});

test('deleting selected frames keeps showing the frame the student was on', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.newProject();
    for (const x of [100, 200, 300, 400, 500]) { if (x > 100) app.addFrame(); app.figures[0].x = x; app.saveLocal(); }
    app.loadFrame(2);
    app.selectedFrames = new Set([0]); // frame 1 selected for deletion while viewing frame 3
    app.deleteFrame();
    return { remaining: app.frames.map(frame => frame[0].x), viewing: app.figures[0].x, index: app.currentFrameIndex };
  });
  expect(result).toEqual({ remaining: [200, 300, 400, 500], viewing: 300, index: 1 });
});

test('editor controls stay within the limits a saved project can be reopened with', async ({ page }) => {
  await openEditor(page);
  await expect(page.locator('#text-figure-input')).toHaveAttribute('maxlength', '1000');
  const result = await page.evaluate(async () => {
    app.newProject(); app.setProjectName('Within limits'); app.selectFigure(app.figures[0]);
    for (let i = 0; i < 60; i++) app.scaleFigure(0.9);
    const minScale = app.figures[0].scale;
    for (let i = 0; i < 120; i++) app.scaleFigure(1.1);
    const maxScale = app.figures[0].scale;
    app.figures[0].scale = 1;

    app.addFromLibrary('speech');
    const speech = app.figures.find(figure => figure.type === 'speech');
    app.updateText('x'.repeat(1500));
    speech.updatePositions();
    app.updateFreeJointFromPos(speech, speech.joints.find(joint => joint.id === 'tail'), { x: speech.x + 500000, y: speech.y });
    const tailLength = speech.joints.find(joint => joint.id === 'tail').length;

    app.selectedFigureIds = new Set(app.figures.slice(0, 2).map(figure => figure.id));
    for (let i = 0; i < 260; i++) { app.selectedFigureIds = new Set(app.figures.slice(0, 2).map(figure => figure.id)); app.groupSelected(); }
    const groups = app.groups.length;

    while (app.figures.length < 260) { const before = app.figures.length; app.addFigure(); if (app.figures.length === before) break; }
    const afterAdd = app.figures.length;
    for (const add of [() => app.addText(), () => app.addFromLibrary('ball'), () => app.addCustomFigure(app.createStickman())]) add();
    const afterOtherAdds = app.figures.length;
    app.selectedFigureIds = new Set(app.figures.slice(0, 3).map(figure => figure.id)); app.copySelected(); app.paste();
    const afterPaste = app.figures.length;

    builder.open();
    for (let i = 0; i < 120; i++) builder.addSegment('line');
    const builderJoints = builder.figure.joints.length;
    builder.close();

    app.saveLocal(); await app.localSaveQueue;
    return { minScale, maxScale, textLength: speech.text.length, tailLength, groups, afterAdd, afterOtherAdds, afterPaste, builderJoints };
  });
  expect(result.minScale).toBeGreaterThanOrEqual(0.05);
  expect(result.maxScale).toBeLessThanOrEqual(100);
  expect(result.textLength).toBe(1000);
  expect(result.tailLength).toBeLessThanOrEqual(10000);
  expect(result.groups).toBeLessThanOrEqual(250);
  expect([result.afterAdd, result.afterOtherAdds, result.afterPaste]).toEqual([250, 250, 250]);
  expect(result.builderJoints).toBe(100);

  await openEditor(page);
  await expect(page.locator('#project-name')).toHaveValue('Within limits');
  expect(await page.evaluate(() => app.figures.length)).toBe(250);
});

test('editor never creates a project larger than its importer supports', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    app.frames = Array.from({ length: 2000 }, () => []);
    app.frameDelays = Array(2000).fill(1);
    app.currentFrameIndex = 0;
    app.addFrame();
    app.duplicateFrameAtIndex(0);
    return { frames: app.frames.length, message: document.getElementById('sm-toast').textContent };
  });
  expect(result.frames).toBe(2000);
  expect(result.message).toContain('2,000-frame limit');
});

test('rejects malformed project files through the normal file-open path', async ({ page }) => {
  await openEditor(page);
  const malformed = {
    version: 4,
    width: 800,
    height: 500,
    frames: [[{
      id: 'figure1', x: 400, y: 300, scale: 1, color: '#000000', type: 'figure', text: '',
      joints: [
        { id: 'root', parentId: 'arm', length: 0, angle: 0, type: 'line', radius: 20, thickness: 14 },
        { id: 'arm', parentId: 'root', length: 30, angle: 0, type: 'line', radius: 20, thickness: 14 }
      ]
    }]],
    delays: [1], currentFrameIndex: 0, groups: [], settings: {}
  };
  await page.locator('#load-input').setInputFiles({
    name: 'invalid-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malformed))
  });
  await expect(page.locator('#sm-toast')).toContainText('could not be opened');
  await expect(page.locator('#sm-toast')).toHaveAttribute('aria-live', 'assertive');
});

test('opens projects containing accumulated multi-turn joint angles', async ({ page }) => {
  await openEditor(page);
  const project = {
    version: 5,
    name: 'Recovered student project',
    width: 800,
    height: 500,
    fps: 12,
    frames: [[{
      id: 'figure1', x: 400, y: 300, scale: 1, color: '#000000', type: 'figure', text: '',
      joints: [
        { id: 'root', parentId: null, length: 0, angle: 0, type: 'line', radius: 20, thickness: 14 },
        { id: 'arm', parentId: 'root', length: 30, angle: -8.566402320633376, type: 'line', radius: 20, thickness: 14 }
      ]
    }]],
    delays: [1], currentFrameIndex: 0, groups: [], settings: {}
  };
  await page.locator('#load-input').setInputFiles({
    name: 'recovered-student-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project))
  });
  await page.locator('#confirm-ok').click(); // Open asks before replacing the current animation
  await expect(page.locator('#sm-toast')).toContainText('Opened Recovered student project');
  await expect.poll(() => page.evaluate(() => app.frames[0][0].joints[1].angle)).toBeCloseTo(-2.2832170134537895);
});

test('compact top-bar actions remain reachable without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openEditor(page);
  const layout = await page.evaluate(() => {
    const topbar = document.getElementById('topbar');
    return { scrollWidth: topbar.scrollWidth, clientWidth: topbar.clientWidth };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  await expect(page.getByRole('button', { name: 'Open project and export actions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Open project and export actions' }).click();
  await expect(page.locator('#compact-actions-menu')).toBeVisible();
  await expect(page.locator('#compact-actions-toggle')).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['New project', 'Save project', 'Open project', 'Settings', 'Help and shortcuts', 'GIF animation', 'Video (WebM)', 'Current frame PNG', 'PNG frames ZIP']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Help and shortcuts', exact: true }).click();
  await expect(page.locator('#compact-actions-menu')).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Help & Shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open project and export actions' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#compact-actions-menu')).toBeHidden();
});

test('tablet inspector drawer and two-finger panning remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openEditor(page);
  await expect(page.locator('#inspector-toggle')).toBeVisible();
  await expect(page.locator('#right-panel')).not.toHaveClass(/open/);
  await page.locator('#inspector-toggle').click();
  await expect(page.locator('#right-panel')).toHaveClass(/open/);

  const panned = await page.evaluate(() => {
    const area = document.getElementById('canvas-area');
    area.scrollLeft = 120;
    area.scrollTop = 80;
    const event = (touches) => ({ touches, preventDefault() {}, stopPropagation() {} });
    app.startTouchPan(event([{ clientX: 100, clientY: 100 }, { clientX: 140, clientY: 100 }]));
    app.handleTouchPanMove(event([{ clientX: 80, clientY: 70 }, { clientX: 120, clientY: 70 }]));
    app.endTouchPan(event([]));
    return { left: area.scrollLeft, top: area.scrollTop, isPanning: app.isPanning };
  });
  expect(panned).toEqual({ left: 140, top: 110, isPanning: false });
});

test('runs with external network requests blocked and local GIF assets present', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const externalRequests = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    externalRequests.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  await openEditor(page);
  await expect(page.locator('script[src="vendor/gif.js"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => typeof GIF)).toBe('function');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Open export options' }).click();
  await page.getByRole('button', { name: 'GIF animation', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('untitled-animation.gif');
  expect(externalRequests).toEqual([]);
  await context.close();
});
