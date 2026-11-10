# Ready Map

A small, static map web app for the **Ready** emergency-prep bot. It works worldwide. It uses the
phone's own GPS, shows your spot on a world map with easy-to-read place names (or local-language names), lets you save places, finds help nearby,
keeps the map parts you have viewed for offline use, and can show live weather (rain radar, clouds,
U.S. warnings, world disaster alerts) and ocean layers (currents, sea temperature, depth, marine zones).
Layers that only work in the United States say "U.S. only" in their names. The **Maps** button switches to a topo map,
a NOAA nautical chart, a Kartverket chart of Norway, GEBCO world depth, EMODnet Europe depth, AusSeabed Australia depth or aerial imagery, can add close-up depth lines, can add depth lines, and can add OpenSeaMap seamarks.

Version 1.5.4.

Plain HTML, CSS and JavaScript. No build step, no npm, no CDN. Only an anonymous, cookie-free GoatCounter visit count (see 1.4.1). Leaflet 1.9.4 is
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
https://<host>/ready-map/?lat=39.8283&lon=-98.5795&label=Meeting%20spot&zoom=15
```

| Param | Meaning | Rules |
| --- | --- | --- |
| `lat` | Latitude | number, -90 to 90 (required) |
| `lon` | Longitude (`lng` also works) | number, -180 to 180 (required) |
| `label` | Pin name | text, up to 80 characters, shown as plain text |
| `zoom` | Zoom level | 1 to 19, clamped; default 15 |

Bad values show a friendly message and the normal map. The **More → Copy link** button builds
the same kind of link for the current point.

## Changes in 1.5.4

- **Fix: "Readable map unavailable" no longer appears by mistake.** A phone report (iPhone, Full map,
  Kartverket Norway chart over the Norwegian Sea) showed the orange banner over the chart. Two causes on
  our side, both reproduced in a test browser:
  1. The readable street map fell back if its first complete render (MapLibre `load`) took longer than
     25 s. On a slow phone connection that is normal, especially with a chart loading at the same time
     over a wide, zoomed-out area. Now only a style that never arrives (30 s) counts as a failure; once
     the style is in, slow tiles just keep loading.
  2. iOS Safari drops WebGL canvases when it is short of graphics memory or the page goes to the
     background, and does not always give them back. Before, 4 s without a restore meant a fallback.
     Now the app waits until the page is visible again, then rebuilds the readable map once on a fresh
     canvas; it falls back only if that happens again within 2 minutes.
  The allowed-sources list (CSP) was checked and was not the cause: 1.5.0 to 1.5.3 only added hosts, and
  every host the readable style uses (tiles.openfreemap.org) was already allowed.
- **The note is small now.** It is no longer the full-width orange banner. It is a small note
  between the zoom buttons and the Full map / Maps buttons (or just below them on narrow screens), with a
  close (×) button, and it fades out on its own after 5 s. It never shows while a chart, topo, imagery or
  depth map is selected, since street names are not what is showing then; it shows once when you go back
  to the street map.
- New test `tests/names-fallback.mjs`: lost canvas over the Norway chart in Full map (rebuild first, then
  fallback), no note over chart, topo, imagery or depth, the note on the street map is small, clear of the
  map buttons, fades and can be dismissed, and a slow connection (over 40 s to load) does not fall back.
  `tests/charts.mjs` also checks there is no readable-map banner over each map type.

## Changes in 1.5.3

- The Maps panel is grouped: **Map type** (street, topo, imagery), **Charts** (NOAA, Kartverket), **Depth**
  (world, Europe, Australia) and **Overlays** (seamarks, depth lines, close-up depth lines).
- **Europe depth (EMODnet, European seas)**: WMS 1.3.0 `https://ows.emodnet-bathymetry.eu/wms`, layers
  `emodnet:mean_atlas_land,emodnet:contours` (mean depth, about 115 m grid, with labeled 50 to 5000 m contours).
  CC BY 4.0, credit "EMODnet Bathymetry Consortium, EMODnet Digital Bathymetry (DTM)". Transparent outside its area.
- **Australia depth (AusSeabed, Australian waters)**: WMS 1.3.0 `https://warehouse.ausseabed.gov.au/geoserver/ows`,
  layer `ausseabed:AusBathyTopo__Australia__Bathymetry__250m_2026`. CC BY 4.0, credit
  "© Commonwealth of Australia (Geoscience Australia) 2026". The `_HS` layer is grey relief only and the main layer is
  already shaded, so `_HS` is not used.
- **Close-up depth lines** (separate overlay, so they are not mixed with Ready Map's GEBCO 2026 lines, which use other depths):
  OpenSeaMap WMS `https://geoserver.openseamap.org/geoserver/wms`, layer `gebco2021:gebco2021_contour`, zoom 11 and closer
  (the server draws nothing farther out). ODbL, credit "© OpenStreetMap contributors and GEBCO 2021 Grid (derived product)".
  A hint in the panel says to zoom in when it is on and the map is too far out.
- All three are labeled with their area and "not for navigation", are not cached (`sw.js`), and their hosts were added to the
  page's allowed image sources. Saved choice for the overlay: `readyMap.closeupContours.v1`.

## Changes in 1.5.2

- **Depth lines** (Maps panel, works over any map type, like Seamarks): lines of equal depth at
  20, 50, 100, 200, 500, 1000 and 2000 m, labeled in meters and feet. Ready Map made them from the
  **GEBCO_2026 Grid** (public domain, attribution shown) and hosts them in `contours/` (about 55 MB in 524 files
  of 10 by 10 degrees, plus a 1 MB world file for zoom 2 to 6). Detail files use every 4th grid cell
  (1 arc-minute, about 1.85 km) with light smoothing, so lines are approximate and miss small shoals; there is
  no 10 m line because the sampled grid cannot place it meaningfully. Rebuild with `tools/make-contours.py`.
  Only the files for the area in view are loaded. **Not cached**: `sw.js` passes `./contours/` straight to the network.
  No public GEBCO contour service covers every zoom: OpenSeaMap's GEBCO 2021 contour WMS only draws from about zoom 11,
  and EMODnet's covers Europe only (both listed as options in the research notes).
- **Tap for depth on any map type**: a tapped water spot shows "About N m (N ft), approximate depth from GEBCO
  (about 450 m grid), not for navigation". The value is the GEBCO_2026 cell read with OPeNDAP from CEDA
  (`https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2026/ice_surface_elevation/netcdf/GEBCO_2026.nc.ascii?elevation[i][j]`).
  Where Open-Meteo has no marine forecast, GEBCO's type grid (`gebco_2026_tid.nc`) must call the cell a measured
  sea depth (TID 10 to 17), so land below sea level is not shown as water. GMRT (CC BY 4.0) is the backup and
  is labeled GMRT. GEBCO's own WMS answers GetFeatureInfo with no values, so it cannot be used for this.
- **Nautical chart (Kartverket, Norway)**: `https://cache.kartverket.no/v1/wmts/1.0.0/sjokartraster/default/webmercator/{z}/{y}/{x}.png`,
  open data under CC BY 4.0, credit "&copy; Kartverket", not approved for navigation. Norway and Svalbard waters.
- New hosts: cache.kartverket.no (images) and dap.ceda.ac.uk (spot depth) added to the page's allowed sources; neither is cached.

## Changes in 1.5.1

- New **World depth (GEBCO, worldwide)** option in the Maps panel: ocean depth shading for the whole world
  (land is shaded by height). GEBCO WMS 1.3.0 `https://wms.gebco.net/mapserv`, layer `GEBCO_LATEST`
  (shaded relief), EPSG:3857, PNG, native to zoom 10 and scaled above. Reference only: no channels,
  hazards or harbor detail, **not for navigation**, needs a signal.
- GEBCO covers land and sea, so it hides the street map; the street map stays underneath only as a fallback.
  The Seamarks overlay still draws on top.
- Attribution as GEBCO requests: "Imagery reproduced from the GEBCO_2026 Grid, GEBCO Compilation Group (2026)
  GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa)". The service reports GEBCO_2026, so the existing
  Weather → World sea depth credit now says 2026 too (it was 2024).
- Not cached: wms.gebco.net is not in `sw.js` TILE_HOSTS. Offline map and About text updated.
  (wms.gebco.net was already in the page's allowed image sources for World sea depth.)
- `tests/charts.mjs` now also checks World depth, and World depth with Seamarks on top.

## Changes in 1.5.0

- New **Maps** button on the map (under Full map, also there in Full map) opens **Map type**:
  - **Street map** (default, unchanged; Place names in More tools still applies to it).
  - **Topo map (USGS, U.S. only)**: `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}` (native to zoom 16, scaled above).
  - **Topo map (OpenTopoMap, worldwide)**: `https://tile.opentopomap.org/{z}/{x}/{y}.png` (native to zoom 17). Low-volume use as OpenTopoMap asks: tiles load only for the area being viewed, no prefetch, attribution shown.
  - **Nautical chart (NOAA, U.S. waters)**: NOAA Office of Coast Survey chart display WMS 1.3.0,
    `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer`, layers 0 to 12, EPSG:3857, transparent PNG.
  - **Aerial imagery (USGS, U.S. only)**: `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`. This is imagery, not a satellite connection.
  - **Seamarks** overlay (any map type): `https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png`.
- Charts draw above the street map, which stays underneath, so areas outside a chart's coverage show streets.
  They sit below weather, ocean layers, pins and measuring. Each layer adds its credit to the map attribution.
- Plain note in the panel: for reference only; does not replace official charts, a compass, or a marine chart plotter;
  needs a signal to load live map pieces. **These layers are not cached** (not in `sw.js` TILE_HOSTS) and are not part of the offline map.
- Choices are kept on this device: `readyMap.mapType.v1` (`streets`, `topo`, `opentopo`, `nautical`, `imagery`; default `streets`)
  and `readyMap.seamarks.v1` (`true`/`false`, default off). GPS, Full map, measure, ocean pin details and warning text are unchanged.
- The radar loop button moved down one slot to make room. The About link example now uses a neutral spot.
- Browser check: `node tests/charts.mjs http://127.0.0.1:8000/` switches every map type at 390px and 1280px and checks credits.

## Changes in 1.4.7

- Each measurement leg now keeps its initial compass heading and degrees alongside distance.
- Measure keeps a compact weather/marine summary for the last tapped point, including in Full map. Zooming does not clear the readings; while a new spot loads, previous readings remain explicitly labelled with their coordinates.
- Ocean pins show sea surface temperature, current speed and direction **toward**, and estimated depth when available, also in Weather facts. Text wraps on phones.
- Currents and temperature: Open-Meteo; bathymetry: GMRT/GEBCO. Missing depth does not prevent weather. These are model/bathymetry estimates, **not for navigation** or safe-clearance decisions. No new accounts or keys.

## Changes in 1.4.6

- Full map no longer drops the readable map on phones. A brief WebGL pause while the
  map canvas grows is allowed to recover instead of immediately showing
  "Readable map unavailable" and switching to the original map.
- After Full map or Restore, the vector map is asked to resize. The original map
  remains the fallback if the readable map truly cannot start or stay up.

## Changes in 1.4.5

- **Full map** on the map hides the header, tool row and location card so the map
  fills the viewport. The floating **Restore controls** button (or Escape) restores them.
- Red **Call 911** and orange **Share my location** remain as compact floating actions.
  Status/error messages and share fallbacks remain visible as overlays; attribution stays visible.
- Saved locally as `readyMap.fullMap.v1` (`true` / `false`), default off. Storage failures
  do not prevent toggling. GPS, place names, map tiles, radar loop and warning wording are unchanged.
- The mode fills the web page viewport, not the phone's system/browser bars.
- Controller regression checks: `node tests/full-map.mjs`. The existing browser smoke
  test now checks 390px full-map sizing, restore, persistence, emergency colors/tap targets,
  and radar controls. It writes `/workspace/ready-map-v145-chrome.png` and
  `/workspace/ready-map-v145-fullmap.png` (override with `READY_MAP_CHROME_SHOT` and
  `READY_MAP_FULL_SHOT` for separate local/live captures).

## Changes in 1.4.4

- **Detailed streets are back in Easy to read.** OpenFreeMap Bright uses OpenStreetMap
  data, small streets and buildings, with Latin/English names where available (often bilingual).
  It is closer to the original colorful street map, but is not the exact OSM Carto style.
- **Local names** still shows the exact original OpenStreetMap raster map. The same
  `readyMap.mapNames.v1` preference is retained. No automatic translation of official warnings.
- Esri is no longer used. If WebGL or the readable map service is unavailable, the app
  falls back to original OSM for this visit without replacing the saved choice.
- MapLibre GL JS **5.24.0** (CSP main + same-origin worker) and its Leaflet bridge **0.1.4**
  are pinned in `vendor/`, along with their licenses. No build step or runtime CDN.
  Leaflet still handles interactions, pins, measuring, radar and other weather/ocean overlays.
- OpenFreeMap resources are cached only as viewed, sharing the **500-item** cap with OSM.
  Styles, source metadata, glyphs and sprites count toward that cap too; no area downloads
  or prefetch. Browser requests keep the browser User-Agent (JavaScript cannot reliably set it);
  the normal referrer identifies Ready Map. This is not an offline download facility.
- Tradeoffs: roughly 1.5 MB additional uncompressed renderer/worker/CSS; WebGL required
  for readable maps, bilingual names can take more space, and some places lack Latin labels.

## Changes in 1.4.3

- **Easy-to-read place names, worldwide.** The default map is now Esri World Street Map, which writes
  places in a script most people can read (Beijing, Tianjin, Shijiazhuang, Tokyo, Seoul) instead of only
  the local script (北京市, 天津市, 石家庄市). Before, the OpenStreetMap tiles showed China, Japan, Korea
  and other places only in their own language.
- **More tools → Place names on the map**: **Easy to read** (Esri, default) or **Local names**
  (OpenStreetMap, each place in its own language). The choice is kept on this device
  (`localStorage` key `readyMap.mapNames.v1`, `readable` or `local`).
- The map credit line follows the map you picked (Esri and its sources, or OpenStreetMap).
- Radar, weather, ocean layers, locate, measure and the radar loop button work the same on both maps.
  Weather warning text is never changed or translated.
- The service worker caches viewed tiles from both map hosts (`TILE_HOSTS` in `sw.js`; for Esri only
  the World Street Map tile path), still max 500 in total.

## Changes in 1.4.2

- **Radar loop keeps playing after you close Weather.** Closing the Weather sheet (or opening a warning's
  details) used to stop the loop. Now closing it only hides the sheet: the radar stays on the map and keeps
  looping. Only **Pause loop** or turning radar off stops it. The loop rests while the app is in the
  background and starts again when you come back. It also keeps going when the map switches radar source.
- **Radar loop button on the map** (top right). It shows whenever radar is on and has loop frames.
  Tap it to play or pause the loop without opening Weather. While it plays, it shows the frame time.
  It stays in step with **Play loop / Pause loop** in Weather.

## Changes in 1.4.1

- **Anonymous visitor counter** ([GoatCounter](https://www.goatcounter.com/), no cookies). The site code
  (`readymap`) is in one spot: the `data-goatcounter` script tag at the end of `index.html` (also update the
  `readymap.goatcounter.com` host in the CSP there if you change it). Dashboard: <https://readymap.goatcounter.com/>.
- It sends one page view (the page path only; the `?lat=..&lon=..` link query, title and referrer path are
  stripped in `app.js`) and these event names, nothing else: `start-gps`, `weather-opened`,
  `compass-opened`, `measure-distance`, `share-used`. Never coordinates, tapped spots or labels.
- If the counter is blocked or the phone is offline, nothing changes. The service worker never caches
  or intercepts the counter. About and privacy says so in one line.

## Changes in 1.4.0

- **Point to this spot** (This spot panel, and **Point here (compass)** on each Find nearby result):
  opens the existing compass with a blue arrow that turns toward the spot as the phone turns, plus the
  straight-line distance (mi/km, ft/m when close) and direction (degrees, N/NE…) from your GPS spot,
  and "Turn left/right N°". Uses the same heading code as the compass (iOS `webkitCompassHeading`
  after `DeviceOrientationEvent.requestPermission()` from the tap; Android `deviceorientationabsolute`).
  Without a compass or permission it still shows distance and direction, and uses the GPS direction
  of travel (`coords.heading` when moving faster than 1 m/s) for the arrow. GPS is only used on the
  phone; nothing is sent anywhere.
- **Measure distance** (More tools): while on, map taps add numbered points joined by a dashed line
  (normal spot taps are paused); each leg and the total in mi/km (ft/m under 400 m), Undo last,
  Clear, From my location (starts the line at your GPS position), and Done (clears and returns to normal taps).
- Find nearby fix (below, first built as 1.3.1).

## Changes in 1.3.1

- Find nearby fixed: searches right away, races the Overpass mirrors with short timeouts, falls back
  to Photon and Nominatim, never leaves a spinner (clear message plus Google/Apple Maps buttons).
- Results list: number, name, distance and direction from the spot, address, map markers, and
  Google and Apple directions per place. Shelter help box (Red Cross / FEMA for U.S. spots).

## Network use and privacy

The app only contacts:

- `tiles.openfreemap.org` (OpenFreeMap Bright vector map, names, glyphs and sprites) or, if you pick
  **Local names**, `tile.openstreetmap.org` for map tiles. Only tiles you actually view are loaded; the service
  worker keeps them (max 500, oldest dropped first) so they show offline.
- Find nearby (since 1.3.1 it searches as soon as you tap Hospital, Shelter, Police, Fire station
  or Gas in the This spot panel; it sends that spot's coordinates):
  1. Overpass API (OpenStreetMap): staggered race over `overpass-api.de`, `overpass.kumi.systems`,
     `overpass.private.coffee`, `maps.mail.ru` (last good mirror first; the next one starts if the
     previous has not answered in 2 s; each try gives up after 7 s; first good answer wins, the rest
     are cancelled). Searches 3 km, then 12 km if nothing was found.
  2. Photon (`photon.komoot.io/reverse`, OpenStreetMap data, nearest places by tag) if Overpass has
     not answered after 2.5 s, failed, or found nothing (10 km, then 40 km).
  3. Nominatim (`nominatim.openstreetmap.org/search`, structured `amenity=` search in a box around the
     spot, at most 1 request a second) if both found nothing or failed (8 km, then 30 km).
  4. If every source fails (whole search capped at 20 s) it says so and shows Google Maps and Apple
     Maps search buttons for that category centered on the spot.
  Results are kept in memory and in localStorage for 24 h (shown without a new search for 6 h).
  Shelter lists emergency shelters / social-facility shelters first, then community centers; it notes
  that official shelters are announced by local authorities and, for U.S. spots, links the Red Cross
  open-shelter map and FEMA's text-to-shelter number.
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
- **Weather chip** (header, since 1.2.1): the same spot as Local weather, at startup, when the GPS
  fix arrives, every 5 minutes and after it moves more than 5 km (same services and cache as Local weather).
- **Spot weather** (since 1.2.1): when you select a spot, its coordinates go to `api.open-meteo.com`
  and `marine-api.open-meteo.com` (at most once per spot every 5 minutes).
- **Country lookup** (since 1.3.0): the spot (3 decimals) goes to `api-bdc.io` (BigDataCloud free
  client-side reverse geocoding) to pick the forecast model and the official weather service link,
  and the map center goes there for national radar near a border. Cached in memory per 0.1° cell.
- **Weather stations** (since 1.3.0, only when on and zoomed in to 7+): the IDs of the stations in
  view go to `mesonet.agron.iastate.edu` (at most once every 20 s, each reading kept 10 min).
- **National radar** (since 1.3.0, radar on, Automatic, zoom 6+ over Canada or Germany):
  `geo.weather.gc.ca` (ECCC GeoMet) or `maps.dwd.de` (DWD GeoServer) see the map area.
- Google Maps / Apple Maps only when you tap their links.

Weather, ocean and world data are never cached by the service worker (it only handles the app's
own files and base map tiles). No cookies, no analytics.

## Map layers (Weather sheet)

Every layer has an on/off switch (`toggle-*`), a see-through slider (`opacity-*`), a
"Data from" line (`time-*`) and a legend. All are off by default, nothing loads until you turn
one on, and on/off is not saved between visits.

A one-line note at the top of the sheet says: layers marked U.S. only work in the United States;
World layers work everywhere.

| Layer | Coverage | Source | Notes |
| --- | --- | --- | --- |
| Weather stations (`toggle-stations`, 1.3.0) | World, zoom 7+ | Iowa Environmental Mesonet `api/1/currents.json?station=..` (METAR/ASOS/AWOS) + shipped `stations.json` (~5,200 stations: id, lat, lon) | dot = °F now (gray if older than 2 h); tap: name, temp °F/°C, wind mph/direction/gusts, visibility, observed time; up to 60 stations in view (grid-thinned, ICAO airports first), one request ≥ 20 s apart, readings cached 10 min; "Data from" = updated time, station count, newest reading. aviationweather.gov was not used: it sends no CORS header, so browsers block it |
| Rain radar (`toggle-radar`) | World (U.S. detail from NOAA; Canada and Germany national radar) | NOAA nowCOAST (`base_reflectivity_mosaic`); RainViewer world radar | "Which radar" radios `name="radar-area"`: `auto` (NOAA when the map center is in CONUS, Alaska, Hawaii, Puerto Rico/USVI or Guam, else RainViewer; re-picked on `moveend`, debounced; since 1.3.0 at zoom 6+ over Canada it uses ECCC GeoMet `RADAR_1KM_RRAI` and over Germany DWD `dwd:RADOLAN-RY`, both with a time loop from their own GetCapabilities; near borders the country is looked up once; if their tiles fail it falls back to RainViewer), `us` (NOAA, falls back to RainViewer if NOAA fails), `world` (RainViewer, max native zoom 7). "Data from" names the source |
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
old result) and `#localwx-refresh`. The header weather chip (`#wx-chip`) also opens it.

| Where | Source |
| --- | --- |
| U.S. | `https://api.weather.gov/points/{lat4},{lon4}` → `forecast` (day/night periods paired into days), `forecastHourly` (next 24), `observationStations?limit=1` → `/stations/{ID}/observations/latest` (NWS station name and reading time; older than 2 h is flagged; no reading → first forecast hour), `alerts/active?point=` (same parsing as the Weather warnings layer, **Read more** opens the warning). Each call retries once after 2 s on 500/503. If both forecasts fail, the forecast comes from Open-Meteo |
| Outside the U.S. (points 404 or fails) | `https://api.open-meteo.com/v1/forecast?...&current=...&hourly=...&daily=...&forecast_days=7&forecast_hours=24&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph`. Warnings: points to World disaster alerts, and lists GDACS events within 300 km (reuses the layer's data if it is on, else one `EVENTS4APP` request kept 15 min) |

Only `Accept` is sent (no custom headers; browsers do not allow setting User-Agent). Results are kept
in memory only (never in the service worker or storage; the main-screen chip saves just its last
temperature line, see below), keyed by the point rounded to 2 decimals;
any result within 2 km is reused, and the same area is never fetched again within 5 minutes (Refresh
says "Already up to date"). Auto-refresh every 15 minutes (or after moving more than 2 km) while GPS
is on and the card was opened once; paused while the page is hidden. Offline: the last result with
"Saved from <time>", or a plain offline message. Pure helpers: `ReadyMap.cToF`, `ReadyMap.fToC`,
`ReadyMap.wmoCodeText` (WMO code → words), `ReadyMap.degToCompass` (degrees → 16-point, e.g. 225 → `SW`),
`ReadyMap.compassWords` (`SW` → `southwest`). Open-Meteo: "Weather data by Open-Meteo.com", CC BY 4.0,
free tier for non-commercial use (< 10,000 calls/day).

Sharper models (1.3.0): Open-Meteo's `best_match` does not say which model it used, so outside the
U.S. the card asks for the sharp national model by name (`&models=..._seamless`, picked by country,
else by area; table `ReadyMap.models.list`): NOAA HRRR 3 km (`gfs_seamless`), Canada HRDPS 2.5 km
(`gem_seamless`), UK Met Office UKV 2 km, DWD ICON-D2 2 km (`icon_seamless`), Météo-France AROME 1.3 km,
MeteoSwiss ICON-CH1 1 km, KNMI and DMI HARMONIE 2 km, ItaliaMeteo ICON-2I 2 km, MET Norway Nordic 1 km,
JMA MSM 5 km. Values the sharp model does not cover (later days) are filled from `best_match`;
elsewhere it uses `best_match`. `#localwx-source` says "Model: …" (U.S.: "NWS forecast grid (2.5 km)").

## Weather chip on the main screen (`#wx-chip`, new in 1.2.1)

A small button in the header, next to the Online badge, always shows the current temperature and
short sky words, for example `48°F · Partly Cloudy`. It sits in the header, not over the map, so it
never covers map controls; on narrow phones the sky words shrink with an ellipsis and the temperature
always shows. Tapping it opens the Local weather card (`#sheet-localwx`). It has an `aria-label` with
the full reading ("Weather now: 48°F, Partly Cloudy. Open local weather.").

It uses the same point as the card (GPS fix, else the selected spot, else the map center) and the
card's own fetch and cache, so the same 5-minute limit applies and a request already on its way is
shared, never doubled. It loads at startup and when the GPS fix arrives, then refreshes every 5
minutes and when the weather point moves more than 5 km (map moves, debounced). Offline (or if a
fetch fails), it shows the last saved reading with a "· saved" mark and a dashed border; with nothing
saved from the last 24 hours it hides. Only the last temperature, sky words, time and point are saved
(`localStorage` key `readymap.wxchip.v1`). Test hook: `ReadyMap.wxChip` (`state`, `check(force)`,
`shortSky(text)`).

Since 1.3.0 the chip also shows where its number comes from (`#wx-chip-src`: "station" for a
National Weather Service station reading, "model" for a forecast model), also in its `aria-label`.

## Weather for the selected spot (This spot panel, new in 1.2.1)

When a spot is selected (map tap, pin, shared link, saved place or GPS), the point card shows one
line (`#point-wx`, e.g. `Weather: 80°F / 26°C · Clear sky · Sea 80°F`) and **More → This spot**
starts with **Weather here** (`#spotwx`): air temperature °F/°C, sky words, wind (mph, direction,
gusts), today's high and low, and for water spots sea surface temperature and waves (height in m and
ft, period, direction they come from). **Full forecast** (`#btn-spotwx-full`) opens the Local weather
card for that exact spot.

| Data | Source |
| --- | --- |
| Air, sky, wind, high/low (worldwide, also over the ocean) | `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph` |
| Sea temperature, waves | `https://marine-api.open-meteo.com/v1/marine?latitude=..&longitude=..&current=sea_surface_temperature,wave_height,wave_direction,wave_period`. Water is detected by non-null values; on land every value is null and the marine rows are hidden |

Results are cached in memory per spot (lat/lon rounded to 2 decimals) for 5 minutes; requests wait
350 ms so quick re-selections do not each send one. Offline: a spot already fetched shows its weather
marked "Saved"; a new spot says weather needs internet. If one API fails the other still shows.
Test hook: `ReadyMap.spotWeather` (`state`, `update()`, `parseForecast`, `parseMarine`,
`forecastUrl`, `marineUrl`, `waveLine`, `chipMatch`).

1.3.0: the forecast uses the same sharp-model choice as Local weather. If the spot is within 2 km
of the header chip's spot (chip reading fresh, not saved), Air and Sky reuse the chip's reading so
the two numbers match; the **Source** row says "Same as the top bar: weather station KSLC…" or
"Forecast model: DWD ICON-D2 (2 km)". `#spotwx-official` links the official weather service for
the spot's country (table `ReadyMap.wxServices`; each URL was checked to load on 2026-11-02; U.S.
links go to the NWS point forecast). Over open sea there is no link.

## Offline map (no area download)

The [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) (and [OpenFreeMap terms](https://openfreemap.org/tos/)) do not allow bulk
download or prefetch features, so there is no "download this area" button. **More tools → Offline
map** (`#btn-save-area`) explains how it works: the map keeps the tiles you have already looked at
(up to 500), so to keep an area, look around it at the zoom levels you need while you have signal.
The panel shows how many tiles are kept and has **Clear saved map**.

The tile sources are the `BASEMAPS` object at the top of `app.js` (`readable` = OpenFreeMap Bright, `local` = OSM;
each has `style` (vector) or `url` (raster), `attribution`, `maxZoom`, `allowPrefetch: false`; `TILE_PROVIDER` is the active one).
A new provider also needs its host in `TILE_HOSTS` in `sw.js` and the CSP in
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
`pointer.pointToSpot({lat, lon, name})`, `pointer.formatMeasure(m)`, `measure.{start, stop, add(lat, lon), total()}` (1.4.0), `nearby.findNearby(cat, point, signal, say)` and `nearby.sources.{overpass,photon,nominatim}(cat, point, signal)` (1.3.1),
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
CoastWatch blended geostrophic currents, GEBCO Compilation Group (2026) GEBCO 2026 Grid.
