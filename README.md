# webOS IPTV Player — first-pass credential hardening kit (v2)

Reviewed against the public `main` branch of
`https://github.com/lennylxx/webos-iptv-player` on 2026-10-22.

**v2 fix (2026-10-22):** The v1 patcher erroneously searched for one extra
space before several lines of `bundled-service/src/lan/server.ts`. v2 corrects
those anchors. If v1 reported `ERROR (nothing changed)`, you do **not** need to
reset or reclone; extract this new ZIP, then rerun preview and apply using the
updated Python script. Do not reuse the old extracted script.

This is an **offline patching kit**, NOT a fork already published to GitHub.
It modifies a local clone after verifying exact source-code anchors. The original
GitHub code could have changed; if it has, the patch script stops without
writing partial changes.

This checkout already contains the applied hardening changes. Do not rerun
the patcher here. The applied code also fixes Node.js 0.12 response handling,
redacts quoted assignments and authorization headers, and bounds cyclic
error causes. The runtime smoke test checks both the secure default and
the explicitly enabled legacy mode.

## Changes included

- **LAN service binds to 127.0.0.1 by default**, not 0.0.0.0. Phone-based setup
  and phone M3U uploads are intentionally disabled by default because the
  existing LAN protocol is plain HTTP and transports passwords/tokens.
- For users **explicitly opting into the insecure legacy phone setup** through
  `IPTV_ALLOW_INSECURE_LAN_SETUP=1`, listing uploads requires the pairing token;
  raw M3U file downloads still remain **loopback-only** even when paired.
  The setup-page JavaScript sends the token when listing uploads.
- **CORS:** `Access-Control-Allow-Origin: *` is sent only to requests received
  over TV loopback, preserving the TV UI's cross-origin service access while
  removing that header for LAN peers.
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

1. **Local persistence still stores account passwords, subtitle keys, and
   credential-bearing playlist URLs without app-layer encryption.** Solving
   this properly needs a PIN/password-protected encrypted vault (KDF + key
   management + user unlock flow) or a secure webOS key-store integration.
   Simply encrypting with a key stored next to ciphertext is not protection.
2. **The Xtream protocol still embeds credentials in request URLs.** HTTPS
   is needed end to end (provider redirects, playlists, EPG and media). Explicit
   HTTP URLs still work and still expose secrets on the network.
3. **If insecure LAN setup is deliberately enabled**, passwords, playlist
   URLs, pairing tokens, and uploads may traverse the LAN over plain HTTP.
   The security headers and endpoint authorization do not provide encryption.
4. Other webOS apps or code with local-device access may reach the loopback
   HTTP service or browser storage. Isolating that access requires platform-
   specific changes that have not been tested.
5. The fix does not cover every `console.log` call outside the logger, all
   metadata exposed in setup state if HTTP is opted in, or third-party
   dependencies/build provenance. A live network capture and distributed
   `.ipk` reproducible-build check are still required.

## Apply to your own fork

1. Visit https://github.com/lennylxx/webos-iptv-player and click **Fork**
   while signed into GitHub.
2. Clone **your fork** to your computer. No IPTV credentials are needed.
3. Create a hardening branch and apply this kit:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/webos-iptv-player.git
cd webos-iptv-player
git switch -c security/credential-hardening
# Replace the path with where you extracted the ZIP. Typical macOS Downloads path:
python3 "$HOME/Downloads/iptv-hardening-kit/apply_security_fixes.py" .
python3 "$HOME/Downloads/iptv-hardening-kit/apply_security_fixes.py" . --apply
```

If compatibility fails, **do not force or manually ignore anchors**; inspect
upstream changes and adapt the patch deliberately. Run on a clean branch.

4. Install dependencies and run the repo's build/test gates:

```bash
npm ci
npm run typecheck
npm run service:typecheck
npm test
npm run service:smoke
git diff --check
git diff
git status
```

5. After addressing any failures, commit and push:

```bash
git add bundled-service/src/lan/server.ts \
  bundled-service/src/lan/server.test.ts \
  bundled-service/src/lan/server-security.test.ts \
  bundled-service/src/setup/setup-page.html \
  src/utils/logger.ts src/utils/redact-log.ts src/utils/redact-log.test.ts \
  src/utils/xtream-url.ts src/utils/xtream-url.test.ts
git commit -m "security: harden IPTV credential exposure paths"
git push -u origin security/credential-hardening
```

**Do not publish real IPTV credentials, M3U playlists, diagnostic console logs,
TV storage dumps, or a `.ipk` built using private credentials.**

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

## If the script is still not compatible

Run `git status --short` to verify the checkout. The patcher stops rather
than guessing where to edit when any anchor is absent or duplicated. If you
still see an anchor error after extracting v2, provide **only the error and the
surrounding non-secret source code**; never send IPTV login details, playlist
URLs containing tokens, or exported device logs.
