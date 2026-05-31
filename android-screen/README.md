# YT Zero Screen (Android)

A dead-simple Android app: a fullscreen WebView pointed at youtube-zero's `/watch` screen.
Open it on a TV/monitor and it becomes a cast target you drive from your phone at `/`.

It's just a wrapper — the `/watch` page does all the work (cast command channel, YouTube
player, fullscreen, status). The native shell adds three things a browser tab can't:

- **Autoplay with sound, no tap** — the WebView allows it, and the app passes `?kiosk=1` so
  the page starts unmuted.
- **Stays awake** — `FLAG_KEEP_SCREEN_ON`.
- **Appliance feel** — immersive fullscreen, auto-retry if the server isn't up yet.

## Configure

Two build flavors, differing only in the page the WebView opens:

| Flavor  | Page     | APK                                  | What it is |
|---------|----------|--------------------------------------|------------|
| `tv`    | `/tv`    | `dist/yt-zero-screen.apk`            | Browse + play + cast receiver (D-pad navigable) |
| `watch` | `/watch` | `dist/yt-zero-screen-watch-only.apk` | Idle cast receiver only (driven from a phone) |

The page URL lives per-flavor in `app/src/<flavor>/res/values/config.xml`; the shared
`screen_name` lives in `app/src/main/res/values/config.xml`:

```xml
<!-- src/tv/res/values/config.xml -->    <string name="server_url">http://valhalla:8000/tv</string>
<!-- src/watch/res/values/config.xml --> <string name="server_url">http://valhalla:8000/watch</string>
<!-- src/main/res/values/config.xml -->  <string name="screen_name">Living Room TV</string>
```

The app loads `<server_url>?name=<screen_name>&kiosk=1`. The screen name is what shows up in
the phone's screen list. The screen's unique id is generated once and persists in the WebView's
storage, so reconnects are stable — no input needed.

## Build

Needs only **podman** on the host (the Android SDK lives in the build container):

```bash
./build.sh
```

Outputs both (debug-signed; committed to the repo):
- `dist/yt-zero-screen.apk` — the `/tv` flavor
- `dist/yt-zero-screen-watch-only.apk` — the `/watch` flavor

First run pulls the gradle image and downloads the SDK (a few minutes); later runs are fast.

## Install

Both flavors share `applicationId com.youtubezero.screen`, so **install only one** — pick the
page you want on this device:

```bash
adb install -r dist/yt-zero-screen.apk             # /tv
# or
adb install -r dist/yt-zero-screen-watch-only.apk  # /watch
```

Or copy the APK to the device and open it (enable "install unknown apps" for your file manager).

The APK is signed with a **stable, checked-in key** (`app/screen.keystore`, password `screenpass`)
so every rebuild signs identically and `adb install -r` keeps working across updates. It's a
throwaway app-signing key for an internal sideloaded app, not a secret.

**One-time:** if you already installed an earlier build (signed with a different key), uninstall
it first or the update is rejected with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`:

```bash
adb uninstall com.youtubezero.screen
adb install android-screen/dist/yt-zero-screen.apk
```

(Uninstalling resets the screen's stored id; it gets a new one, but the name still comes from
`config.xml`.) After this, future `adb install -r` updates work without uninstalling.

## Notes

- **More than one screen?** Change `screen_name` and rebuild for each — or just rename a screen
  from its own idle page (the on-screen name field). The id stays unique per install.
- **Cleartext HTTP** is enabled (`usesCleartextTraffic`) because the server is plain `http` on
  the LAN.
- **Android TV launcher**: to show on the TV home (not just the apps drawer), add a
  `LEANBACK_LAUNCHER` category to the activity's intent-filter and an `android:banner` drawable.
  Left out by default to keep things minimal.
- **minSdk 26** (Android 8.0), so the adaptive icon needs no raster PNGs.
