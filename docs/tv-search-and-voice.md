# TV search and voice

What LG lets a webOS app do with the remote's voice button and the TV's own
search, and what this app implements.

## What LG allows

| Feature | webOS versions | Who can use it |
| --- | --- | --- |
| System voice-to-text in a focused text input (remote mic or the virtual keyboard's mic) | All supported versions | Any app, no code needed |
| Launch params (`webOSLaunch` / `webOSRelaunch`, Application Manager `launch`, `ares-launch -p`) | All supported versions (`webOSSystem` from 5.0, `PalmSystem` before) | Any app, dev mode included |
| Home / universal search results and deep links into an app | Not published | LG partners only, under NDA (Seller Lounge → Partnership) |
| Voice intents from the Home mic ("play X in app Y"), `com.webos.service.voiceconductor` | Not published | LG partners only; not in the public Luna API list |

Sources: the webOS TV developer site's
[App Lifecycle Management guide](https://webostv.developer.lge.com/develop/guides/app-lifecycle-management),
[Application Manager reference](https://webostv.developer.lge.com/develop/references/application-manager),
[CLI guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide),
[appinfo.json reference](https://webostv.developer.lge.com/develop/references/appinfo-json)
(no voice or search keys exist), and LG's answers on the developer forum,
which send universal search, deep linking, and system voice control to a
partner agreement. A sideloaded or dev-mode app can't appear in the TV's
search results.

## What the app does

- **Voice in Search.** The Search box is a plain `<input>`. With it focused,
  the remote's mic fills it with the spoken text and the results update as if
  it were typed.
- **Search launch param.** A launch or relaunch with a `query` param opens the
  Search box with the query filled in and focuses the first result. A
  reminder's `reminderChannelKey` wins when both are present.
  `src/services/launch-intent.ts` parses the params; `App.handleLaunchParams`
  routes them.

```bash
ares-launch -d tv com.ikhaled.iptv -p '{"query":"Alpha"}'
```

From another app, the same params go through
`luna://com.webos.applicationManager/launch` with
`{"id": "com.ikhaled.iptv", "params": {"query": "Alpha"}}`. If LG ever grants
search or voice partnership, its deep links can be mapped onto this
`query` param.
