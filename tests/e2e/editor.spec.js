import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';

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
        const waits = [];
        window.setTimeout = (callback, delay, ...args) => {
          waits.push(delay);
          return nativeSetTimeout(callback, 0, ...args);
        };
        await app.exportVideo();
        window.setTimeout = nativeSetTimeout;
        return { waits: waits.filter(delay => delay <= 1000), captureRate: captureRates.at(-1), actions: TimingRecorder.instances.at(-1).actions };
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
  expect(result.videoSmooth.captureRate).toBe(40);
  expect(result.videoSmooth.actions).toEqual(['requestData', 'stop']);
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
