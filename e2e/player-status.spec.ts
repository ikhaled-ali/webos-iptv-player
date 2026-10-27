import { THEMES } from '../src/config/themes';
import { test, expect, neuterVideo, routePlaylist, seedPlaylist } from './helpers';

for (const overlay of ['dark', 'frosted']) {
  test(`playback status stays small, white and bottom-left with ${overlay} overlays`, async ({ page }, testInfo) => {
    await neuterVideo(page);
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.addInitScript(style => {
      localStorage.setItem('iptv_overlay_style', JSON.stringify(style));
      localStorage.setItem('iptv_live_reconnect_attempts', '1');
    }, overlay);
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();
    await page.keyboard.press('Enter');
    const status = page.locator('.player-status');
    await expect(status).toHaveAttribute('data-state', 'loading');
    await page.locator('#video-player').dispatchEvent('playing');
    await expect(status).toBeHidden();
    await page.locator('#video-player').dispatchEvent('waiting');
    await expect(status).toHaveAttribute('data-state', 'buffering');

    for (const state of ['buffering', 'error']) {
      if (state === 'error') {
        await page.locator('#video-player').evaluate(video => {
          video.dataset.originalStream = 'true';
          video.dispatchEvent(new Event('error'));
        });
        await expect(status).toHaveAttribute('data-state', 'reconnecting');
        await expect(page.locator('#video-player')).not.toHaveAttribute('data-original-stream', 'true');
        await page.locator('#video-player').dispatchEvent('error');
        await expect(status).toHaveAttribute('data-state', 'error');
      }
      for (const theme of THEMES) {
        for (const size of [80, 100, 150]) {
          await page.locator('#view-player').dispatchEvent('mousemove', { clientX: 1800 + size, clientY: 10 });
          await page.evaluate(({ themeId, textSize }) => {
            document.documentElement.dataset.theme = themeId;
            document.documentElement.dataset.textSize = String(textSize);
          }, { themeId: theme.id, textSize: size });
          const metrics = await status.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const osd = document.querySelector('#player-osd')!;
            return {
              left: rect.left,
              bottom: innerHeight - rect.bottom,
              height: rect.height,
              width: rect.width,
              background: style.backgroundColor,
              border: style.borderTopWidth,
              shadow: style.boxShadow,
              pointerEvents: style.pointerEvents,
              textSize: getComputedStyle(element.querySelector('.player-status-text')!).fontSize,
              colors: Array.from(element.children, child => getComputedStyle(child).color),
              osdGap: rect.top - osd.getBoundingClientRect().bottom,
            };
          });
          expect(metrics.left).toBe(40);
          expect(metrics.bottom).toBe(20);
          expect(metrics.height).toBeCloseTo(28 * size / 100, 0);
          expect(metrics.width).toBeLessThanOrEqual(1840);
          expect(metrics.background).toBe('rgba(0, 0, 0, 0)');
          expect(metrics.border).toBe('0px');
          expect(metrics.shadow).toBe('none');
          expect(metrics.pointerEvents).toBe('none');
          expect(metrics.textSize).toBe(`${20 * size / 100}px`);
          expect(metrics.colors.every(color => color === 'rgb(255, 255, 255)')).toBe(true);
          expect(metrics.osdGap).toBeGreaterThanOrEqual(19);
          if (size === 100) {
            await page.screenshot({ path: testInfo.outputPath(`${theme.id}-${overlay}-${state}.png`) });
          }
        }
      }
    }
    await page.locator('#video-player').dispatchEvent('playing');
    await expect(status).toBeHidden();
    await expect(page.locator('#player-osd')).toHaveCSS('bottom', '20px');
  });
}
