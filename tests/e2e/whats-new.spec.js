import { expect, test } from '@playwright/test';

const ready = page => page.waitForFunction(() => window.app?.frames?.length > 0);
const dot = page => page.locator('#btn-help.has-news');

test('a first visit gets the welcome guide and no What\'s new dot', async ({ page }) => {
  await page.goto('/index.html'); await ready(page);
  await expect(page.locator('#welcome-modal')).toHaveClass(/show/);
  await expect(dot(page)).toHaveCount(0);
});

test('a returning student sees a dot on Help until What\'s new is read, from Help or on its own', async ({ page }) => {
  await page.goto('/index.html'); await ready(page);
  await page.evaluate(() => { localStorage.setItem('stickmotion_welcome_seen', '1'); localStorage.removeItem('stickmotion_whats_new'); });
  await page.reload(); await ready(page);
  await expect(dot(page)).toHaveCount(1);

  await page.locator('#btn-help').click();
  await page.locator('#help-whats-new').click();
  await expect(page.locator('#help-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#whats-new-modal')).toHaveClass(/show/);
  await expect(page.locator('#whats-new-modal')).toContainText('Flip through your frames');
  await expect(page.locator('#whats-new-close')).toBeFocused();
  await expect(dot(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#whats-new-modal')).not.toHaveClass(/show/);

  // Read once, the dot stays away after a reload.
  await page.reload(); await ready(page);
  await expect(dot(page)).toHaveCount(0);
});

test('What\'s new works with browser storage blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => { throw new Error('storage blocked'); };
    Object.defineProperty(window, 'localStorage', { get: () => ({ getItem: blocked, setItem: blocked, removeItem: blocked }) });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/index.html'); await ready(page);
  await page.evaluate(() => app.openWhatsNew());
  await expect(page.locator('#whats-new-modal')).toHaveClass(/show/);
  expect(errors).toEqual([]);
});
