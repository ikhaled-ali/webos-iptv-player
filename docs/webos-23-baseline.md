# webOS 23 baseline (Chromium 94)

The oldest supported TV is now webOS 23, which ships Chromium 94. webOS 22
and older (Chromium 87 and below, down to webOS 4's Chromium 53) are no
longer supported. This page records what the raised floor removed and what
still guards against newer APIs.

## One floor, three gates

`MIN_CHROME` in `scripts/compat-gate.mjs` is the floor. Everything else
follows it:

| Gate | Keyed to | Checks |
| --- | --- | --- |
| esbuild syntax target | `chrome${MIN_CHROME}` | Down-levels only syntax newer than Chromium 94 (none of `?.`, `??`, async/await, class fields, spread, logical assignment is rewritten any more). |
| Source lint (`npm run lint`) | `browserslist` in `package.json` (`chrome 94`) and `DENYLIST` | `eslint-plugin-compat` for globals and statics; `no-restricted-syntax` for prototype methods (`findLast`, `toSorted`, …). |
| Bundle scan (`npm run build`) | `DENYLIST` | Post-94 API call sites in the app, worker, optional-player and Shaka bundles. |
| CSS (`npm run lint:css`) | `browserslist` | `stylelint-no-unsupported-browser-features`. |

`API_CATALOGUE` keeps every API added after Chromium 53 with the version that
shipped it; `DENYLIST` is the part above the floor (Chrome 97+:
`findLast`, `findLastIndex`, `structuredClone`, `toSorted`/`toReversed`/
`toSpliced`, `isWellFormed`/`toWellFormed`, `AbortSignal.timeout`/`any`,
`Object.groupBy`/`Map.groupBy`, `Promise.withResolvers`, `Array.fromAsync`).
Raising `MIN_CHROME` again, and the `browserslist` entry with it, drops the
entries at or below the new floor from both gates.

## Removed

| Removed | Was for | Why it can go |
| --- | --- | --- |
| `src/polyfills.ts` | `Object.entries/values/fromEntries`, `padStart`, `Intl.PluralRules`, `scrollIntoView` options, `ResizeObserver`, `AbortController` (+ fetch wrapper), `flatMap`, `append`, `getRootNode` | All native since Chromium 54–73. |
| esbuild banner (`Object.getOwnPropertyDescriptors`) | Chromium 53 | Native since 54. |
| `src/engine-quirks.ts` (`html.q-scroll-end-padding`, `html.q-no-flex-gap`, `quirks-measured`) | Chromium < 91 scroll padding, < 84 flex gap | Both false on 94; the boot probe also forced a synchronous layout. |
| `css/legacy-webos-base.css` (generated flex-gap margins) | Chromium < 84 | Flex `gap` is native. Two fewer stylesheets at startup. |
| `css/legacy-webos-overrides.css` (`@supports not …` grid, gap, backdrop-filter, inset fallbacks) | Chromium 53–79 | None of its rules could apply on 94. |
| `convertLegacyColorSyntax` build step (`rgba(var(--x-legacy), a)` companions) | Space-separated `rgb()` before Chromium 65 | Native; the companion declarations only added bytes. |
| Compat-gate allowlist (`polyfilled`/`guarded` entries) | APIs below the floor | Nothing above the floor needs an exemption. |
| `eslint-plugin-compat` `polyfills` setting | Same | Same. |

`scaleFontSizes` and the right-to-left stylesheet mirroring stay: they are
not compatibility code.

## Kept on purpose

- `focusWithoutScroll` and `onceTransitionEnd` in `src/utils/dom.ts`: both
  take the native path on 94; the fallbacks are small and harmless.
- The `StorageManager` guard in `idb-cache.ts`: `navigator.storage` is still
  absent outside secure contexts.
- `unicode-text.ts` keeps its Chromium 53 regular-expression fallback. It is
  3.5 KB, never runs on 94, and search equivalence was verified on both paths.
- The stylelint `iptv/no-mixed-legacy-selector` rule still uses the Chromium
  53 selector list. It is stricter than 94 needs, so it never lets a broken
  rule through.
- Shaka: the pinned DASH bundle calls `Promise.withResolvers` (Chrome 119)
  and installs its own guarded `$jscomp` polyfill at load.
  `scripts/shaka-compat-gate.mjs` now expects exactly that.

## Test infrastructure left for the test owner

These still describe the Chromium 53 setup and will fail or are obsolete:

- `src/polyfills.test.ts`, `src/engine-quirks.test.ts` (their modules are gone).
- `scripts/css-transforms.test.mjs` cases for `generateFlexGapFallback` and
  `convertLegacyColorSyntax` still pass (the functions remain in
  `scripts/css-transforms.mjs`) but the build no longer calls them.
- `scripts/shaka-compat-gate.test.mjs` (expects the 53-era raw violations).
- The `chromium-53-simulation` Playwright project, `e2e/legacy-fallbacks.spec.ts`
  and `e2e/legacy-layout-parity.spec.ts`, and
  `scripts/chromium-53-simulation.mjs` / `scripts/polyfilled-apis.mjs`.
