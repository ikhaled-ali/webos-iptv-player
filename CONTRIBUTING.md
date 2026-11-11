# Contributing

Thank you for helping improve iPlayer. These rules exist to keep
the project, its maintainers, and its users clear of legal and privacy
risk. They apply to every contribution: code, tests, fixtures, docs,
screenshots, commit messages, and issues. A pull request that breaks any of
them will not be merged, however useful it is otherwise.

For build commands, architecture, and coding conventions, see
[AGENTS.md](AGENTS.md).

## 1. Write your own code

Every line you contribute must be your own original work.

- **Don't copy, port, or translate code from another project** — not from
  other IPTV players, webOS apps, Kodi add-ons, browser extensions, blog
  posts, Stack Overflow answers, or AI output that reproduces them. This
  holds even when that code is open source: a "compatible" license still
  carries attribution and license obligations, and an incompatible one
  can't be merged at all.
- **Don't reimplement by reading line by line.** Learning *what* a format
  or protocol does from a public specification (HLS, MPEG-DASH, XMLTV,
  WebVTT, ASS/SSA, the M3U conventions) is fine; reproducing *how* another
  project wrote it is not. Work from specs, platform documentation, and
  your own observation of behavior.
- **Don't decompile or reverse-engineer proprietary software** (firmware,
  closed-source apps, vendor libraries) to lift code or assets from it.
  Observing how the platform behaves, so the app can work with it, is
  fine.
- **Third-party libraries come in only as declared dependencies**, never
  pasted into `src/`. A new dependency needs maintainer approval first, a
  license compatible with Apache-2.0, and an entry in
  [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) and `licenses/` when it
  ships in the app.

### AI-assisted code

You may use AI coding tools, but you are the author and you answer for
every line:

- **The rules above apply to AI output.** Code a tool suggests is your
  submission, so it must not reproduce another project's code any more
  than hand-written code may.
- **Turn on public-code matching.** In GitHub Copilot, set *Suggestions
  matching public code* to *Block*, or enable code referencing and drop
  any suggestion that matches existing code. Other tools need an
  equivalent safeguard.
- **Review and understand everything.** Don't submit code you haven't
  read, can't explain, or haven't tested.
- **Contribute real human work.** Design the change, edit and restructure
  the generated code, and write or verify its tests yourself. Raw output
  pasted in unchanged is not an acceptable contribution.

By submitting a contribution you confirm that you wrote it, that you have
the right to submit it, and that it may be distributed under the project's
[Apache-2.0 license](LICENSE).

## 2. Use synthetic identifiers only

The app plays content the user supplies. The repository itself must never
contain or name real-world content.

Never add, in code, tests, fixtures, docs, screenshots, or examples:

- real channel names, network or broadcaster names, or brands;
- real movie, series, episode, or program titles, descriptions, or
  artwork;
- real logos, posters, or thumbnails;
- real playlist, EPG, Xtream, or stream URLs, domains, or IP addresses
  outside private ranges;
- real audio-track or subtitle names, or locale-specific language codes
  used as sample data.

Use synthetic placeholders instead:

| Kind | Use |
| --- | --- |
| Channels | `ch1`, `ch2`, `Alpha`, `Bravo`, `Charlie` |
| Programs, movies, series | `Program 1`, `Movie A`, `Series B` |
| URLs | `http://host/a`, `http://host/b.m3u8`, `https://example.com` |
| Groups | `Group 1`, `Group 2` |
| Tracks | `Track 1`, `Track 2`, `Track 3` |
| Languages | `l1`, `l2` |

Docs may link a vendor's developer test stream or public-domain test
content to show how a result can be reproduced. Never hardcode such a
stream into code or tests.

Screenshots must show synthetic data only — generate them with
`npm run screenshots`, never by capturing a real playlist.

## 3. No secrets

Never commit passwords, account credentials, Xtream usernames or
passwords, API keys, tokens, DRM license keys or ClearKey key pairs,
private keys, certificates, signing keys, or device passphrases — real or
"just for testing". Tests use obviously fake values such as `user`/`pass`
or an all-zero key. Keep personal device and account details in local,
git-ignored files.

If you commit a secret by accident, tell the maintainer at once: rotate or
revoke it first, then remove it from history.

## 4. No third-party servers

The app talks only to the sources the user configures (their own
playlist, EPG, Xtream account, or DRM license server) and to its own
bundled service, which runs locally on the TV. Nothing is routed through
or reported to anyone else, so there is no privacy risk to the user.
Keep it that way:

- **No project-run or third-party backends** — no proxies, relays,
  cloud sync, or "helper" APIs.
- **No analytics, telemetry, crash reporting, ads, or tracking** of any
  kind.
- **No remote assets** — fonts, icons, scripts, styles, and libraries are
  bundled in the IPK, never loaded from a CDN.
- **No hardcoded content sources** — no default playlists, EPG feeds,
  logo services, or metadata lookups.
- Diagnostics (`tv.sh diag`) stay on the device and must never log URLs,
  credentials, or playlist/EPG text.

## 5. Issues and bug reports

Issues are public, so keep your own data out of them:

- **Never paste real playlist, EPG, Xtream, stream, or DRM license URLs**,
  nor usernames, passwords, tokens, MAC addresses, or device keys.
- **Redact logs and screenshots before attaching them.** Replace hosts,
  paths, query strings, and channel or program names with placeholders
  such as `http://host/a` and `ch1`.
- **To reproduce a parsing bug, reduce the input** to a minimal synthetic
  M3U or XMLTV sample that still fails.

If you shared something sensitive by mistake, edit or delete it and
change the affected password or token.

## 6. Before you open a pull request

- `npm run typecheck`, `npm run lint`, and the relevant tests pass.
- Every bug fix includes a regression test.
- Search your diff for anything that breaks sections 1–5: real names,
  real hosts, credentials, keys, or code you didn't write.
