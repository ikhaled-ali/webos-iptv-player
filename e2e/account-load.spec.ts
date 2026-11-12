import { test, expect, enterTab, neuterVideo, type Page } from './helpers';
import { THEMES } from '../src/config/themes';

async function accountHarness(page: Page) {
  const requests: string[] = [];
  let failed = false;
  let release = () => {};
  let gate: Promise<void> | null = null;
  await neuterVideo(page);
  await page.clock.setFixedTime(new Date('2026-10-25T12:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_log_level', 'info');
    if (!localStorage.getItem('iptv_playlists')) {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1', name: 'Alpha', url: 'http://host:8101', source: 'xtream',
        xtream: { username: 'u', password: 'p', liveOutput: 'ts' },
      }]));
      localStorage.setItem('iptv_playlist_refresh_interval_hours', '0');
      localStorage.setItem('iptv_epg_refresh_interval_hours', '0');
    }
  });
  await page.route('http://host:*/**', async route => {
    const url = new URL(route.request().url());
    const id = url.port === '8101' ? '1' : '2';
    const action = url.searchParams.get('action') || url.pathname;
    requests.push(`${url.port}|${action}`);
    if (id === '2' && gate && url.pathname === '/get.php') await gate;
    if (id === '2' && failed) return route.abort();
    if (url.pathname === '/get.php') return route.fulfill({
      contentType: 'application/x-mpegurl',
      body: `#EXTM3U\n#EXTINF:-1 tvg-id="ch${id}" group-title="Group ${id}",Channel ${id}\nhttp://host:${url.port}/live/u/p/${id}.ts`,
    });
    if (url.pathname === '/xmltv.php') return route.fulfill({
      contentType: 'application/xml',
      body: `<tv><channel id="ch${id}"><display-name>Channel ${id}</display-name></channel>`
        + `<programme channel="ch${id}" start="20261025110000 +0000" stop="20261025130000 +0000"><title>Program ${id}</title></programme></tv>`,
    });
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'get_live_streams') return json([{ stream_id: Number(id), name: `Channel ${id}`, category_id: '1', epg_channel_id: `ch${id}` }]);
    if (action.endsWith('_categories')) return json([{ category_id: '1', category_name: 'Group 1' }]);
    if (action === 'get_vod_streams') return json([{ stream_id: Number(id), name: `Movie ${id}`, category_id: '1', container_extension: 'mp4' }]);
    if (action === 'get_series') return json([{ series_id: Number(id), name: `Series ${id}`, category_id: '1' }]);
    return json({ user_info: { auth: 1, status: 'Active' }, server_info: {} });
  });
  return {
    requests,
    hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { release(); gate = null; },
    fail: () => { failed = true; },
  };
}

test('loads and updates one account, preserves other sources, and remembers it after restarting', async ({ page }) => {
  const harness = await accountHarness(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1']);
  await enterTab(page, 'settings');
  await expect(page.locator('.load-xtream')).toHaveText('Update');
  await page.locator('#add-xtream').click();
  const card = page.locator('.xtream-card').last();
  await card.locator('.xtream-name').fill('Bravo');
  await card.locator('.xtream-url').fill('http://host:8102');
  await card.locator('.xtream-username').fill('u');
  await card.locator('.xtream-password').fill('p');
  await card.locator('.xtream-password').press('Tab');
  const button = card.locator('.load-xtream');
  await expect(button).toHaveText('Load');
  const before = harness.requests.length;
  harness.hold();
  const stored = page.waitForEvent('console', msg => msg.text().includes('event=playlist.cache.write.completed'));
  try {
    await button.click();
    await expect(button).toHaveText('Loading…');
    await page.keyboard.press('Enter');
    await expect(page.locator('#view-settings')).toBeVisible();
    harness.release();
    await expect(button).toHaveText('Update', { timeout: 15000 });
    await expect(button).toHaveClass(/focused/);
    await expect(card.locator('.xtream-status')).toBeEmpty();
    await stored;
    expect(harness.requests.slice(before).every(request => request.startsWith('8102|'))).toBe(true);
    expect(harness.requests.slice(before).filter(request => request.endsWith('|/get.php'))).toHaveLength(1);
    for (const endpoint of ['get_vod_streams', 'get_series', '/xmltv.php']) {
      expect(harness.requests.slice(before)).toContain(`8102|${endpoint}`);
    }
  } finally {
    harness.release();
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel 2']);
  const restart = harness.requests.length;
  await page.reload();
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel 2']);
  await enterTab(page, 'settings');
  await expect(page.locator('.load-xtream')).toHaveText(['Update', 'Update']);
  expect(harness.requests.length).toBe(restart);
  harness.fail();
  const retry = page.locator('.xtream-card').last();
  const beforeFailure = harness.requests.length;
  await retry.locator('.load-xtream').click();
  await expect(retry.locator('.xtream-status')).toContainText('Unable to connect', { timeout: 15000 });
  await expect(retry.locator('.load-xtream')).toHaveText('Update');
  expect(harness.requests.slice(beforeFailure).every(request => request.startsWith('8102|'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.channel-main .channel-name')).toHaveText(['Channel 1', 'Channel 2']);
  await enterTab(page, 'settings');
  harness.hold();
  try {
    const queued = page.locator('.xtream-card').first();
    await retry.locator('.load-xtream').click();
    await expect(retry.locator('.load-xtream')).toHaveText('Loading…');
    await queued.locator('.load-xtream').click();
    await expect(queued.locator('.load-xtream')).toHaveText('Loading…');
    harness.release();
    await expect(queued.locator('.load-xtream')).toHaveText('Update', { timeout: 15000 });
    await expect(queued.locator('.xtream-status')).toBeEmpty();
    await expect(retry.locator('.xtream-status')).toContainText('Unable to connect');
  } finally {
    harness.release();
  }
});

test('account actions fit every theme with large localized text', async ({ page }, testInfo) => {
  await accountHarness(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_locale', JSON.stringify('de'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await enterTab(page, 'settings');
  const button = page.locator('.load-xtream');
  await expect(button).toHaveText('Aktualisieren');
  await expect(page.locator('html')).toHaveAttribute('data-text-size', '150');
  await expect(page.locator('.toast')).not.toHaveClass(/visible/);
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  for (const theme of THEMES) {
    await page.evaluate(id => { document.documentElement.dataset.theme = id; }, theme.id);
    const fits = await page.locator('.xtream-card-foot').evaluate(foot => {
      const bounds = foot.getBoundingClientRect();
      return Array.from(foot.querySelectorAll('button')).every(control => {
        const rect = control.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
          && control.scrollWidth <= control.clientWidth + 1;
      });
    });
    expect(fits, theme.id).toBe(true);
    await page.screenshot({ path: `/private/tmp/iptv-account-${testInfo.project.name}-${theme.id}.png`, animations: 'disabled' });
  }
});
