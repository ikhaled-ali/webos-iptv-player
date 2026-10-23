# LAN Setup Service

A bundled webOS JS service that lets a phone or computer on the same LAN
configure Playlist URLs, Xtream accounts, and ordered EPG sources, or upload an
`.m3u` playlist to the TV. Each manual EPG source can apply globally or to
selected playlists. The TV-side app consumes these changes through Luna.

The service targets webOS TV 4.x's Node.js 0.12.2 runtime. TypeScript emits
ES5/CommonJS, and `scripts/service-compat-gate.mjs` scans the final JavaScript
for newer syntax and APIs. `bundled-service/src/compat.ts` prefers native APIs
on newer TVs and supplies focused fallbacks for Node 0.12.

The listener binds only to `127.0.0.1` by default. Phone setup and uploads
are disabled, and `/info` returns empty setup URLs and pairing code. Setting
`IPTV_ALLOW_INSECURE_LAN_SETUP=1` explicitly enables the legacy LAN mode
described below. That mode uses plain HTTP and can expose credentials to
network interception. Raw playlist downloads remain local even when paired.

In the packaged application, upload storage remains locked until the owning
app provides its unwrapped data key through Luna. Stream URLs and credential-bearing URL attributes in M3U files use AES-256-GCM
on disk. Channel tags and upload metadata stay unencrypted; the service never
writes the key to disk. Previous whole-file ciphertext is migrated to this
selective format through atomic replacements before `start` succeeds. Wrong keys or damaged files fail without overwriting them.
Standalone development servers must configure upload encryption separately;
the direct server/test API retains an explicit plaintext compatibility mode.
See [storage protection](storage-and-data.md#encryption-at-rest).

## Architecture

```
┌──────────────────┐  Luna  ┌─────────────────────────────┐  HTTP  ┌──────────────────┐
│ App (browser)    │◀──────▶│  Bundled service            │◀──────▶│  Phone / laptop  │
│  src/app.ts      │        │  com.lennylxx.iptv.service  │  LAN   │  setup page      │
│  LAN clients     │        │  lan/ + setup/ + upload/    │        │  (/setup)        │
└──────────────────┘        └─────────────────────────────┘        └──────────────────┘
            ▲                             │
            └─────── serviceEvents ───────┘    push notification on every change
```

- **Luna bus** — in-process IPC between the app and the service.
- **HTTP** — loopback only by default; explicit legacy opt-in binds to all
  interfaces for phones and the app's reconcile fetches.

## APIs

The service exposes the Luna methods and HTTP routes below.

Luna (called by the app's LAN/reminder clients and by Activity Manager):

| Method | Subscribe? | Purpose |
|---|---|---|
| `start` | no | Accept `{encryptionKey}` (base64, 32 bytes) from the owning app over Luna, unlock/migrate uploaded files, and return the bound port and private local token. Idempotent. |
| `stop` | no | Close the HTTP server and release the keepAlive activity. |
| `heartbeat` | no | Liveness probe; returns `{running, port}`. |
| `serviceEvents` | **yes** | Push channel for `uploads-changed` and `setup-changed` events. |
| `getDevMode` | no | Report whether Developer Mode is available for interactive reminder alerts. |
| `fireReminderAlert` | no | Raise the Developer Mode reminder alert requested by Activity Manager. |

HTTP (called by phones, and by the app for reconcile):

| Route | Method | Purpose |
|---|---|---|
| `/info` | GET | Authenticated loopback metadata, including setup URLs and the pairing code. |
| `/` or `/setup` | GET | Public setup page; asks for the TV pairing code. |
| `/setup?token=…` | GET | QR entry that opens the same page already authorized. |
| `/pair` | POST | Rate-limited exchange of the four-digit code for the setup token. |
| `/setup-state` | PUT | Loopback-only sanitized source state, including enabled flags, published by the TV. |
| `/setup-state?token=…` | GET | Sanitized source and online-subtitle state for the setup page. |
| `/setup-actions?token=…` | POST | Validate and queue a source or online-subtitle change. |
| `/setup-actions` | GET | Loopback-only list consumed by the TV app. |
| `/setup-actions/:id` | DELETE | Loopback-only acknowledgement from the TV app. |
| `/setup-actions/:id?token=…` | GET | Phone-facing application status. |
| `/uploads` | GET | List uploads; remote callers require the setup token. |
| `/uploads?name=foo.m3u&token=…` | POST | Save a playlist; fires `serviceEvents`. |
| `/uploads/:id[.m3u]` | GET | Serve a stored playlist over loopback only. |
| `/uploads/:id?token=…` | DELETE | Remove an upload; the TV uses its private local token. |

## Event-driven updates

When a phone uploads, deletes, or submits a source change, the TV updates
within milliseconds. There is **no background polling**.

A successful POST or DELETE on the HTTP side calls an `onChange` hook,
which iterates the active `serviceEvents` subscriber list and calls
`msg.respond({event})` on each one. Upload events refresh `/uploads`.
Setup events make `SetupClient` consume the pending actions, update the
existing `StorageService` models, publish a sanitized `/setup-state` snapshot,
acknowledge each action, and reload data. EPG edits use one
`manual-epg-sources` action containing the complete ordered list, so priority
and playlist scope change atomically. The phone waits for that
acknowledgement before showing “Saved on TV”. Source-removal actions use the
same queue, so deleting a Playlist or Xtream account remains idempotent.
Source-enable actions also use this queue for URL, Xtream, and uploaded
playlists; missing `enabled` fields remain backward-compatible and mean enabled.

The TV also publishes state after service startup and local Settings changes.
The setup page refreshes the snapshot periodically. Xtream snapshots contain
the account id, display name, server URL, and username, but never the password.
Online-subtitle snapshots contain only the preferred language and configured
flags for each provider, plus the OpenSubtitles username. API keys, passwords,
and login tokens never leave the TV. The phone shows configured secrets as a
fixed `********` mask that does not reveal their length. An unchanged mask
preserves the value, one delete clears the field, and replacement text updates
only that field.

Rejected uploads (HTTP 400) and missing-id deletes (HTTP 404) do **not**
fire the event.

Uploaded files remain server-authoritative. Setup actions remain in a shared
in-memory queue until the TV acknowledges them. If the app misses a push,
bundled-service initialization consumes the queue after reconnecting.

## Setup authorization

Every HTTP bind generates an independent 256-bit local token. Luna delivers
it through `start` only to the owning application's bus identity; payload
fields cannot select that identity. The lifecycle and event methods reject
other callers. The app keeps this token in memory and supplies it in the
`X-IPTV-Local-Token` header for metadata, state publication, action consumption,
upload listing, and deletion. Loopback alone grants no privileged access.

Raw playlist URLs returned to authenticated TV clients include a `localToken`
query capability so playlist loaders can read them. That query capability
works only for raw playlist GET requests over loopback. It is omitted from
phone-facing upload listings. Both capabilities rotate when the server binds
again; reconciliation preserves upload identity across token changes.

The server validates the Host against its loopback endpoints or advertised
LAN address and port. Cross-origin HTTP requests from other web origins are
rejected. File and opaque origins receive an explicit CORS origin, never a
wildcard, and must still supply the private token. Preflight responses grant
permission to send the header without exposing data. An opaque origin is
not treated as proof of application identity.

In legacy LAN mode a separate random 12-character pairing token authorizes
the phone endpoints. Authenticated `/info` returns its QR URL and a random
four-digit pairing code. Five failures from one client lock pairing for one
minute. The failure state is checked after reading each request body, so
concurrent requests cannot bypass the lockout. Pairing is disabled entirely
when insecure LAN setup is off.

Setup URLs and pairing codes are advertised only in the explicit legacy
mode. Responses disable caching, referrers, framing, and content sniffing.
These controls do not encrypt the legacy HTTP connection.

The token is required to submit source changes, query their status, upload M3U
files, list uploads remotely, read the sanitized setup state, or remotely delete uploads. Publishing
state and reading or acknowledging queued actions requires private local access, which
prevents another LAN client from injecting state or reading Xtream
credentials. Upload identifiers are validated before file access so requests
cannot escape the upload directory. A new foreground bind creates a new token,
pairing code, and URL, invalidating the old values.

## Foreground / background lifecycle

The service is tied to the app's visibility. When the app is backgrounded
(`visibilitychange → hidden`) the app calls Luna `stop`, which closes the
HTTP listener and releases the `keepAlive` activity — neither the LAN
port nor the service process lingers while other webOS apps are in use.

When the app is foregrounded (`visibilitychange → visible`) it calls
Luna `start` again, which re-binds the HTTP server on a new ephemeral
port and resubscribes to `serviceEvents`. `Settings.refreshSetupInfo()` and
`Settings.refreshUploads()` run so the QR code and upload list reflect the
new port and current state.

The service process itself stays alive across stop/start cycles — only
the HTTP server is torn down. Luna respawns the process on cold start
(first call to `start` after a TV reboot or app uninstall).

## Why this shape?

- **Why a separate process?** webOS sandboxes the app and won't let it
  open a server socket on a non-loopback interface. The bundled service
  runs alongside but independently.
- **Why an OS-assigned port?** A fixed port (e.g. 8890) collides
  unpredictably with whatever else is running on the TV. The OS-assigned
  port is reported back through Luna's `start` response, so the app and
  the phone always agree.
- **Why Luna push and not polling?** Polling wakes the device ~20×/min
  per active Settings view to detect a change that happens maybe twice
  per session, and adds 1–3s lag. Push is built into the platform — one
  `subscribe: true` request from the app, `msg.respond()` from the
  service.
- **Why stop/start on background?** Holding an open LAN port and a
  keepAlive activity while the app is invisible is wasteful and a small
  attack surface. Closing it on hidden costs only a fresh `listen(0)`
  when the app returns.
- **Why M3U only — why not EPG upload too?** The upload plumbing is
  content-agnostic and could carry an XMLTV file just as easily, but it
  would be the wrong model for EPG:
  - **EPG is time-sensitive; an upload is a frozen snapshot.** The app
    refreshes EPG periodically and keeps only a ±7-day program window
    (`src/services/epg-service.ts`, `src/parsers/xmltv-parser.ts`). An
    uploaded XMLTV file is stale within a day or two and effectively
    empty within a week — so the user would have to re-upload every
    couple of days, forever. A playlist, by contrast, is static: upload
    once and it stays valid. Upload fits M3U precisely because M3U
    doesn't expire.
  - **EPG almost always travels as a URL.** It's embedded in the M3U
    header (`x-tvg-url` / `url-tvg`, auto-detected) or fetched from a
    public aggregator. The "I have a file but no hosted URL" gap that
    justifies M3U upload barely exists for EPG.
  - **The local-source case is already covered — and stays fresh.** The
    manual EPG source list in **Settings → EPG**, plus the
    localhost→playlist-host rewrite in `src/services/playlist-service.ts`
    (for users running a local proxy like xTeVe/Threadfin that serves
    M3U and XMLTV from the same box), let the TV *pull* fresh EPG by URL.
    Pull stays current automatically; a push upload does not. For EPG,
    pull strictly dominates.

  If genuine demand for fully offline, file-based EPG ever shows up, the
  better shape is a per-playlist EPG URL the TV can re-pull, not a
  one-shot upload that throws away the freshness guarantee.
