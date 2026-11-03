# Ready Map

A small, static map web app for the **Ready** emergency-prep bot. It works worldwide. It uses the
phone's own GPS, shows your spot on an OpenStreetMap map, lets you save places, finds help nearby,
keeps the map parts you have viewed for offline use, and can show live weather (rain radar, clouds,
U.S. warnings, world disaster alerts) and ocean layers (currents, sea temperature, depth, marine zones).
Layers that only work in the United States say "U.S. only" in their names.

Version 1.2.0.

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
- An Overpass API mirror (`overpass-api.de`, then `overpass.kumi.systems`,
  `overpass.private.coffee`, `maps.mail.ru`, with failover) only when you tap **Show on this map**
  in Find nearby (sends that spot's coordinates; searches 1, then 3, then 6 miles; results are
  kept in memory and in localStorage for 24 h; at most one request every 3 s).
- `nowcoast.noaa.gov` and `api.weather.gov` only while a weather layer is on (Weather warnings
  sends your GPS location, or the map center, to api.weather.gov).
- `nowcoast.noaa.gov`, `gis.charttools.noaa.gov` and `mapservices.weather.noaa.gov` only while an
  Ocean layer is on (they see the map area you view).
- `api.rainviewer.com` / `tilecache.rainviewer.com` for world radar (outside NOAA coverage in
  Automatic mode, or when **World** is picked) and if NOAA radar fails (free for personal/educational
  use; since 2026 the free API stops at zoom 7, so it looks blurry when you zoom in close).
- `www.gdacs.org` only while **World disaster alerts** is on (one request for the whole world list;
  no location is sent, the nearest events are picked on the phone).
- `coastwatch.noaa.gov` only while **World currents** is on, and `wms.gebco.net` only while
  **World sea depth** is on (they see the map area you view).
- **Weather news** (only when you open the panel): `api.weather.gov` (gets the map center for the
  office lookup, then that office's products and the national tropical products), `www.weather.gov`
  (national RSS headlines) and `www.gdacs.org` (whole world list).
- **Local weather** (only when you open the card, then every 15 minutes while GPS is on): one spot
  (your GPS spot, else the spot you tapped, else the map center) goes to `api.weather.gov` in the
  U.S., or to `api.open-meteo.com` outside the U.S. Outside the U.S. it also reads the GDACS world list.
- Google Maps / Apple Maps only when you tap their links.

Weather, ocean and world data are never cached by the service worker (it only handles the app's
own files and OSM tiles). No cookies, no analytics.

## Map layers (Weather sheet)

Every layer has an on/off switch (`toggle-*`), a see-through slider (`opacity-*`), a
"Data from" line (`time-*`) and a legend. All are off by default, nothing loads until you turn
one on, and on/off is not saved between visits.

A one-line note at the top of the sheet says: layers marked U.S. only work in the United States;
World layers work everywhere.

| Layer | Coverage | Source | Notes |
| --- | --- | --- | --- |
| Rain radar (`toggle-radar`) | World (U.S. detail from NOAA) | NOAA nowCOAST (`base_reflectivity_mosaic`); RainViewer world radar | "Which radar" radios `name="radar-area"`: `auto` (NOAA when the map center is in CONUS, Alaska, Hawaii, Puerto Rico/USVI or Guam, else RainViewer; re-picked on `moveend`, debounced), `us` (NOAA, falls back to RainViewer if NOAA fails), `world` (RainViewer, max native zoom 7). "Data from" names the source |
| Clouds (`toggle-satellite`) | Americas (GOES) or World (GMGSI) | NOAA nowCOAST `goes_longwave_imagery` / `goes_visible_imagery`; NOAA/NESDIS GMGSI `global_longwave_imagery_mosaic` / `global_visible_imagery_mosaic` | `sat-kind` radios; exact listed time via `pickWmsTime` |
| Weather warnings (`toggle-alerts`) | U.S. only | api.weather.gov alerts (includes marine warnings) | outside the U.S. it points to World disaster alerts |
| World disaster alerts (`toggle-gdacs`) | World | GDACS `https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP` | dots coloured by alert level with a letter (G/O/R); popup with type, severity, local dates, GDACS report link; `gdacs-list` = 10 nearest the map center with distance; freshness = newest `datemodified` (UTC) |
| **Ocean:** Ocean currents (`toggle-currents`) | U.S. waters and Great Lakes | NOAA nowCOAST: NWS/NCEP Global RTOFS (`grtofs:rtofs_east_sfc_currents,grtofs:rtofs_west_sfc_currents`) + NOS Great Lakes OFS (`leofs/lmhofs/loofs/lsofs:*_sfc_currents`) | model guidance, speed in knots; "Model time" + model run shown |
| **Ocean:** Sea temperature (`toggle-sst`) | World | NASA SPoRT 7-day satellite SST via NOAA nowCOAST (`sea_surface_temperature:nasa_sport_sea_surface_temperature`) | legend in °F and °C |
| **Ocean:** Depth lines (`toggle-depth`) | U.S. and Great Lakes | NOAA Office of Coast Survey ENC chart WMS, layer `2` | depths in feet, not for navigation |
| **Ocean:** Marine zones (`toggle-marinezones`) | U.S. only | NWS reference map ArcGIS `export`, layers `show:5,6` | outlines + zone ids; warnings show in Weather warnings |
| **Ocean:** World currents (`toggle-worldcurrents`) | World | NOAA CoastWatch ERDDAP `noaacwBLENDEDNRTcurrentsDaily.transparentPng` (u/v vectors, `(last)` day) | one ERDDAP image per map tile (`ReadyMap.erddapCurrentsUrl`); min zoom 3, native max zoom 8; slow server (~2-3 s per tile); not for navigation |
| **Ocean:** World sea depth (`toggle-worlddepth`) | World | GEBCO WMS `https://wms.gebco.net/mapserv`, layer `GEBCO_LATEST_2` | shaded depth (land coloured too), default 50 % see-through; not for navigation |

Time-enabled nowCOAST ocean layers ignore in-between times (they return an empty tile), so the
app reads each layer's time list from the workspace GetCapabilities
(`https://nowcoast.noaa.gov/geoserver/<workspace>/ows?service=WMS&version=1.3.0&request=GetCapabilities`)
and sends an exact listed value: `ReadyMap.pickWmsTime(times, nowMs)` picks the latest time
that is not in the future (or the nearest one if all are in the future). If capabilities fail,
the "Data from" line says "Not loaded" with a plain message; nothing throws.

## Weather news (`#btn-news` in the Weather sheet)

Opens `#sheet-news`: recent official headlines for the map center, in four groups
(`#news-list`, status `#news-status`, refresh `#news-refresh`). Each feed is fetched on its own with
`fetchWithTimeout`; a failing feed shows one short line in its group and never blocks the others.
Feed text is only set with `textContent`. Each item: title (link, new tab, `rel=noopener`), source,
local time and "x hours ago". Loaded when opened (again if older than 10 minutes) and with Refresh.

| Group | Coverage | Source |
| --- | --- | --- |
| Your area | U.S. only | `api.weather.gov/points/{lat},{lon}` → `cwa`; newest `AFD` (≤ 72 h), `HWO` (≤ 36 h), `SPS` (≤ 24 h) from `/products/types/{CODE}/locations/{CWA}`; link `forecast.weather.gov/product.php?...`; **Read** shows the first 25 lines of `productText`. Outside the U.S. (points 404) it says so |
| Tropical storms | Atlantic, Pacific | `api.weather.gov/products/types/TCP` (last 24 h, newest per storm, storm name read from the text) and `/products/types/TWO` (newest per office and area, last 48 h). Sources: National Hurricane Center, Central Pacific Hurricane Center, NWS Guam |
| United States | U.S. | `https://www.weather.gov/rss_page.php?site_name=nws` (RSS, ISO-8859-1), parsed by `ReadyMap.parseRssItems` |
| World | World | GDACS `EVENTS4APP`: all Orange/Red events plus the 3 nearest the map center, with distance |

## Local weather (`#btn-localwx` at the top of the Weather sheet)

Opens `#sheet-localwx`, a weather card for one point: the GPS fix if there is one, else the
selected/tapped spot (`Map point`), else the map center. Sections: `#localwx-place` ("Your location" /
"Map point" + city/state or lat/lon), `#localwx-now` (temperature °F and °C, feels-like, wind mph with
direction words and gusts, humidity, sky words), `#localwx-hourly` (24 `li.hour`, swipe sideways),
`#localwx-daily` (7 `li.day`: day, high/low °F/°C, sky, rain chance), `#localwx-alerts`,
`#localwx-source`, `#localwx-updated` ("Updated <local time>", plus "Saved from <time>" when showing an
old result) and `#localwx-refresh`. No new toolbar chip.

| Where | Source |
| --- | --- |
| U.S. | `https://api.weather.gov/points/{lat4},{lon4}` → `forecast` (day/night periods paired into days), `forecastHourly` (next 24), `observationStations?limit=1` → `/stations/{ID}/observations/latest` (NWS station name and reading time; older than 2 h is flagged; no reading → first forecast hour), `alerts/active?point=` (same parsing as the Weather warnings layer, **Read more** opens the warning). Each call retries once after 2 s on 500/503. If both forecasts fail, the forecast comes from Open-Meteo |
| Outside the U.S. (points 404 or fails) | `https://api.open-meteo.com/v1/forecast?...&current=...&hourly=...&daily=...&forecast_days=7&forecast_hours=24&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph`. Warnings: points to World disaster alerts, and lists GDACS events within 300 km (reuses the layer's data if it is on, else one `EVENTS4APP` request kept 15 min) |

Only `Accept` is sent (no custom headers; browsers do not allow setting User-Agent). Results are kept
in memory only (never in the service worker or storage), keyed by the point rounded to 2 decimals;
any result within 2 km is reused, and the same area is never fetched again within 5 minutes (Refresh
says "Already up to date"). Auto-refresh every 15 minutes (or after moving more than 2 km) while GPS
is on and the card was opened once; paused while the page is hidden. Offline: the last result with
"Saved from <time>", or a plain offline message. Pure helpers: `ReadyMap.cToF`, `ReadyMap.fToC`,
`ReadyMap.wmoCodeText` (WMO code → words), `ReadyMap.degToCompass` (degrees → 16-point, e.g. 225 → `SW`),
`ReadyMap.compassWords` (`SW` → `southwest`). Open-Meteo: "Weather data by Open-Meteo.com", CC BY 4.0,
free tier for non-commercial use (< 10,000 calls/day).

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
`OVERPASS_MIRRORS` (array of mirror URLs), `overpassQuery(key, lat, lon, radiusM)` → Overpass QL string,
`tilesForBounds(bounds, zFrom, zTo)` → `{count, tiles, truncated}`, `buildSpotUrl`, `map`,
`pickWmsTime(timesArray, nowMs)` → exact string from the array or `null`,
`mercatorTileBbox(x, y, z)` → `[xmin, ymin, xmax, ymax]` in EPSG:3857 meters,
`erddapCurrentsUrl(x, y, z)` → ERDDAP image URL for that tile's lon/lat box (or `null`),
`inNoaaRadarCoverage(lat, lon)` → boolean, `parseGdacsDate(s)` → `Date` (UTC) or `null`,
`parseRssItems(xmlString)` → `[{title, link, pubDate}]` (links get `https://` when the scheme is
missing; non-http(s) links become `''`; bad XML gives `[]`), `fixFeedLink(link)`, `timeAgo(date, nowMs)`,
and `weather.parseWmsTimes(xmlText[, layerName])`, `weather.severityColor(sev)`,
`weather.state.ocean` (per-layer state), `weather.state.gdacs`, `weather.state.radar`.

## Credits

Map data © OpenStreetMap contributors (ODbL). Leaflet © Volodymyr Agafonkin and contributors
(BSD-2-Clause). Weather: NOAA / National Weather Service (public domain). World and backup radar:
RainViewer. World clouds: NOAA/NESDIS GMGSI via NOAA nowCOAST. World disaster alerts: GDACS
(EC JRC + UN OCHA). Weather news: NOAA / National Weather Service (local offices, NHC, CPHC) and GDACS. Local weather: NOAA / National Weather Service; outside the U.S. Weather data by Open-Meteo.com (CC BY 4.0). Ocean: NOAA nowCOAST (RTOFS, Great Lakes OFS, NASA SPoRT SST), NOAA Office of
Coast Survey ENC charts, NOAA / National Weather Service marine zones (public domain), NOAA
CoastWatch blended geostrophic currents, GEBCO Compilation Group (2024) GEBCO Grid.
