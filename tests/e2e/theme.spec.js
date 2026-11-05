import { expect, test } from '@playwright/test';

async function openEditor(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.app?.frames?.length > 0);
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) await page.getByRole('button', { name: 'Start animating' }).click();
}

const theme = page => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const pageBackground = page => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('the dark Night theme is the default', async ({ page }) => {
  await openEditor(page);
  expect(await theme(page)).not.toBe('light');
  expect(await pageBackground(page)).toBe('rgb(23, 22, 26)');
  const button = page.getByRole('button', { name: 'Light paper theme' });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('title', 'Switch to the light Paper theme');
});

test('the theme button switches between Night and Paper and the choice survives a reload', async ({ page }) => {
  await openEditor(page);
  const button = page.locator('#theme-toggle');
  await button.click();
  expect(await theme(page)).toBe('light');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Switch to the dark Night theme');
  expect(await pageBackground(page)).toBe('rgb(236, 238, 232)');
  expect(await page.evaluate(() => localStorage.getItem('stickmotion_theme'))).toBe('light');

  await openEditor(page);
  expect(await theme(page)).toBe('light');
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#theme-toggle').click();
  expect(await theme(page)).toBe('dark');
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await pageBackground(page)).toBe('rgb(23, 22, 26)');
  await openEditor(page);
  expect(await theme(page)).not.toBe('light');
});

test('a saved Paper theme is applied before the app starts, so the page never flashes dark', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('stickmotion_theme', 'light'); } catch {} });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/src/models.js', async route => { await held; await route.continue(); });
  await page.goto('/index.html', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.body);
  expect(await page.evaluate(() => typeof window.app)).toBe('undefined');
  expect(await theme(page)).toBe('light');
  release();
  await page.waitForFunction(() => window.app?.frames?.length > 0);
});

test('the theme still switches when browser storage is blocked', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage is blocked', 'SecurityError'); } });
  });
  await openEditor(page);
  expect(await theme(page)).not.toBe('light');
  const button = page.locator('#theme-toggle');
  await button.click();
  expect(await theme(page)).toBe('light');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await button.click();
  expect(await theme(page)).toBe('dark');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('the compact menu offers the theme too, and the top bar still fits', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openEditor(page);
  await expect(page.locator('#theme-toggle')).toBeHidden();
  await page.getByRole('button', { name: 'Open project and export actions' }).click();
  const item = page.locator('#compact-theme-toggle');
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-pressed', 'false');
  await item.click();
  expect(await theme(page)).toBe('light');
  await expect(page.locator('#compact-actions-menu')).toBeHidden();
  await page.getByRole('button', { name: 'Open project and export actions' }).click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  const layout = await page.evaluate(() => { const bar = document.getElementById('topbar'); return { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth }; });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
});

test('the top bar fits with the theme button at common classroom widths', async ({ page }) => {
  for (const width of [1920, 1366, 1280, 1100]) {
    await page.setViewportSize({ width, height: 800 });
    await openEditor(page);
    const layout = await page.evaluate(() => {
      const bar = document.getElementById('topbar'), button = document.getElementById('theme-toggle').getBoundingClientRect();
      return { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, right: button.right };
    });
    expect(layout.scrollWidth, `top bar at ${width}px`).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.right).toBeLessThanOrEqual(width);
  }
});
