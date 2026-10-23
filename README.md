# webOS IPTV Player — credential hardening

This checkout includes credential-exposure fixes in the TV application and
bundled service. The original first-pass patch scripts remain as historical
references; their anchor checks are not a replacement for the implemented
source changes and build/runtime tests.

## Additional credential exposure fixes

- The app receives a private token through Luna. Only the owning app can call
  the LAN lifecycle methods; local HTTP clients must authenticate even when
  their network connection uses loopback. Uploaded playlist read capabilities
  are limited to raw file reads and rotate on restart.
- Host and Origin checks block foreign web origins and DNS rebinding names.
  Packaged file/opaque origins receive explicit CORS responses and must still
  authenticate; the service never uses wildcard CORS.
- Concurrent pairing attempts cannot bypass the five-failure lockout, and
  pairing is disabled whenever insecure LAN mode is off.
- URL redaction covers apostrophes in generated account URLs. EPG failure
  messages no longer include their source URL.
- Runtime smoke checks include Node.js 16.20.2 for webOS 25 alongside the older
  supported versions. Hardware-specific behavior still needs a device check.

## Changes included

- **LAN service binds to 127.0.0.1 by default**, not 0.0.0.0. Phone-based setup
  and phone M3U uploads are intentionally disabled by default because the
  existing LAN protocol is plain HTTP and transports passwords/tokens.
- For users **explicitly opting into the insecure legacy phone setup** through
  `IPTV_ALLOW_INSECURE_LAN_SETUP=1`, listing uploads requires the pairing token;
  raw M3U file downloads still remain **loopback-only** even when paired.
  The setup-page JavaScript sends the token when listing uploads.
- **CORS:** authenticated TV requests use explicit origins. Other web origins
  cannot read local service data.
- HTTP responses have `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`. The phone
  setup HTML also supplies a no-referrer meta tag.
- **Logging:** default logger level changes from debug to warn and logger
  calls redact entire URLs, nested password/token fields, and sensitive
  assignments. The included Vitest unit test exercises typical Xtream URLs.
- **Xtream scheme-less addresses default to HTTPS**. Explicit `http://`
  addresses still work for compatibility and remain vulnerable to interception.
- Regression tests for the redactor and loopback-only default are added.
  Existing LAN tests opt into their legacy network-exposed configuration.

## Important incomplete work / remaining threats

**This is a first-pass patch, not a security certification.**

1. **Saved credentials are encrypted with AES-256-GCM.**
   On webOS 24+ (including webOS 25 / 10.3.2-33), the data key is wrapped by an
   app-owned LG Keymanager3 key. Ordinary preferences and downloaded metadata stay
   unencrypted; credential fields and credential-bearing URLs use protected
   references. Older TVs and the desktop preview use a
   nonexportable browser CryptoKey instead, with weaker protection against
   copying the entire browser profile. Existing data migrates at startup;
   credentials are decrypted only in memory. See [storage details](docs/storage-and-data.md).
2. **The Xtream protocol still embeds credentials in request URLs.** HTTPS
   is needed end to end (provider redirects, playlists, EPG and media). Explicit
   HTTP URLs still work and still expose secrets on the network.
3. **If insecure LAN setup is deliberately enabled**, passwords, playlist
   URLs, pairing tokens, and uploads may traverse the LAN over plain HTTP.
   The security headers and endpoint authorization do not provide encryption.
4. The local service now requires a private application token, but privileged
   device access or code already running inside the IPTV app can still read
   decrypted data in memory. OS-level compromise, old backups, and recovery
   of previously deleted plaintext remain outside these fixes.
5. The fix does not cover every `console.log` call outside the logger, all
   metadata exposed in setup state if HTTP is opted in, or third-party
   dependencies/build provenance. A live network capture and distributed
   `.ipk` reproducible-build check are still required.

## Build and verify this checkout

The security fixes are implemented directly in the application and bundled
service. Build these sources instead of applying the historical patch kit.
The old `apply_security_fixes.py --apply` command is disabled because that
first-pass kit does not implement the private service authorization below.
`apply_test_compat_fixes.py` and the offline fixture checks remain historical
references, rather than the current build workflow.

```bash
npm ci
npm run typecheck
npm run service:typecheck
npm run lint
npm test
npm run build
npm run service:smoke
npm run service:smoke:matrix
npm run test:e2e
git diff --check
```

Do not publish IPTV credentials, private playlists, or unredacted device data.

## Offline verification already performed in this kit's authoring environment

```bash
python3 test_patch_kit.py
```

The offline suite verifies patcher behavior on **synthetic anchor fixtures**
(not the live upstream repository), and compiles and runs the TypeScript
redaction helper using `tsc` + Node.js. This does **not** prove the complete
webOS service or downloaded fork builds; the npm gates above must run against
your actual clone.

## Functional impact / trade-off

The security-default fork will keep the TV-side loopback service but no longer
provide usable phone pairing URLs by default. This intentionally turns off
remote HTTP credential entry and M3U file upload. Users who require phone
setup need a **future authenticated HTTPS-based solution** rather than simply
switching the current `http://` URLs to `https://` without a trusted
certificate. `IPTV_ALLOW_INSECURE_LAN_SETUP=1` is a developer-only opt-in to
legacy behavior, **not a secure fix**.

## Historical patcher compatibility

The archived patcher can inspect old anchors but refuses to apply changes.
Use the current project sources for the authenticated service implementation.
Never send IPTV login details, credential-bearing playlist URLs, or exported
device logs when reporting a problem.

Search matches text anywhere in channel, program, movie, and series titles.
It ignores case and combining accents, and accepts multiple partial words in
any order across spaces or punctuation. Exact title matches appear first.
Available channels and programs can appear while the remaining catalogs load.

## Playback controls

**Settings → Playback → Prebuffering** turns the extra buffer on or off; it is
on by default and applies from the next playback without reloading playlists.
When on, playback targets six seconds of buffered media before starting and
eight seconds after an interruption. Waiting is bounded, with an earlier native
fallback if the TV stops filling its buffer while paused. Adaptive players keep
up to about 30 seconds ahead with a short back buffer; live streams and the
player control how much can actually be buffered. This adds a little startup
time and live delay. It cannot compensate for a connection that stays slower
than the selected quality requires; Auto or a lower quality can help.

On the Live screen, **Reload playlists** above the channel groups downloads the
enabled playlists again. It shows **Loading…** while working and keeps the
current channel list if a source fails to load.

During full-screen playback, **Red** cycles the compatible players for the
current stream: native playback and hls.js for HLS, mpegts.js for MPEG-TS/FLV,
or Shaka for DASH. **Green** retries the same channel with the selected player.
For matching Xtream live streams, Red also offers hls.js using the provider's
HLS output for the same stream ID.
**Yellow** opens Quality with **Auto** and the resolutions advertised by the
stream, with frame rate and bitrate when provided. Opening Quality keeps the
current player and source unchanged. Native HLS selects a standalone variant
without changing players; Auto restores its master playlist. Variants requiring
separate audio, native DASH representations, and fixed-quality TS/FLV streams
show their available information without offering unsupported manual selection.
The hls.js and Shaka players use their own quality controls.
Manual quality survives reconnects on that channel; Auto restores adaptive
selection. Sources with a single quality or unavailable options are labeled.
The selection resets when changing channels. Alternative players load only
when selected; normal TV playback stays native. A centered status shows loading,
buffering, reconnecting, or playback error with the player name, and clears when
playback resumes. Failures never advance to another channel.
Error and reconnecting messages include the reported media error, player error
code, or HTTP status when available. A stalled or timed-out stream shows the
detected condition and reconnect attempt. Credentials and stream URLs are hidden;
the native player may provide only a general media error.
