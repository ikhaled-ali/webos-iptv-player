import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  assertGroupBenchmarkScale,
  assertColdLoadBenchmark,
  assertM3USearchBenchmark,
  assertParentalBenchmark,
  assertPointerBenchmark,
  assertStartupHoverBenchmark,
  assertRetainedMemory,
  assertXMLTVCatalogBenchmark,
  assertBenchmarkScale,
  buildM3UFixture,
  buildXMLTVPipelineFixture,
  cleanupBenchmarkFixture,
  installBenchmarkFixture,
  installColdLoadFixture,
  installM3USearchFixture,
  installUniqueGroupFixture,
  inspectPointerBenchmark,
  measureDerivedIndexBenchmark,
  measureStartupHoverBenchmark,
  measureLargePlaylistMemory,
  largePlaylistCategoryFilter,
  largePlaylistFilteredChannels,
  preparePointerBenchmark,
  rebuildBenchmarkDatabase,
  runGroupBenchmark,
  runM3USearchBenchmark,
  runParentalBenchmark,
  measureXMLTVPipelineComparison,
  measureXMLTVCatalogBenchmark,
  runRawParserBenchmarks,
  runBenchmarkSuites,
  runViewReopenCycle,
  summarizeRetainedMemory,
} from './benchmark-suite.mjs';
import type { LargePlaylistBenchmarkOptions } from './benchmark-suite.mjs';

const SCALE = Number(process.env.BENCHMARK_SCALE ?? '50000');
const KEY_SAMPLES = Number(process.env.BENCHMARK_KEY_SAMPLES ?? '30');
const QUERY_SAMPLES = Number(process.env.BENCHMARK_QUERY_SAMPLES ?? '5');
const CPU_RATE = Number(process.env.BENCHMARK_CPU_RATE ?? '4');
const FIXTURE = {
  scale: SCALE,
  accountId: 'benchmark-x1',
  epgUrl: 'http://host/benchmark-epg',
  backupKey: '__tv_benchmark_backup__',
  directStorage: true,
};
const COLD_PLAYLIST_URL = 'http://host/cold-list.m3u';
const XMLTV_PIPELINE_URL = 'http://host/benchmark-guide.xml.gz';
const LARGE_PLAYLIST_ENTRIES = positiveIntegerEnv(
  'BENCHMARK_LARGE_PLAYLIST_ENTRIES',
  400_000,
);
const LARGE_PLAYLIST_LIVE = positiveIntegerEnv(
  'BENCHMARK_LARGE_PLAYLIST_LIVE',
  50_000,
);
const LARGE_PLAYLIST = {
  totalEntries: LARGE_PLAYLIST_ENTRIES,
  liveEntries: LARGE_PLAYLIST_LIVE,
  playlistBytes: positiveIntegerEnv(
    'BENCHMARK_LARGE_PLAYLIST_BYTES',
    128 * 1024 * 1024,
  ),
  sampleIntervalMs: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_SAMPLE_MS', 25),
  chunkBytes: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_CHUNK_BYTES', 64 * 1024),
  chunkDelayMs: nonNegativeIntegerEnv('BENCHMARK_LARGE_PLAYLIST_CHUNK_DELAY_MS', 0),
  expectedChannels: positiveIntegerEnv(
    'BENCHMARK_LARGE_PLAYLIST_EXPECTED_CHANNELS',
    LARGE_PLAYLIST_LIVE,
  ),
  timeoutMs: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_TIMEOUT_MS', 600_000),
  accountId: 'benchmark-large-playlist',
};
const LARGE_PLAYLIST_FILTER = largePlaylistCategoryFilter();
const LARGE_PLAYLIST_FILTERED = {
  ...LARGE_PLAYLIST,
  liveCategories: LARGE_PLAYLIST_FILTER,
  expectedChannels: largePlaylistFilteredChannels(LARGE_PLAYLIST_LIVE, LARGE_PLAYLIST_FILTER),
};
const LARGE_PLAYLIST_ONLY = process.env.BENCHMARK_LARGE_PLAYLIST_ONLY === '1';

test('records 50,000-item application benchmarks', async ({
  browser,
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The benchmark uses Chromium heap metrics');
  if (LARGE_PLAYLIST_ONLY) {
    const result = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST);
    console.log(`Large playlist benchmark result: ${JSON.stringify(result)}`);
    const filtered = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST_FILTERED);
    console.log(`Filtered large playlist benchmark result: ${JSON.stringify(filtered)}`);
    return;
  }
  await page.route('**/benchmark-seed.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Benchmark seed</title>',
  }));
  await page.route('http://127.0.0.1:8890/**', (route) => route.abort());
  const coldPlaylist = buildM3UFixture(SCALE);
  const xmltvPipelineFixture = buildXMLTVPipelineFixture(SCALE);
  const compressedXMLTV = gzipSync(Buffer.from(xmltvPipelineFixture.text));
  await page.route('http://host/**', (route) => {
    const url = route.request().url();
    if (url === COLD_PLAYLIST_URL) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: coldPlaylist,
      });
    }
    if (url === XMLTV_PIPELINE_URL) {
      return route.fulfill({
        contentType: 'application/gzip',
        body: compressedXMLTV,
      });
    }
    if (/^\/\d+$/.test(new URL(url).pathname)) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n',
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => {
    // The suites read info-level events; the app logs only warnings by default.
    localStorage.setItem('iptv_log_level', 'info');
    // Lets the Search samples wait until the app worker has exited.
    const workers = { live: 0 };
    (window as unknown as { __benchmarkAppWorkers: typeof workers }).__benchmarkAppWorkers = workers;
    const log = console.log;
    console.log = function (...args: unknown[]) {
      if (args.indexOf('event=worker.lifecycle.created') !== -1) workers.live++;
      if (args.indexOf('event=worker.lifecycle.terminated') !== -1) {
        workers.live = Math.max(0, workers.live - 1);
      }
      return log.apply(this, args);
    };
    const error = console.error;
    console.error = function (...args: unknown[]) {
      if (args.indexOf('event=worker.lifecycle.failed') !== -1) {
        workers.live = Math.max(0, workers.live - 1);
      }
      return error.apply(this, args);
    };
  });
  await page.addInitScript(() => {
    const media = HTMLMediaElement.prototype;
    media.load = function () { /* no-op */ };
    media.play = function () { return Promise.resolve(); };
  });
  const cdp = await page.context().newCDPSession(page);
  if (CPU_RATE !== 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  }

  await page.goto('/benchmark-seed.html');
  await page.evaluate(rebuildBenchmarkDatabase);
  const fixtureStarted = Date.now();
  await addSeedBundle(page);
  await page.evaluate(installBenchmarkFixture, FIXTURE);
  const fixtureSetupMs = Date.now() - fixtureStarted;

  try {
    const startupStarted = Date.now();
    await page.goto('/');
    await expect(page.locator('#view-home')).toBeVisible();
    const startupHomeMs = Date.now() - startupStarted;
    await openLive(page);
    await expect(page.locator('.channel-main .channel-item').first()).toBeVisible();
    const startupReadyMs = Date.now() - startupStarted;
    const startupHover = await page.evaluate(measureStartupHoverBenchmark);
    assertStartupHoverBenchmark(startupHover);
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    const parsers = await page.evaluate(runRawParserBenchmarks, { scale: SCALE });
    await cdp.send('HeapProfiler.collectGarbage');
    const xmltvPipelineOptions = {
      url: XMLTV_PIPELINE_URL,
      compressedBytes: compressedXMLTV.byteLength,
      uncompressedBytes: Buffer.byteLength(xmltvPipelineFixture.text),
      channelIds: xmltvPipelineFixture.channelIds,
      channelNames: xmltvPipelineFixture.channelNames,
    };
    const xmltvPipelineIo = {
      evaluate: (fn: unknown, arg?: unknown) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      memoryUsed: () => cdp.send('Runtime.getHeapUsage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    };
    const xmltvPipeline = await measureXMLTVPipelineComparison(
      xmltvPipelineOptions,
      xmltvPipelineIo,
    );
    parsers.xmltvPipelineBuffered = xmltvPipeline.buffered;
    parsers.xmltvPipeline = xmltvPipeline.streaming;
    await cdp.send('HeapProfiler.collectGarbage');
    const suites = await page.evaluate(runBenchmarkSuites, {
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
    });
    suites.parsers = parsers;
    const pointer = await page.evaluate(preparePointerBenchmark);
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.up();
    const pointerReport = await page.evaluate(inspectPointerBenchmark);
    assertPointerBenchmark(pointerReport, SCALE);
    suites.interactions.magicRemote = pointerReport;

    await cdp.send('HeapProfiler.collectGarbage');
    const beforeReopen = await cdp.send('Runtime.getHeapUsage');
    const reopenHeap: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(runViewReopenCycle);
      await cdp.send('HeapProfiler.collectGarbage');
      reopenHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    }
    const retained = summarizeRetainedMemory(beforeReopen.usedSize, reopenHeap);
    assertRetainedMemory(retained);
    const heap = await cdp.send('Runtime.getHeapUsage');
    // Runs last of the in-page work: its multi-megabyte feed would otherwise
    // skew the reopen heap samples measured above.
    parsers.xmltvCatalog = await measureXMLTVCatalogBenchmark(SCALE, {
      evaluate: (fn, arg) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      heapUsed: async () => (await cdp.send('Runtime.getHeapUsage')).usedSize,
    });
    assertXMLTVCatalogBenchmark(parsers.xmltvCatalog);
    const parental = await runDesktopParentalBenchmark(page);
    assertParentalBenchmark(parental, SCALE);
    suites.parental = parental;
    await reloadWith(page, installM3USearchFixture);
    await openLive(page);
    suites.search.m3u = await page.evaluate(
      runM3USearchBenchmark,
      { querySamples: QUERY_SAMPLES },
    );
    assertM3USearchBenchmark(suites.search.m3u);
    console.log('Benchmark phase: groups');
    await installFromSeed(page, installUniqueGroupFixture, SCALE);
    const groupStartupStarted = Date.now();
    await page.goto('/');
    await openLive(page);
    const groups = await page.evaluate(runGroupBenchmark, { keySamples: KEY_SAMPLES });
    groups.startupMs = Date.now() - groupStartupStarted;
    assertGroupBenchmarkScale(groups, SCALE);
    suites.groups = groups;
    console.log('Benchmark phase: cold load');
    await installFromSeed(page, installColdLoadFixture, {
      accountId: FIXTURE.accountId,
      url: COLD_PLAYLIST_URL,
    });
    const coldStarted = performance.now();
    await page.goto('/');
    await openLive(page);
    await expect(page.locator('.channel-main .channel-item').first()).toBeVisible();
    // The All group's count: rows and grid tiles have different strides.
    await expect(page.locator('.group-item[data-group="builtin:all"] .group-count'))
      .toHaveText(String(SCALE), { timeout: 120_000 });
    const coldResult = await page.evaluate(() => ({
      rendered: document.querySelectorAll('.channel-main .channel-item').length,
      channels: Number(
        document.querySelector('.group-item[data-group="builtin:all"] .group-count')
          ?.textContent || 0,
      ),
    }));
    const coldLoad = {
      readyMs: Math.round((performance.now() - coldStarted) * 10) / 10,
      ...coldResult,
    };
    assertColdLoadBenchmark(coldLoad, SCALE);
    suites.coldLoad = coldLoad;
    console.log('Benchmark phase: large playlist');
    const largePlaylist = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST);
    const largePlaylistFiltered = await runDesktopLargePlaylistBenchmark(
      browser,
      LARGE_PLAYLIST_FILTERED,
    );
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    console.log('Benchmark phase: derived indexes');
    parsers.derivedIndexes = await measureDerivedIndexBenchmark(
      { scale: SCALE },
      {
        evaluate: (fn, arg) => page.evaluate(fn as never, arg),
        collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      },
    );
    assertBenchmarkScale(suites, SCALE);
    const report = {
      version: 1,
      target: 'desktop-chromium',
      generatedAt: new Date().toISOString(),
      scale: SCALE,
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
      cpuRate: CPU_RATE,
      browser: await page.evaluate(() => navigator.userAgent),
      fixtureSetupMs,
      suites: {
        startup: {
          homeMs: startupHomeMs,
          readyMs: startupReadyMs,
          rendered: suites.channelList.rendered,
          ...startupHover,
        },
        ...suites,
        memory: {
          usedHeapMiB: Math.round(heap.usedSize / 1_048_576 * 10) / 10,
          totalHeapMiB: Math.round(heap.totalSize / 1_048_576 * 10) / 10,
          retained,
          largePlaylist,
          largePlaylistFiltered,
        },
      },
    };
    const outputDir = path.join(process.cwd(), 'test-output', 'benchmarks');
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'latest.json');
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Benchmark report: ${outputPath}`);
  } finally {
    await page.goto('/benchmark-seed.html');
    await page.evaluate(cleanupBenchmarkFixture, {
      accountId: FIXTURE.accountId,
      epgUrl: FIXTURE.epgUrl,
      backupKey: FIXTURE.backupKey,
    });
  }
});

// The app opens on Home; the channel suites start from Live.
async function openLive(page: Page) {
  await expect(page.locator('#view-home:not(.hidden), #view-channels:not(.hidden)'))
    .toBeVisible({ timeout: 120_000 });
  if (await page.locator('#view-channels').isHidden()) {
    await page.locator('.tab-bar-item[data-section="live"]').click();
  }
  await expect(page.locator('#view-channels')).toBeVisible();
}

// Fixtures are written from a page without the app: a running app saves its
// own settings when it unloads, which would overwrite them before the reload.
async function installFromSeed<T>(page: Page, install: (arg: T) => unknown, arg?: T) {
  await page.goto('/benchmark-seed.html');
  await addSeedBundle(page);
  // A stuck IndexedDB request would otherwise hold the test until its timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Fixture install ${install.name} stalled`)), 120_000);
  });
  try {
    await Promise.race([page.evaluate(install as never, arg), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function addSeedBundle(page: Page) {
  await page.addScriptTag({
    content: await readFile('test-output/benchmarks/seed-bundle.js', 'utf8'),
  });
}

async function reloadWith(page: Page, install: () => unknown) {
  await installFromSeed(page, install);
  await page.goto('/');
}

// The PIN is set through the UI, and parental controls are turned off again
// afterwards so the later suites run without them. The TV uses runParental
// in tv-runner.mjs, which restores the device's own record.
async function runDesktopParentalBenchmark(page: Page) {
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
  const report = await page.evaluate(runParentalBenchmark, { keySamples: KEY_SAMPLES });
  await page.locator('[data-parental-tab="options"]').click();
  const power = page.locator('#view-parental-controls .source-toggle');
  await power.click();
  await expect(power).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-parental-back]').click();
  return report;
}

async function runDesktopLargePlaylistBenchmark(
  browser: Browser,
  options: LargePlaylistBenchmarkOptions,
) {
  const context = await browser.newContext({
    baseURL: `http://localhost:${process.env.PREVIEW_PORT || 3000}`,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await context.newPage();
    const browserCdp = await browser.newBrowserCDPSession();
    const pageCdp = await context.newCDPSession(page);
    return await measureLargePlaylistMemory(options, {
      page,
      browserCdp,
      pageCdp,
      collectGarbage: () => pageCdp.send('HeapProfiler.collectGarbage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    });
  } finally {
    await context.close();
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
