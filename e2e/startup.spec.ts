import {
  test,
  expect,
  routePlaylist,
  seedPlaylist,
  PLAYLIST_URL,
  SAMPLE_M3U,
  neuterVideo,
  routeLiveManifest,
  type Page,
} from './helpers';

interface StartupProbe {
  starts: number;
  loadingAtStart: boolean[];
  subscriptions: number;
  subscriptionCancellations: number;
  activities: Array<{ name: string; method: string; replace: boolean }>;
}

async function installStartupHarness(
  page: Page,
  options: { visibility?: DocumentVisibilityState; devMode?: boolean } = {},
): Promise<void> {
  await page.route('http://127.0.0.1:9999/setup-state', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"updated":true}' }));
  await page.addInitScript(({ initialVisibility, devMode }) => {
    type Cb = (resp: unknown) => void;
    type LunaParameters = {
      activity?: { name?: string; callback?: { method?: string } };
      replace?: boolean;
    };
    const probe: StartupProbe = {
      starts: 0,
      loadingAtStart: [],
      subscriptions: 0,
      subscriptionCancellations: 0,
      activities: [],
    };
    const pendingStarts: Cb[] = [];
    let visibility = initialVisibility;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });

    const win = window as unknown as {
      __startupProbe__?: StartupProbe;
      __releaseServiceStart__?: () => void;
      __showApp__?: () => void;
      __hideApp__?: () => void;
      PalmServiceBridge?: unknown;
    };
    win.__startupProbe__ = probe;
    win.__releaseServiceStart__ = () => {
      for (const callback of pendingStarts.splice(0)) {
        callback({ running: true, port: 9999, localToken: '1'.repeat(64) });
      }
    };
    win.__showApp__ = () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    win.__hideApp__ = () => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private subscription = false;
      private cancelled = false;

      private respond(response: unknown): void {
        setTimeout(() => {
          if (!this.cancelled) this.onservicecallback?.(JSON.stringify(response));
        }, 0);
      }

      call(uri: string, payload: string): void {
        if ((window as any).__keymanagerMock(uri, payload, response => this.onservicecallback?.(response))) return;
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as LunaParameters;
        this.subscription = method === 'serviceEvents';
        if (method === 'start') {
          probe.starts++;
          const loading = document.querySelector<HTMLElement>('#view-loading');
          probe.loadingAtStart.push(loading !== null
            && loading.style.display !== 'none'
            && !loading.classList.contains('hidden'));
          pendingStarts.push((response) => this.respond(response));
        } else if (method === 'serviceEvents') {
          probe.subscriptions++;
          this.respond({ subscribed: true });
        } else if (method === 'getDevMode') {
          this.respond({ devmode: devMode });
        } else if (method === 'create') {
          const activity = parameters.activity;
          probe.activities.push({
            name: activity?.name ?? '',
            method: activity?.callback?.method ?? '',
            replace: parameters.replace === true,
          });
          this.respond({ returnValue: true });
        } else if (method !== 'stop') {
          this.respond({ returnValue: false, errorText: `unmocked method: ${method}` });
        }
      }

      cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        if (this.subscription) probe.subscriptionCancellations++;
      }
    }
    win.PalmServiceBridge = FakePalmServiceBridge;
  }, {
    initialVisibility: options.visibility ?? 'visible',
    devMode: options.devMode ?? false,
  });
}

async function releaseServiceStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __releaseServiceStart__: () => void })
      .__releaseServiceStart__();
  });
}

async function startupProbe(page: Page): Promise<StartupProbe> {
  return page.evaluate(() =>
    (window as unknown as { __startupProbe__: StartupProbe }).__startupProbe__);
}

test('channels render while service startup is pending without duplicate work', async ({ page }) => {
  let uploadLists = 0;
  await page.route('http://127.0.0.1:9999/uploads', (route) => {
    uploadLists++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
  await routePlaylist(page);
  await seedPlaylist(page);
  await installStartupHarness(page, { visibility: 'hidden' });

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  expect(await startupProbe(page)).toMatchObject({
    starts: 1,
    loadingAtStart: [false],
    subscriptions: 0,
  });

  await page.evaluate(() => {
    (window as unknown as { __showApp__: () => void }).__showApp__();
  });
  expect(await startupProbe(page)).toMatchObject({ starts: 1, subscriptions: 0 });

  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).subscriptions).toBe(1);
  await expect.poll(() => uploadLists).toBe(1);
  await page.waitForTimeout(250);
  expect(await startupProbe(page)).toMatchObject({ starts: 1, subscriptions: 1 });
  expect(uploadLists).toBe(1);
});

test('service event subscription is replaced across background restarts', async ({ page }) => {
  await page.route('http://127.0.0.1:9999/uploads', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await routePlaylist(page);
  await seedPlaylist(page);
  await installStartupHarness(page);

  await page.goto('/');
  await expect.poll(async () => (await startupProbe(page)).starts).toBe(1);
  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).subscriptions).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __hideApp__: () => void }).__hideApp__();
  });
  await expect.poll(async () =>
    (await startupProbe(page)).subscriptionCancellations).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __showApp__: () => void }).__showApp__();
  });
  await expect.poll(async () => (await startupProbe(page)).starts).toBe(2);
  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).subscriptions).toBe(2);
  expect(await startupProbe(page)).toMatchObject({
    subscriptionCancellations: 1,
  });
});

test('uploaded-only startup enters channels after background reconciliation', async ({ page }) => {
  await page.route('http://127.0.0.1:9999/uploads', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'ch1',
        name: 'Playlist 1',
        count: 2,
        createdAt: 1,
        url: 'http://127.0.0.1:9999/uploads/ch1.m3u',
      }]),
    }));
  await page.route('http://127.0.0.1:9999/uploads/ch1.m3u', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: SAMPLE_M3U,
    }));
  await installStartupHarness(page);

  await page.goto('/');
  await expect(page.locator('#view-settings')).toBeVisible();
  await releaseServiceStart(page);

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-item')).toHaveCount(2);
});

test('dev-mode query replaces the reminder fallback activity', async ({ page }) => {
  await page.route('http://127.0.0.1:9999/uploads', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: '8a9c7c8b',
      channelName: 'Alpha',
      title: 'Bravo',
      startMs: now + 60000,
      stopMs: now + 120000,
    }]));
  });
  await installStartupHarness(page, { devMode: true });

  await page.goto('/');
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(1);
  expect((await startupProbe(page)).activities[0].method)
    .toBe('luna://com.webos.notification/createToast');

  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(2);
  const [fallback, devAlert] = (await startupProbe(page)).activities;
  expect(devAlert.name).toBe(fallback.name);
  expect(fallback.replace).toBe(true);
  expect(devAlert.replace).toBe(true);
  expect(devAlert.method).toBe('luna://com.ikhaled.iptv.service/fireReminderAlert');
});

test('an expired playlist cache boots at once and refreshes in the background', async ({ page }) => {
  const freshM3U = SAMPLE_M3U.replace('Channel Two', 'Channel Three');
  let playlistRequests = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  // Seed once: re-seeding on reload would assign a new source id and change
  // the cache's source signature, turning the reload into a cache miss.
  await page.addInitScript((url) => {
    if (!localStorage.getItem('iptv_playlists') && !localStorage.getItem('iptv_sealed_local_v1')) {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'Test', url }]));
    }
  }, PLAYLIST_URL);
  await page.route('**/playlist.m3u', async (route) => {
    playlistRequests++;
    if (playlistRequests > 1) await refreshGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: playlistRequests === 1 ? SAMPLE_M3U : freshM3U,
    });
  });

  try {
    await page.goto('/');
    const names = page.locator('.channel-main .channel-name');
    await expect(names).toHaveText(['Channel One', 'Channel Two']);

    // The parsed-playlist write is deferred, so wait for it before ageing it.
    await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open('iptv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('playlist-cache', 'readonly');
        const store = tx.objectStore('playlist-cache');
        let aged = false;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          aged = true;
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve(aged);
        };
        tx.onerror = () => reject(tx.error);
      };
    }))).toBe(true);

    await page.clock.setSystemTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    await page.reload();
    await expect(names).toHaveText(['Channel One', 'Channel Two']);
    await expect.poll(() => playlistRequests).toBe(2);

    releaseRefresh();
    await expect(names).toHaveText(['Channel One', 'Channel Three']);
  } finally {
    releaseRefresh();
  }
});

for (const autoPlay of [false, true]) {
  test(`saved channels are interactive before a slow saved guide restores${autoPlay ? ' with auto-play' : ''}, without downloading again`, async ({ page }) => {
    let playlistRequests = 0;
    let guideRequests = 0;
    await neuterVideo(page);
    await routeLiveManifest(page);
    await page.clock.setFixedTime(new Date('2026-10-25T12:00:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_log_level', 'info');
      if (!localStorage.getItem('iptv_playlists')) {
        localStorage.setItem('iptv_playlists', JSON.stringify([
          { id: 'p1', name: 'Alpha', url: 'http://host/playlist.m3u' },
        ]));
      }
    });
    await page.route('http://host/playlist.m3u', route => {
      playlistRequests++;
      return playlistRequests > 1 ? route.abort() : route.fulfill({
        contentType: 'application/x-mpegurl',
        body: '#EXTM3U url-tvg="http://host/guide.xml"\n'
          + '#EXTINF:-1 tvg-id="ch1",Alpha\nhttp://host/a.m3u8\n'
          + '#EXTINF:-1 tvg-id="ch2",Bravo\nhttp://host/b.m3u8',
      });
    });
    await page.route('http://host/guide.xml', route => {
      guideRequests++;
      return guideRequests > 1 ? route.abort() : route.fulfill({
        contentType: 'application/xml',
        body: '<tv><channel id="ch1"><display-name>Alpha</display-name></channel>'
          + '<programme channel="ch1" start="20261025110000 +0000" stop="20261025130000 +0000">'
          + '<title>Saved Program</title></programme></tv>',
      });
    });
    const stored = page.waitForEvent('console', message =>
      message.text().includes('event=playlist.cache.write.completed'));
    await page.goto('/');
    await expect(page.locator('.channel-main .channel-now').first()).toHaveText('Saved Program');
    await stored;

    await page.addInitScript((autoPlay) => {
      if (autoPlay) localStorage.setItem('iptv_auto_play', 'true');
      const get = IDBObjectStore.prototype.get;
      const releases: Array<() => void> = [];
      const win = window as unknown as { releaseGuide: () => void; guideRead: boolean };
      win.releaseGuide = () => releases.splice(0).forEach(release => release());
      win.guideRead = false;
      IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
        const request = get.call(this, key);
        if (this.name !== 'epg-cache') return request;
        const held = {} as IDBRequest;
        request.onsuccess = event => {
          Object.defineProperty(held, 'result', { value: request.result });
          win.guideRead = true;
          releases.push(() => held.onsuccess?.call(held, event));
        };
        return held;
      };
    }, autoPlay);
    await page.reload();
    try {
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { guideRead: boolean }).guideRead)).toBe(true);
      await expect(page.locator('#view-loading')).toBeHidden();
      const rows = page.locator('.channel-main .channel-item');
      await expect(rows.locator('.channel-name')).toHaveText(['Alpha', 'Bravo']);
      if (autoPlay) {
        await expect(page.locator('#view-player')).toBeVisible();
        await expect(page.locator('#player-osd')).toBeVisible();
        await expect(page.locator('.osd-programme-title')).toHaveCount(0);
      } else {
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(1)).toHaveClass(/focused/);
      }
      expect(playlistRequests).toBe(1);
      expect(guideRequests).toBe(1);
    } finally {
      await page.evaluate(() => (window as unknown as { releaseGuide: () => void }).releaseGuide());
    }
    await expect(page.locator('.channel-main .channel-now').first()).toHaveText('Saved Program');
    if (autoPlay) {
      await expect(page.locator('.osd-programme-title')).toHaveText('Saved Program');
    } else {
      await expect(page.locator('.channel-main .channel-item').nth(1)).toHaveClass(/focused/);
    }
    expect(playlistRequests).toBe(1);
    expect(guideRequests).toBe(1);
  });
}
