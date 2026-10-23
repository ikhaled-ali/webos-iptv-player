import { test, expect, routePlaylist, seedPlaylist, enterTab, type Page } from './helpers';
import { readProtectedLocal } from './protected-storage';

async function openReset(page: Page): Promise<void> {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="data"]').click();
  await page.locator('#reset-app').click();
  await expect(page.locator('.confirmation-prompt:not(.hidden)')).toBeVisible();
}

test('reset waits for encrypted settings to commit before reloading', async ({ page }) => {
  await openReset(page);
  await page.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    (window as any).__resetPending = false;
    crypto.subtle.encrypt = (algorithm, key, data) => {
      if (new TextDecoder().decode(data) !== '{}') return encrypt(algorithm, key, data);
      (window as any).__resetPending = true;
      return new Promise((resolve, reject) => {
        (window as any).__releaseReset = () => { void encrypt(algorithm, key, data).then(resolve, reject); };
      });
    };
  });
  const earlyReload = page.waitForRequest(request => request.isNavigationRequest()
    && request.frame() === page.mainFrame(), { timeout: 1500 }).then(() => true, () => false);
  await page.locator('[data-confirm-action="confirm"]').click();
  try {
    expect(await earlyReload).toBe(false);
    expect(await page.evaluate(() => (window as any).__resetPending)).toBe(true);
    expect(await readProtectedLocal<unknown[]>(page, 'iptv_playlists')).toHaveLength(1);
  } finally {
    await page.evaluate(() => (window as any).__releaseReset?.()).catch(() => {});
  }
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect.poll(async () => (await readProtectedLocal(page, 'iptv_playlists')) ?? []).toEqual([]);
  await page.reload();
  await expect(page.locator('#view-settings')).toBeVisible();
  expect((await readProtectedLocal(page, 'iptv_playlists')) ?? []).toEqual([]);
});

test('failed encrypted reset preserves the saved settings and reports failure without reloading', async ({ page }) => {
  await openReset(page);
  await page.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (algorithm, key, data) => new TextDecoder().decode(data) === '{}'
      ? Promise.reject(new Error('Synthetic encryption failure'))
      : encrypt(algorithm, key, data);
  });
  let reloads = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) reloads++;
  });
  await page.locator('[data-confirm-action="confirm"]').click();
  await expect(page.locator('.toast.visible')).toContainText('Reset could not be completed');
  expect(reloads).toBe(0);
  expect(await readProtectedLocal<unknown[]>(page, 'iptv_playlists')).toHaveLength(1);
});
