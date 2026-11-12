import { test, expect, SAMPLE_M3U } from './helpers';

// A stand-in for the browser's speech recognition: it listens until the test
// says something through window.__voiceSay.
async function stubSpeech(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler = ((e: unknown) => void) | null;
    const w = window as unknown as {
      webkitSpeechRecognition?: unknown;
      __voiceSay?: (text: string) => void;
      __voiceStarts?: number;
    };
    w.__voiceStarts = 0;
    class FakeRecognizer {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: Handler = null;
      onerror: Handler = null;
      onend: (() => void) | null = null;
      start(): void {
        w.__voiceStarts = (w.__voiceStarts ?? 0) + 1;
        w.__voiceSay = (text: string) => {
          this.onresult?.({ results: [[{ transcript: text }]] });
          this.onend?.();
        };
      }
      abort(): void {
        w.__voiceSay = undefined;
      }
    }
    w.webkitSpeechRecognition = FakeRecognizer;
  });
}

async function seedPlaylist(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { name: 'P', url: 'http://host/playlist.m3u' },
    ]));
  });
}

test('the mic listens under a tooltip, shows the results, and keeps the keys', async ({ page }) => {
  await stubSpeech(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

  const mic = page.locator('.tab-bar-item[data-key="voice"]');
  const tip = page.locator('.tab-bar-voice-tip');
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 8 && !(await mic.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(mic).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('Enter');
  await expect(tip).toHaveText('Listening…');
  // The box opens without its caret; the keys stay on the mic.
  await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(1);
  await expect(page.locator('.tab-bar-search-input')).not.toBeFocused();
  await expect(mic).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  await page.evaluate(() => (window as unknown as { __voiceSay: (t: string) => void }).__voiceSay('one'));
  await expect(tip).toHaveCount(0);
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(page.locator('.tab-bar-search-input')).toHaveValue('one');
  await expect(page.locator('#view-search')).toContainText('Channel One');
  await expect(mic).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  // OK again listens again without leaving the mic; moving off it stops.
  await page.keyboard.press('Enter');
  await expect(tip).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voiceStarts: number }).__voiceStarts)).toBe(2);
  await page.keyboard.press('ArrowRight');
  await expect(tip).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="settings"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('with no way to listen, the box shows the remote-mic hint and the mic keeps the keys', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown };
    delete w.webkitSpeechRecognition;
    delete w.SpeechRecognition;
  });
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

  const mic = page.locator('.tab-bar-item[data-key="voice"]');
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 8 && !(await mic.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Enter');

  // The answer comes back before listening is recorded; it must still land.
  await expect(page.locator('.tab-bar-voice-tip')).toHaveCount(0);
  await expect(page.locator('.tab-bar-search-input')).toHaveAttribute('placeholder', 'Hold the mic button on your remote');
  await expect(page.locator('.tab-bar-search-input')).not.toBeFocused();
  await expect(mic).toHaveClass(/\bfocused\b/);
  await expect(mic).not.toHaveClass(/\blistening\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});
