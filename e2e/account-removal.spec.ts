import { test, expect, enterTab, neuterVideo, routePlaylist, PLAYLIST_URL, type Page } from './helpers';

const M3U = '#EXTM3U\n#EXTINF:-1 tvg-id="p" group-title="Group P",Channel P\nhttp://host.example.com/p.m3u8\n';

// One Xtream account beside one M3U playlist.
async function harness(page: Page): Promise<void> {
  await neuterVideo(page);
  await routePlaylist(page, M3U);
  await page.addInitScript((playlistUrl) => {
    if (localStorage.getItem('iptv_playlists')) return;
    localStorage.setItem('iptv_playlists', JSON.stringify([
      {
        id: 'x1', name: 'Alpha', url: 'http://host:8101', source: 'xtream',
        xtream: { username: 'u', password: 'p', liveOutput: 'ts' },
      },
      { id: 'p1', name: 'Bravo', url: playlistUrl },
    ]));
    localStorage.setItem('iptv_playlist_refresh_interval_hours', '0');
    localStorage.setItem('iptv_epg_refresh_interval_hours', '0');
  }, PLAYLIST_URL);
  await page.route('http://host:8101/**', async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action') || url.pathname;
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/get.php') {
      return route.fulfill({
        contentType: 'application/x-mpegurl',
        body: '#EXTM3U\n#EXTINF:-1 tvg-id="ch1" group-title="Group 1",Channel 1\nhttp://host:8101/live/u/p/1.ts\n',
      });
    }
    if (url.pathname === '/xmltv.php') return route.fulfill({ contentType: 'application/xml', body: '<tv></tv>' });
    if (action === 'get_live_streams') return json([{ stream_id: 1, name: 'Channel 1', category_id: '1' }]);
    if (action.endsWith('_categories')) return json([{ category_id: '1', category_name: 'Group 1' }]);
    if (action === 'get_vod_streams') return json([{ stream_id: 1, name: 'Movie 1', category_id: '1', container_extension: 'mp4' }]);
    if (action === 'get_series') return json([{ series_id: 1, name: 'Series 1', category_id: '1' }]);
    return json({ user_info: { auth: 1, status: 'Active' }, server_info: {} });
  });
}

async function catalogKeys(page: Page): Promise<string[]> {
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

test('removing an Xtream account drops its channels, sections, and cached catalog at once', async ({ page }) => {
  await harness(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel P']);
  await expect.poll(() => catalogKeys(page)).toEqual(expect.arrayContaining(['x1|vod_all', 'x1|series_all']));

  await enterTab(page, 'settings');
  await page.locator('.xtream-card .remove-xtream').click();

  await expect(page.locator('.xtream-card')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="movies"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="series"]')).toHaveCount(0);
  await expect.poll(() => catalogKeys(page)).toEqual([]);

  await enterTab(page, 'live');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel P']);
});
