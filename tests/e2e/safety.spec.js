import { expect, test } from '@playwright/test';

async function openEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

// A fresh project, renamed and changed the way a student's edit would change it.
async function editedProject(page, name) {
  await page.evaluate(async name => {
    app.newProject(); app.setProjectName(name);
    app.saveState(); app.figures[0].x = 111; app.render();
    await app.saveLocal();
  }, name);
}

const newButton = page => page.getByRole('button', { name: 'New', exact: true });

test('New offers to save a project file first when the animation is not saved as one', async ({ page }) => {
  await openEditor(page);
  await editedProject(page, 'Robot dance');
  await newButton(page).click();
  await expect(page.locator('#confirm-title')).toHaveText('Save your animation first?');
  await expect(page.locator('#confirm-msg')).toContainText('"Robot dance" isn\'t saved as a project file yet');
  await expect(page.locator('#confirm-ok')).toHaveText('Start new anyway');

  // Save file first downloads the project and keeps the work.
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#confirm-alt').click()]);
  expect(download.suggestedFilename()).toBe('robot-dance.json');
  expect(await page.evaluate(() => ({ name: app.projectName, x: app.frames[0][0].x }))).toEqual({ name: 'Robot dance', x: 111 });

  // Now it is saved, New just checks, and the dialog has no second choice.
  await newButton(page).click();
  await expect(page.locator('#confirm-title')).toHaveText('New project?');
  await expect(page.locator('#confirm-alt')).toBeHidden();
  await page.locator('#confirm-ok').click();
  expect(await page.evaluate(() => app.projectName)).toBe('Untitled animation');
});

test('cancelling New keeps the work, and a blank project needs no saving', async ({ page }) => {
  await openEditor(page);
  await editedProject(page, 'Keep me');
  await newButton(page).click();
  await page.locator('#confirm-cancel').click();
  expect(await page.evaluate(() => ({ name: app.projectName, x: app.frames[0][0].x }))).toEqual({ name: 'Keep me', x: 111 });
  await page.evaluate(() => app.newProject());
  await newButton(page).click();
  await expect(page.locator('#confirm-title')).toHaveText('New project?');
});

test('the browser remembers across a reload that the animation is saved as a file', async ({ page }) => {
  await openEditor(page);
  await editedProject(page, 'Saved one');
  await Promise.all([page.waitForEvent('download'), page.evaluate(() => app.saveProject())]);
  await page.evaluate(() => app.localSaveQueue);
  await page.reload();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  await newButton(page).click();
  await expect(page.locator('#confirm-title')).toHaveText('New project?');
  await page.locator('#confirm-cancel').click();
  // Any change after saving counts as unsaved again.
  await page.evaluate(() => { app.saveState(); app.figures[0].x = 5; app.render(); });
  await newButton(page).click();
  await expect(page.locator('#confirm-title')).toHaveText('Save your animation first?');
});

test('Open offers to save the current animation first, then opens the chosen one', async ({ page }) => {
  await openEditor(page);
  await editedProject(page, 'Current work');
  const incoming = await page.evaluate(() => { const data = JSON.parse(JSON.stringify(app.serializeProject())); data.name = 'Incoming project'; data.frames[0][0].x = 222; return data; });
  await page.locator('#load-input').setInputFiles({ name: 'incoming.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
  await expect(page.locator('#confirm-alt')).toHaveText('Save mine, then open');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#confirm-alt').click()]);
  expect(download.suggestedFilename()).toBe('current-work.json');
  expect(await page.evaluate(() => ({ name: app.projectName, x: app.frames[0][0].x }))).toEqual({ name: 'Incoming project', x: 222 });
});
