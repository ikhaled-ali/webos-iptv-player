import { test, expect, enterTab, type Page } from './helpers';

async function addPlaylist(page: Page, url: string): Promise<void> {
  await page.locator('#add-playlist').click();
  await page.locator('.playlist-url').last().fill(url);
  await page.locator('.playlist-url').last().blur();
}

test('playlist loading stays in the foreground and reports parsed channel counts', async ({ page }, testInfo) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const secondSource = new Promise<void>(resolve => { started = resolve; });
  await page.route('http://host/a', route => route.fulfill({
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/1\n#EXTINF:-1,Bravo\nhttp://host/2\n',
  }));
  await page.route('http://host/b', async route => {
    started();
    await waiting;
    await route.fulfill({
      contentType: 'application/x-mpegurl',
      body: '#EXTM3U\n#EXTINF:-1,Charlie\nhttp://host/3\n',
    });
  });
  await page.goto('/');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#save-settings')).toHaveCount(0);
  await addPlaylist(page, 'http://host/a');
  await addPlaylist(page, 'http://host/b');
  await page.locator('#load-playlists').hover();
  await page.screenshot({ path: testInfo.outputPath('midnight-playlist-sources.png') });
  await page.locator('#load-playlists').click();
  try {
    await secondSource;
    await expect(page.locator('#loading-text')).toHaveText('Loading channels… 2 processed, 2 kept');
    await expect(page.locator('#view-settings')).toBeHidden();
    await expect(page.locator('#view-channels')).toBeHidden();
    expect(await page.evaluate(() =>
      !!document.elementFromPoint(960, 540)?.closest('#view-loading'))).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('b');
    await expect(page.locator('#view-loading')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('midnight-playlist-progress.png') });
  } finally {
    release();
  }
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(3);
});

test('settings save immediately and Close keeps the new values', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-settings-target="playback"]').click();
  await page.locator('#live-preview-setting [data-value="on"]').click();
  expect(await page.evaluate(() => localStorage.getItem('iptv_live_preview'))).toBe('true');
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.locator('[data-settings-target="subtitles"]').click();
  await page.locator('#assrt-key').fill('token1');
  await page.locator('#cancel-settings').click();
  await enterTab(page, 'settings');
  await expect(page.locator('#assrt-key')).toHaveValue('token1');
  await expect(page.locator('#live-preview-setting .active')).toHaveAttribute('data-value', 'on');
});

test('every theme needs double activation and browsing never previews it', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('[data-settings-target="appearance"]').click();
  const ids = await page.locator('.theme-swatch').evaluateAll(elements =>
    elements.map(el => el.getAttribute('data-theme-id')!));
  let selected = 'midnight';
  for (const id of ids) {
    const swatch = page.locator(`[data-theme-id="${id}"]`);
    await swatch.hover();
    await expect(page.locator('html')).toHaveAttribute('data-theme', selected);
    await swatch.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', selected);
    await swatch.click();
    selected = id;
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    await expect(swatch).toHaveClass(/active/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_theme')!))).toBe(id);
    await page.screenshot({ path: testInfo.outputPath(`${id}-settings.png`) });
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', selected);
});

test('remote focus leaves the theme unchanged until two OK presses', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-settings-target="appearance"]').click();
  const swatch = page.locator('[data-theme-id="amethyst"]');
  await swatch.evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'amethyst');
});
