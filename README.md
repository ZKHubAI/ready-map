# Ready Map

A small, static map web app for the **Ready** emergency-prep bot. It uses the phone's own GPS,
shows your spot on an OpenStreetMap map, lets you save places, finds help nearby, keeps the map
parts you have viewed for offline use, and can show live NOAA weather (rain radar, clouds, warnings).

Plain HTML, CSS and JavaScript. No build step, no npm, no CDN, no tracking. Leaflet 1.9.4 is
vendored in `vendor/leaflet/`. All paths are relative (`./`), so it works under any sub-path.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page layout, panels (sheets), inline logo |
| `styles.css` | All styles (mobile first) |
| `app.js` | All app logic; helpers exposed on `window.ReadyMap` |
| `sw.js` | Service worker: offline app shell + map tile cache |
| `manifest.webmanifest` | PWA install info |
| `icons/` | Orange house icon (SVG, 192 and 512 PNG) |
| `vendor/leaflet/` | Leaflet 1.9.4 (BSD-2-Clause) |

## Run it on your computer

```sh
cd app
python3 -m http.server 8000
```

Open <http://localhost:8000/>. GPS works on `localhost` and on `https://` pages only. Over plain
`http://` from another device, the browser blocks GPS and the service worker; the app explains this.

To test on a phone, use an https host (below) or a tunnel that gives you an https URL.

## Host on GitHub Pages

1. Put the contents of `app/` in a repo (for example in a folder or the repo root).
2. Repo **Settings → Pages** → deploy from your branch and folder.
3. The site will be at `https://<user>.github.io/<repo>/`. Because every path is relative,
   it works under a sub-path like `/ready-map/` with no changes.

After changing any app file, bump `VERSION` in `sw.js` (and `app.js`) so phones get the new files.

## Link to a spot (for bots)

```
https://<host>/ready-map/?lat=40.7608&lon=-111.891&label=Meeting%20spot&zoom=15
```

| Param | Meaning | Rules |
| --- | --- | --- |
| `lat` | Latitude | number, -90 to 90 (required) |
| `lon` | Longitude (`lng` also works) | number, -180 to 180 (required) |
| `label` | Pin name | text, up to 80 characters, shown as plain text |
| `zoom` | Zoom level | 1 to 19, clamped; default 15 |

Bad values show a friendly message and the normal map. The **More → Copy link** button builds
the same kind of link for the current point.

## Network use and privacy

The app only contacts:

- `tile.openstreetmap.org` for map tiles. Only tiles you actually view are loaded; the service
  worker keeps them (max 500, oldest dropped first) so they show offline.
- `overpass-api.de` only when you tap **Show on this map** in Find nearby (sends that spot's
  coordinates; cached in memory, at most one request every 3 s).
- `nowcoast.noaa.gov` and `api.weather.gov` only while a weather layer is on (Weather warnings
  sends your GPS location, or the map center, to api.weather.gov).
- `api.rainviewer.com` / `tilecache.rainviewer.com` only if NOAA radar fails (free for personal/educational use; since 2026 the free API stops at zoom 7, so backup radar looks blurry when you zoom in close).
- Google Maps / Apple Maps only when you tap their links.

Weather data is never cached by the service worker. No cookies, no analytics.

## Offline map (no area download)

The [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) does not allow bulk
download or prefetch features, so there is no "download this area" button. **More tools → Offline
map** (`#btn-save-area`) explains how it works: the map keeps the tiles you have already looked at
(up to 500), so to keep an area, look around it at the zoom levels you need while you have signal.
The panel shows how many tiles are kept and has **Clear saved map**.

The tile source is one `TILE_PROVIDER` object at the top of `app.js`
(`url`, `attribution`, `maxZoom`, `allowPrefetch: false`). A provider that allows offline
download could be configured there later (also update `TILE_HOST` in `sw.js` and the CSP in
`index.html`). Map mistakes can be reported at <https://www.openstreetmap.org/fixthemap>
(linked in About).

## Toolbar

The top row always shows **Show my location**, **Follow me**, **Weather** and **More tools**.
**More tools** (`#btn-tools`) opens a menu with **My places** (`#btn-places`), **Compass**
(`#btn-compass`), **Offline map** (`#btn-save-area`) and **About** (`#btn-about`).

## Test hooks

`window.ReadyMap` has: `toDMS(lat, lon)`, `parseParams(search)`, `buildGpx(pins)`,
`googleDirUrl`, `appleDirUrl`, `googleSearchUrl(word, lat, lon)`, `appleSearchUrl(word, lat, lon)`,
`tilesForBounds(bounds, zFrom, zTo)` → `{count, tiles, truncated}`, `buildSpotUrl`, `map`,
and `weather.parseWmsTimes(xmlText[, layerName])`, `weather.severityColor(sev)`.

## Credits

Map data © OpenStreetMap contributors (ODbL). Leaflet © Volodymyr Agafonkin and contributors
(BSD-2-Clause). Weather: NOAA / National Weather Service (public domain). Backup radar: RainViewer.
