import { test, expect, enterTab, neuterVideo, type Page } from './helpers';

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

// A gate that can close again after it opened.
function rearmable(): { wait: () => Promise<void>; open: () => void; close: () => void } {
  let current = gate();
  return {
    wait: () => current.promise,
    open: () => current.open(),
    close: () => { current = gate(); },
  };
}

// One Xtream account whose channels and second movie category / series wait
// for the test, so the load stays in progress as long as it needs. Both
// start open; a test closes them before the load it watches.
async function xtreamHarness(page: Page) {
  const channels = rearmable();
  const catalog = rearmable();
  channels.open();
  catalog.open();
  await neuterVideo(page);
  await page.addInitScript(() => {
    if (localStorage.getItem('iptv_playlists')) return;
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1', name: 'Alpha', url: 'http://host:8101', source: 'xtream',
      xtream: { username: 'u', password: 'p', liveOutput: 'ts' },
    }]));
    localStorage.setItem('iptv_playlist_refresh_interval_hours', '0');
    localStorage.setItem('iptv_epg_refresh_interval_hours', '0');
  });
  await page.route('http://host:8101/**', async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action') || url.pathname;
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/get.php') {
      await channels.wait();
      return route.fulfill({
        contentType: 'application/x-mpegurl',
        body: '#EXTM3U\n'
          + '#EXTINF:-1 tvg-id="ch1" group-title="Group 1",Channel 1\nhttp://host:8101/live/u/p/1.ts\n'
          + '#EXTINF:-1 tvg-id="ch2" group-title="Group 1",Channel 2\nhttp://host:8101/live/u/p/2.ts\n',
      });
    }
    if (url.pathname === '/xmltv.php') return route.fulfill({ contentType: 'application/xml', body: '<tv></tv>' });
    if (action === 'get_live_streams') {
      return json([1, 2].map(id => ({ stream_id: id, name: `Channel ${id}`, category_id: '1' })));
    }
    if (action === 'get_vod_categories') {
      return json([{ category_id: '1', category_name: 'Group 1' }, { category_id: '2', category_name: 'Group 2' }]);
    }
    if (action.endsWith('_categories')) return json([{ category_id: '1', category_name: 'Group 1' }]);
    if (action === 'get_vod_streams') {
      const category = url.searchParams.get('category_id') ?? '1';
      if (category === '2') await catalog.wait();
      return json([{ stream_id: Number(category), name: `Movie ${category}`, category_id: category, container_extension: 'mp4' }]);
    }
    if (action === 'get_series') {
      await catalog.wait();
      return json([{ series_id: 1, name: 'Series 1', category_id: '1' }]);
    }
    return json({ user_info: { auth: 1, status: 'Active' }, server_info: {} });
  });
  return {
    releaseChannels: channels.open,
    holdChannels: channels.close,
    releaseCatalog: catalog.open,
    holdCatalog: catalog.close,
  };
}

async function cachedCatalogKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('iptv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('catalog-cache').objectStore('catalog-cache').getAllKeys();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        open.result.close();
        resolve(request.result.map(String));
      };
    };
  }));
}

const panel = (page: Page) => page.locator('.load-progress-prompt');
const value = (page: Page, part: string) =>
  panel(page).locator(`.load-progress-row[data-part="${part}"] .load-progress-value`);

// Launches with everything cached, then opens Settings with the given parts
// held, ready for the load the test starts there.
async function settingsWithHeldLoad(page: Page, hold: { channels: boolean }) {
  const harness = await xtreamHarness(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel 2']);
  await expect.poll(() => cachedCatalogKeys(page)).toEqual(expect.arrayContaining(['x1|vod_all', 'x1|series_all']));
  await enterTab(page, 'settings');
  harness.holdCatalog();
  if (hold.channels) harness.holdChannels();
  return harness;
}

test('launch keeps the loading screen and never shows the panel', async ({ page }) => {
  const harness = await xtreamHarness(page);
  harness.holdCatalog();
  await page.goto('/');

  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel 2']);
  // Well past the panel's show delay, with the catalogs still loading.
  await page.waitForTimeout(2500);
  await expect(panel(page)).toHaveCount(0);

  harness.releaseCatalog();
  await expect.poll(() => cachedCatalogKeys(page)).toEqual(expect.arrayContaining(['x1|vod_all', 'x1|series_all']));
  await expect(panel(page)).toHaveCount(0);
});

test('shows each part of a playlist reload from Settings and closes on its own once all finish', async ({ page }) => {
  const harness = await settingsWithHeldLoad(page, { channels: false });
  await page.locator('#load-playlists').click();

  await expect(panel(page)).toBeVisible({ timeout: 10000 });
  await expect(panel(page).locator('.load-progress-label')).toHaveText(['Channels', 'Movies', 'Series']);
  await expect(value(page, 'channels')).toHaveText('100%');
  await expect(value(page, 'movies')).toHaveText('50%');
  await expect(value(page, 'series')).toHaveText('0%');
  await expect(panel(page).locator('[data-key="dismiss"]')).toHaveClass(/focused/);

  harness.releaseCatalog();
  await expect(panel(page)).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect.poll(() => cachedCatalogKeys(page)).toEqual(expect.arrayContaining(['x1|vod_all', 'x1|series_all']));
});

test('sends a load to the background and keeps the app usable while it finishes', async ({ page }) => {
  const harness = await settingsWithHeldLoad(page, { channels: true });
  await page.locator('#load-playlists').click();

  await expect(panel(page)).toBeVisible({ timeout: 10000 });
  await expect(value(page, 'channels')).toHaveText('0%');
  await page.keyboard.press('Escape');

  // Live opens at once, its list waiting for the channels.
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#view-loading')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('#view-channels .empty-state')).toHaveText('Loading…');
  await expect(page.locator('.tab-bar-item.focused')).toHaveAttribute('data-section', 'live');

  // Movies opens while the channels and the catalogs still load.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  harness.releaseChannels();
  await expect(page.locator('.toast').filter({ hasText: '2 channels loaded' })).toBeVisible();
  // The channels landing neither moves the user nor brings the panel back.
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(panel(page)).toBeHidden();

  harness.releaseCatalog();
  await expect.poll(() => cachedCatalogKeys(page)).toEqual(expect.arrayContaining(['x1|vod_all', 'x1|series_all']));
  await expect(panel(page)).toBeHidden();

  await enterTab(page, 'live');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel 2']);
});

test('shows the progress of an account loaded from Settings', async ({ page }) => {
  const harness = await settingsWithHeldLoad(page, { channels: false });
  const load = page.locator('.xtream-card .load-xtream');
  await expect(load).toHaveText('Update');
  await load.click();

  await expect(panel(page)).toBeVisible({ timeout: 10000 });
  await expect(panel(page).locator('.load-progress-label')).toHaveText(['Channels', 'Movies', 'Series']);
  await expect(value(page, 'channels')).toHaveText('100%');
  await expect(value(page, 'movies')).toHaveText('50%');
  await expect(value(page, 'series')).toHaveText('0%');

  harness.releaseCatalog();
  await expect(panel(page)).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(load).toHaveText('Update', { timeout: 10000 });
});
