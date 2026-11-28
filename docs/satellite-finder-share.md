# Signal finder on a phone

The satellite tools' **Signal finder** can stream its live readings to a
phone, so one person can align a dish on the roof while the TV stays
indoors. **Show on phone** in the finder turns it on and shows a QR code;
the phone page draws the TV's lock state, signal quality and strength, bit
error rate, and transponder, with a peak hold and an optional tone whose
pitch rises with the signal.

Below the readings, the phone can change the finder's settings: the
satellite, its LNB frequency, DiSEqC port, 22kHz tone, and LNB power, and
the transponder (a listed one, or a new one with its frequency, symbol
rate, polarization, and transmission). Edits stay on the phone until
**Send to TV**; the TV then takes them as if picked with the remote,
saving a changed LNB setup to the satellite as the finder does, and
retunes. The phone says whether the TV took them, and a phone without
edits follows what the TV shows.

## Shape

```
┌──────────────┐  MQTT over WSS  ┌──────────────┐  MQTT over WSS  ┌──────────────┐
│ TV (finder)  │ ──────────────▶ │ public MQTT  │ ──────────────▶ │ phone page   │
│ FinderShare  │    publish      │ broker       │    subscribe    │ GitHub Pages │
└──────────────┘                 └──────────────┘                 └──────────────┘
```

- **Relay.** Public MQTT brokers over secure WebSocket
  (`FINDER_BROKERS` in `src/services/finder-share-protocol.ts`), tried in
  order. The QR names the broker that answered, so both ends meet on it.
  The TV and a phone can each open a WebSocket, so no server of our own is
  needed, and MQTT brokers take a reading a second without the
  per-message limits of push-notification relays.
- **Client.** `src/services/mqtt-lite.ts` implements the MQTT 3.1.1
  subset the share uses: connect with a will, QoS 0 publish and
  subscribe, keepalive. The phone page bundles the same module.
- **Phone page.** `src/finder-viewer/` is built into one self-contained
  HTML file by `scripts/build-finder-viewer.mjs` and published at
  `<pages>/finder/` by `.github/workflows/github-pages.yml`
  (`FINDER_VIEWER_URL`). `npm run finder-viewer` builds it into
  `build/finder/` for a local look.

## Messages

Each share has a random 128-bit id that lives as long as the app, so a
phone that scanned the QR keeps working when sharing is turned off and on.
The id and broker index ride in the link's fragment
(`#b=<broker>&t=<id>`), which the browser never sends to the page's host.

| Topic | Retained | Body |
|---|---|---|
| `iplayer/finder/<id>/status` | yes | `{v, on, labels}` — whether the TV shares, and the page's words in the TV's language |
| `iplayer/finder/<id>/reading` | no | `{v, lock, strength, quality, ber, satellite, transponder}`, about every 0.8 s |
| `iplayer/finder/<id>/settings` | yes | `{v, satellite, satellites, lnbs, diseqcs, tones, ack?}` — every satellite with its LNB setup, transponder list, and tuned transponder; sent when it changes |
| `iplayer/finder/<id>/apply` | no | `{v, req, satellite, lnb, diseqc, tone, lnbPower, form}` — the phone's settings; the TV answers with `ack: {req, ok}` in its next settings |

The TV subscribes to `apply` only while it shares, and clears the
retained settings (an empty retained message) when sharing stops. It
refuses an apply while another tool is open or a scan runs, or one that
names a satellite, LNB, port, or tone it doesn't have; the phone reports
a send with no ack within 8 seconds as unanswered.

The will is a retained `on: false` status, so a TV that vanishes reads as
stopped; turning sharing off publishes the same before a clean
disconnect. The broker may publish a dropped connection's will after the
TV has already reconnected, so the TV republishes `on: true` every 20
seconds while live, and the phone counts a stop only when no reading
follows it within two seconds. The phone treats readings older than four
seconds as stale. Both ends use a 10-second keepalive, so a dead
connection shows within about 15 seconds.

Anyone who knows an id can read or publish its topics, so anyone who
scanned the QR can change the finder's settings while sharing is on.
Only readings and the satellite setup (names, LNB options, transponder
lists) are sent, never account data or URLs. Both ends validate every
message: the phone bounds its text and sets it through `textContent`;
the TV takes only numbers in the finder's ranges and values from its own
option lists.

## Lifecycle

- While it connects or shares, the TV's screensaver stays off
  (`KeepAwake`), since nobody presses a key while on the roof; a failed
  share releases it.
- Leaving the finder tool or the satellite tools, or the app going to the
  background, stops sharing.
- A dropped connection retries the same broker every few seconds while the
  QR stays on screen.

## Diagnostics

| Event | When |
|---|---|
| `satellite.share.failed broker=<i> reason=<timeout\|refused\|closed\|error>` | A broker did not accept the connection at start. |
| `satellite.share.dropped broker=<i>` | A live share lost its connection; retries log nothing. |
| `satellite.share.rejected reason=<busy\|satellite\|invalid>` | The finder refused settings sent from the phone. |
