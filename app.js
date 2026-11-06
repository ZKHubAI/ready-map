/* Ready Map — app logic. Vanilla JS, no build step, no third-party code except vendored Leaflet.
 * Sections:
 *   1. Constants
 *   2. Pure helpers (exposed on window.ReadyMap for tests)
 *   3. DOM + status helpers
 *   4. Map setup
 *   5. Selected point + point card
 *   6. GPS (watchPosition / getCurrentPosition)
 *   7. Copy / share / emergency share
 *   8. Sheets (dialogs)
 *   9. Saved places + GPX
 *  10. Find nearby (Overpass race, Photon + Nominatim backups, map links)
 *  11. Offline save area
 *  12. Network status + service worker
 *  13. Compass (13b. Point to a spot, 13c. Measure distance: 1.4.0)
 *  14. Weather overlays (radar, satellite, warnings, world disaster alerts) + Ocean layers
 *      (currents, sea temperature, depth lines, marine zones, world currents, world sea depth)
 *  15. Startup
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Constants
  // ---------------------------------------------------------------------------
  var VERSION = '1.4.5';
  // Detailed OSM-based streets with readable/bilingual labels; exact OSM Carto remains optional.
  // Only viewed resources are cached (500 items shared by both maps); never prefetch an area.
  var BASEMAPS = {
    readable: {
      style: 'https://tiles.openfreemap.org/styles/bright',
      attribution: '<a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
      allowPrefetch: false
    },
    local: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
      allowPrefetch: false
    }
  };
  var MAP_NAMES_KEY = 'readyMap.mapNames.v1';   // 'readable' | 'local'
  var DEFAULT_MAP_NAMES = 'readable';
  var TILE_PROVIDER = BASEMAPS[DEFAULT_MAP_NAMES]; // the active one (set again in initMap)
  var NOAA_ATTRIBUTION = 'Weather: <a href="https://www.weather.gov/">NOAA / National Weather Service</a>';
  var RAINVIEWER_ATTRIBUTION = 'Radar fallback: <a href="https://www.rainviewer.com/">RainViewer</a>';
  var NOWCOAST_OCEAN_ATTRIBUTION = 'Ocean: <a href="https://nowcoast.noaa.gov/">NOAA nowCOAST</a>';
  var ENC_ATTRIBUTION = 'Depths: <a href="https://nauticalcharts.noaa.gov/">NOAA Office of Coast Survey</a> ENC (not for navigation)';
  var MARINE_ZONES_ATTRIBUTION = 'Marine zones: <a href="https://www.weather.gov/marine/">National Weather Service</a>';
  var GMGSI_ATTRIBUTION = 'World clouds: <a href="https://www.nesdis.noaa.gov/">NOAA/NESDIS</a> GMGSI via NOAA nowCOAST';
  var GDACS_ATTRIBUTION = 'Disaster alerts: <a href="https://www.gdacs.org/">GDACS</a>';
  var COASTWATCH_ATTRIBUTION = 'World currents: <a href="https://coastwatch.noaa.gov/">NOAA CoastWatch</a> (not for navigation)';
  var GEBCO_ATTRIBUTION = 'Sea depth: <a href="https://www.gebco.net/">GEBCO Compilation Group (2024) GEBCO Grid</a>';
  // Must match names in sw.js. SAVED_CACHE is the old (1.0.0) prefetch cache; it is only
  // deleted now (sw.js removes it on activate, "Clear saved map" removes it too).
  var SAVED_CACHE = 'ready-map-saved-v1';
  var TILE_CACHE = 'ready-map-tiles-v1';
  var MAX_VIEWED_TILES = 500; // must match MAX_TILES in sw.js
  var PLACES_KEY = 'readyMap.places.v1';
  var DEFAULT_CENTER = [39.8283, -98.5795];
  var DEFAULT_ZOOM = 4;
  // Public Overpass mirrors, tried in order with failover (the last one that worked goes first).
  var OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  var OVERPASS_MIRROR_KEY = 'readyMap.overpassMirror.v1';
  // 1.3.1: short tries, staggered race (see overpassFetch), then backup sources.
  var OVERPASS_TRY_MS = 7000;
  var OVERPASS_STAGGER_MS = 2000;
  var OVERPASS_SKIP_MS = 5 * 60 * 1000;
  // Backup sources (free, no key, CORS open; both serve OpenStreetMap data).
  var PHOTON_URL = 'https://photon.komoot.io/reverse';
  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  var PHOTON_RADII_KM = [10, 40];
  var NOMINATIM_RADII = [8000, 30000];
  var NEARBY_SOURCE_MS = 6000;        // per backup request
  var NEARBY_BACKUP_AFTER_MS = 2500;  // start the backup if Overpass has not answered by then
  var NEARBY_GIVE_UP_MS = 20000;      // hard cap for the whole search
  var NEARBY_FRESH_MS = 6 * 3600 * 1000; // saved results this new are shown without a new search
  var NEARBY_MAX_ITEMS = 15;
  var NEARBY_STORE_KEY = 'readyMap.nearby.v1';
  var NEARBY_STORE_MAX = 30;
  var NEARBY_STORE_TTL = 24 * 3600 * 1000;
  var NEARBY_RADII = [3000, 12000];
  var FETCH_TIMEOUT_MS = 15000;

  var reduceMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reducedMotion() { return !!(reduceMotionQuery && reduceMotionQuery.matches); }

  // ---------------------------------------------------------------------------
  // 2. Pure helpers
  // ---------------------------------------------------------------------------

  /** Trim a coordinate to at most 6 decimals, no trailing zeros (for URLs). */
  function coordStr(n) {
    return String(Number(Number(n).toFixed(6)));
  }

  function formatDecimal(lat, lon) {
    return Number(lat).toFixed(6) + ', ' + Number(lon).toFixed(6);
  }

  function dmsPart(value, pos, neg) {
    var hemi = value >= 0 ? pos : neg;
    // Work in whole tenths of a second so 59.95" rolls over to the next minute/degree.
    var tenths = Math.round(Math.abs(value) * 36000);
    var deg = Math.floor(tenths / 36000);
    tenths -= deg * 36000;
    var min = Math.floor(tenths / 600);
    tenths -= min * 600;
    var sec = (tenths / 10).toFixed(1);
    return deg + '°' + min + "'" + sec + '"' + hemi;
  }

  /** Degrees/minutes/seconds, e.g. 40°45'38.9"N 111°53'27.6"W */
  function toDMS(lat, lon) {
    return dmsPart(Number(lat), 'N', 'S') + ' ' + dmsPart(Number(lon), 'E', 'W');
  }

  var NUM_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

  /**
   * Parse deep-link params: ?lat=..&lon=..&label=..&zoom=..
   * Returns { present:false } when no lat/lon given,
   * { present:true, ok:true, lat, lon, zoom, label } when valid,
   * { present:true, ok:false, error } when invalid.
   */
  function parseParams(search) {
    var params;
    try {
      params = new URLSearchParams(typeof search === 'string' ? search : '');
    } catch (e) {
      return { present: true, ok: false, error: 'The link could not be read.' };
    }
    var latRaw = params.get('lat');
    var lonRaw = params.get('lon');
    if (lonRaw === null) lonRaw = params.get('lng');
    if (latRaw === null && lonRaw === null) return { present: false, ok: false };
    if (latRaw === null || lonRaw === null) {
      return { present: true, ok: false, error: 'The link needs both lat and lon.' };
    }
    latRaw = latRaw.trim();
    lonRaw = lonRaw.trim();
    if (!NUM_RE.test(latRaw) || !NUM_RE.test(lonRaw)) {
      return { present: true, ok: false, error: 'The lat and lon in the link must be numbers.' };
    }
    var lat = parseFloat(latRaw);
    var lon = parseFloat(lonRaw);
    if (!isFinite(lat) || Math.abs(lat) > 90) {
      return { present: true, ok: false, error: 'Latitude (lat) must be between -90 and 90.' };
    }
    if (!isFinite(lon) || Math.abs(lon) > 180) {
      return { present: true, ok: false, error: 'Longitude (lon) must be between -180 and 180.' };
    }
    var zoom = 15;
    var zRaw = params.get('zoom');
    if (zRaw !== null && NUM_RE.test(zRaw.trim())) {
      zoom = Math.round(parseFloat(zRaw));
      if (!isFinite(zoom)) zoom = 15;
      zoom = Math.min(19, Math.max(1, zoom));
    }
    var label = params.get('label');
    if (label !== null) {
      // Strip control characters and limit length. Text is only ever rendered with textContent.
      label = label.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 80);
    }
    return { present: true, ok: true, lat: lat, lon: lon, zoom: zoom, label: label || '' };
  }

  function escapeXml(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** GPX 1.1 document with one waypoint per pin. */
  function buildGpx(pins) {
    var now = new Date().toISOString();
    var out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Ready Map ' + VERSION + '" xmlns="http://www.topografix.com/GPX/1/1"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      '  <metadata>',
      '    <name>Ready Map places</name>',
      '    <time>' + now + '</time>',
      '  </metadata>'
    ];
    (pins || []).forEach(function (p) {
      var lat = Number(p.lat), lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      out.push('  <wpt lat="' + lat.toFixed(6) + '" lon="' + lon.toFixed(6) + '">');
      if (p.created) {
        var t = new Date(p.created);
        if (!isNaN(t)) out.push('    <time>' + t.toISOString() + '</time>');
      }
      out.push('    <name>' + escapeXml(p.name || 'Place') + '</name>');
      if (p.accuracy) out.push('    <desc>' + escapeXml('GPS accuracy about ' + Math.round(p.accuracy) + ' m') + '</desc>');
      out.push('  </wpt>');
    });
    out.push('</gpx>');
    return out.join('\n') + '\n';
  }

  function googleDirUrl(lat, lon) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + coordStr(lat) + ',' + coordStr(lon);
  }
  function appleDirUrl(lat, lon) {
    return 'https://maps.apple.com/?daddr=' + coordStr(lat) + ',' + coordStr(lon);
  }
  /** Short coordinate for map-search links (5 decimals, about 1 m). */
  function searchCoord(n) { return String(Number(Number(n).toFixed(5))); }
  /**
   * Google Maps search centred on the point. The coordinates go in the '@lat,lon,zoom' part of the
   * path, not in the query text (Google misreads 'X near 40.72,-111.85' and can jump to another state).
   */
  function googleSearchUrl(word, lat, lon) {
    return 'https://www.google.com/maps/search/' + encodeURIComponent(String(word)).replace(/%20/g, '+') +
      '/@' + searchCoord(lat) + ',' + searchCoord(lon) + ',14z';
  }
  function appleSearchUrl(word, lat, lon) {
    return 'https://maps.apple.com/?q=' + encodeURIComponent(String(word)) +
      '&sll=' + searchCoord(lat) + ',' + searchCoord(lon) + '&z=14';
  }
  function googlePointUrl(lat, lon) {
    return 'https://www.google.com/maps/search/?api=1&query=' + coordStr(lat) + ',' + coordStr(lon);
  }

  /** Ready Map deep link, same format parseParams reads. */
  function buildSpotUrl(lat, lon, label, zoom) {
    var base = location.origin && location.origin !== 'null' ? location.origin + location.pathname : location.href.split('?')[0];
    var url = base + '?lat=' + coordStr(lat) + '&lon=' + coordStr(lon);
    if (zoom) url += '&zoom=' + Math.min(19, Math.max(1, Math.round(zoom)));
    if (label) url += '&label=' + encodeURIComponent(label);
    return url;
  }

  function lon2tile(lon, z) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, z));
  }
  function lat2tile(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }

  /** Normalize bounds input: L.LatLngBounds, {north,south,east,west}, or [[s,w],[n,e]]. */
  function normBounds(b) {
    if (!b) throw new Error('bounds required');
    if (typeof b.getNorth === 'function') {
      return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
    }
    if (Array.isArray(b)) {
      return { south: b[0][0], west: b[0][1], north: b[1][0], east: b[1][1] };
    }
    return { north: b.north, south: b.south, east: b.east, west: b.west };
  }

  /**
   * Tiles covering bounds for zooms zFrom..zTo.
   * Returns { count, tiles:[{z,x,y}], truncated } — tiles list is only filled up to opts.maxList (default 2000).
   */
  function tilesForBounds(bounds, zFrom, zTo, opts) {
    var maxList = (opts && opts.maxList) || 2000;
    var b = normBounds(bounds);
    var clampLat = function (v) { return Math.max(-85.05112878, Math.min(85.05112878, v)); };
    var north = clampLat(Math.max(b.north, b.south));
    var south = clampLat(Math.min(b.north, b.south));
    var west = b.west, east = b.east;
    // Whole world or more: clamp.
    if (east - west >= 360) { west = -180; east = 180; }
    var spans = [];
    var normLon = function (v) { return ((((v + 180) % 360) + 360) % 360) - 180; };
    if (west >= -180 && east <= 180) {
      spans.push([west, east]);
    } else {
      var w = normLon(west), e = normLon(east);
      if (w <= e) spans.push([w, e]); else { spans.push([w, 180]); spans.push([-180, e]); }
    }
    zFrom = Math.max(0, Math.round(zFrom));
    zTo = Math.max(zFrom, Math.round(zTo));
    var count = 0;
    var tiles = [];
    for (var z = zFrom; z <= zTo; z++) {
      var max = Math.pow(2, z) - 1;
      var y0 = Math.max(0, Math.min(max, lat2tile(north, z)));
      var y1 = Math.max(0, Math.min(max, lat2tile(south, z)));
      var seen = {};
      for (var s = 0; s < spans.length; s++) {
        var x0 = Math.max(0, Math.min(max, lon2tile(spans[s][0], z)));
        var x1 = Math.max(0, Math.min(max, lon2tile(spans[s][1] - 1e-9, z)));
        for (var x = x0; x <= x1; x++) {
          if (seen[x]) continue;
          seen[x] = true;
          for (var y = y0; y <= y1; y++) {
            count++;
            if (tiles.length < maxList) tiles.push({ z: z, x: x, y: y });
          }
        }
      }
    }
    return { count: count, tiles: tiles, truncated: count > tiles.length };
  }


  /** Great-circle distance in meters. */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function formatDistance(m) {
    var miles = m / 1609.344;
    if (miles < 0.1) return Math.round(m * 3.28084) + ' ft';
    return (miles < 10 ? miles.toFixed(1) : Math.round(miles)) + ' mi';
  }

  function formatAccuracy(m) {
    return Math.round(m) + ' m (' + Math.round(m * 3.28084) + ' ft)';
  }

  var CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function cardinal(deg) {
    return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  function formatLocalTime(d) {
    var date = d instanceof Date ? d : new Date(d);
    if (isNaN(date)) return '';
    try {
      return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return date.toString();
    }
  }

  var SEVERITY_COLORS = {
    extreme: '#7b1fa2',
    severe: '#d32f2f',
    moderate: '#f57c00',
    minor: '#fbc02d',
    unknown: '#607d8b'
  };
  function severityColor(sev) {
    var k = String(sev || '').toLowerCase();
    return SEVERITY_COLORS[k] || SEVERITY_COLORS.unknown;
  }
  var SEVERITY_RANK = { unknown: 0, minor: 1, moderate: 2, severe: 3, extreme: 4 };
  function severityRank(sev) {
    var r = SEVERITY_RANK[String(sev || '').toLowerCase()];
    return r == null ? 0 : r;
  }

  /** Parse ISO 8601 duration like PT4M, PT1H, PT30S into ms. */
  function parseIsoDuration(s) {
    var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s).trim());
    if (!m) return 0;
    return ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
  }

  /** Expand a WMS time dimension text (comma list and/or start/end/period) into ISO strings. */
  function expandTimeText(text) {
    var out = [];
    String(text || '').split(',').forEach(function (part) {
      part = part.trim();
      if (!part) return;
      if (part.indexOf('/') !== -1) {
        var bits = part.split('/');
        var start = Date.parse(bits[0]), end = Date.parse(bits[1]), step = parseIsoDuration(bits[2] || '');
        if (isNaN(start) || isNaN(end)) return;
        if (!step) { out.push(new Date(start).toISOString(), new Date(end).toISOString()); return; }
        // Keep only the most recent 200 steps of a long interval.
        var first = Math.max(start, end - step * 200);
        first = start + Math.ceil((first - start) / step) * step;
        for (var t = first; t <= end; t += step) out.push(new Date(t).toISOString());
        return;
      }
      var ms = Date.parse(part);
      if (!isNaN(ms)) out.push(new Date(ms).toISOString());
    });
    return out;
  }

  /**
   * Read the time dimension from WMS GetCapabilities XML.
   * Returns { times:[ISO sorted unique], def: ISO|null }. If layerName is given and found, use that layer.
   */
  function parseWmsDimension(xmlText, layerName, dimName) {
    var want = String(dimName || 'time').toLowerCase();
    var timeText = null, def = null;
    if (typeof DOMParser !== 'undefined') {
      try {
        var doc = new DOMParser().parseFromString(String(xmlText), 'application/xml');
        if (!doc.getElementsByTagName('parsererror').length) {
          var dim = null;
          if (layerName) {
            var names = doc.getElementsByTagName('Name');
            for (var i = 0; i < names.length && !dim; i++) {
              if (names[i].textContent.trim() === layerName && names[i].parentNode &&
                  names[i].parentNode.localName === 'Layer') {
                var kids = names[i].parentNode.children;
                for (var k = 0; k < kids.length; k++) {
                  if ((kids[k].localName === 'Dimension' || kids[k].localName === 'Extent') &&
                      String(kids[k].getAttribute('name')).toLowerCase() === want) { dim = kids[k]; break; }
                }
              }
            }
          }
          if (!dim) {
            var dims = doc.getElementsByTagName('Dimension');
            for (var j = 0; j < dims.length; j++) {
              if (String(dims[j].getAttribute('name')).toLowerCase() === want) { dim = dims[j]; break; }
            }
          }
          if (dim) { timeText = dim.textContent; def = dim.getAttribute('default'); }
        }
      } catch (e) { /* fall through to regex */ }
    }
    if (timeText === null) {
      var m = want === 'time' ? /<Dimension[^>]*name="time"[^>]*>([^<]*)<\/Dimension>/i.exec(String(xmlText)) : null;
      if (m) {
        timeText = m[1];
        var dm = /default="([^"]+)"/i.exec(m[0]);
        def = dm ? dm[1] : null;
      }
    }
    var list = expandTimeText(timeText || '');
    // listed: only the values the server lists (no default added). Time-enabled nowCOAST ocean
    // layers need one of these exact values; an in-between time gives an empty tile.
    var listed = Array.from(new Set(list)).sort();
    var defIso = null;
    if (def && !isNaN(Date.parse(def))) {
      defIso = new Date(Date.parse(def)).toISOString();
      list.push(defIso);
    }
    var uniq = Array.from(new Set(list)).sort();
    return { times: uniq, def: defIso, listed: listed };
  }

  /**
   * Pick the WMS time to send: the latest listed time that is not in the future (<= nowMs).
   * If every time is in the future, the one closest to now. Returns the exact string from
   * the array (never a re-formatted or in-between value), or null if there is none.
   */
  function pickWmsTime(times, nowMs) {
    if (!Array.isArray(times)) return null;
    var now = Number(nowMs);
    if (nowMs === undefined || nowMs === null || !isFinite(now)) now = Date.now();
    var best = null, bestMs = -Infinity, near = null, nearDiff = Infinity;
    for (var i = 0; i < times.length; i++) {
      var t = times[i];
      if (typeof t !== 'string') continue;
      var ms = Date.parse(t);
      if (isNaN(ms)) continue;
      if (ms <= now && ms > bestMs) { best = t; bestMs = ms; }
      var diff = Math.abs(ms - now);
      if (diff < nearDiff) { near = t; nearDiff = diff; }
    }
    return best !== null ? best : near;
  }

  /** Web Mercator (EPSG:3857) bounds of an XYZ tile, in meters: [xmin, ymin, xmax, ymax]. */
  function mercatorTileBbox(x, y, z) {
    var R = 20037508.342789244; // half the world width in meters
    var size = (2 * R) / Math.pow(2, z);
    var xmin = -R + x * size;
    var ymax = R - y * size;
    return [xmin, ymax - size, xmin + size, ymax];
  }

  /** Latitude of the top edge of XYZ tile row y at zoom z (Web Mercator). */
  function tileLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  /** Wrap a longitude into -180..180. */
  function wrapLon(lon) {
    var l = ((Number(lon) + 180) % 360 + 360) % 360 - 180;
    return l === -180 && lon > 0 ? 180 : l;
  }

  // NOAA nowCOAST radar areas (rough boxes, a little generous): [south, west, north, east].
  var NOAA_RADAR_BOXES = [
    [23.5, -126, 50.5, -65],    // lower 48 states
    [51, -180, 72, -129],       // Alaska (with the Aleutians)
    [18.5, -161, 23, -154],     // Hawaii
    [17.4, -68, 18.8, -64.3],   // Puerto Rico and U.S. Virgin Islands
    [13, 144.4, 15.6, 146.1]    // Guam and the Northern Mariana Islands
  ];
  /** True when a spot is inside NOAA radar coverage (CONUS, Alaska, Hawaii, PR/USVI, Guam). */
  function inNoaaRadarCoverage(lat, lon) {
    lat = Number(lat);
    if (!isFinite(lat) || !isFinite(Number(lon))) return false;
    lon = wrapLon(lon);
    return NOAA_RADAR_BOXES.some(function (b) {
      return lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
    });
  }

  var ERDDAP_CURRENTS = 'https://coastwatch.noaa.gov/erddap/griddap/noaacwBLENDEDNRTcurrentsDaily.transparentPng';
  var ERDDAP_GRID = 0.25;          // degrees between grid points
  var ERDDAP_LON_MAX = 179.875;    // grid edge (longitude)
  var ERDDAP_LAT_MAX = 89.875;     // grid edge (latitude)
  /**
   * NOAA CoastWatch ERDDAP URL for a transparent PNG of current arrows covering the lon/lat
   * box of XYZ tile (x, y, z). The box is clamped to the data grid; about 14 arrows per 256 px
   * (STRIDE grid points apart). sizePx: picture size, default 256 (the app uses 512 to send
   * fewer requests to this slow server). Returns null if nothing is left after clamping.
   */
  function erddapCurrentsUrl(x, y, z, sizePx) {
    z = Math.round(Number(z));
    x = Math.round(Number(x));
    y = Math.round(Number(y));
    var size = Math.round(Number(sizePx)) || 256;
    if (!isFinite(z) || !isFinite(x) || !isFinite(y) || z < 0 || size < 64 || size > 1024) return null;
    var n = Math.pow(2, z);
    if (y < 0 || y >= n) return null;
    x = ((x % n) + n) % n;
    var lon0 = x / n * 360 - 180, lon1 = (x + 1) / n * 360 - 180;
    var lat1 = tileLat(y, z), lat0 = tileLat(y + 1, z);
    var stride = Math.max(1, Math.round((lon1 - lon0) / ERDDAP_GRID / (14 * size / 256)));
    lon0 = Math.max(lon0, -ERDDAP_LON_MAX); lon1 = Math.min(lon1, ERDDAP_LON_MAX);
    lat0 = Math.max(lat0, -ERDDAP_LAT_MAX); lat1 = Math.min(lat1, ERDDAP_LAT_MAX);
    if (!(lon1 > lon0) || !(lat1 > lat0)) return null;
    var box = '%5B(' + lat0.toFixed(4) + '):' + stride + ':(' + lat1.toFixed(4) + ')%5D' +
      '%5B(' + lon0.toFixed(4) + '):' + stride + ':(' + lon1.toFixed(4) + ')%5D';
    return ERDDAP_CURRENTS + '?u_current%5B(last)%5D' + box + ',v_current%5B(last)%5D' + box +
      '&.draw=vectors&.vars=longitude%7Clatitude%7Cu_current%7Cv_current&.color=0x000000&.vec=1&.size=' + size + '%7C' + size;
  }

  /** GDACS dates are UTC without a zone ("2026-11-02T20:54:25"): read them as UTC. */
  function parseGdacsDate(s) {
    if (typeof s !== 'string' || !s.trim()) return null;
    var t = s.trim();
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(t)) t += 'Z';
    var d = new Date(t);
    return isNaN(d) ? null : d;
  }

  var GDACS_TYPES = { EQ: 'Earthquake', TC: 'Tropical storm', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' };
  function gdacsTypeLabel(code) { return GDACS_TYPES[String(code || '').toUpperCase()] || 'Disaster'; }
  var GDACS_LEVELS = { red: 'Red', orange: 'Orange', green: 'Green' };
  function gdacsLevel(level) { return GDACS_LEVELS[String(level || '').toLowerCase()] || 'Unknown'; }

  /**
   * Make a feed link safe to use: add https:// when the scheme is missing
   * ("www.wpc.ncep.noaa.gov/x" -> "https://www.wpc.ncep.noaa.gov/x"). Only http(s) links are kept;
   * anything else (javascript:, data:, ...) gives ''.
   */
  function fixFeedLink(link) {
    var s = String(link == null ? '' : link).trim();
    if (!s) return '';
    if (/^\/\//.test(s)) s = 'https:' + s;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    return /^https?:\/\/[^\s/?#]+/i.test(s) && !/\s/.test(s) ? s : '';
  }

  /**
   * Read the items of an RSS 2.0 feed. Returns [{ title, link, pubDate }] in feed order
   * (pubDate is the feed's own text; '' when missing). Never throws: bad XML gives [].
   */
  function parseRssItems(xmlString) {
    if (typeof xmlString !== 'string' || !xmlString.trim() || typeof DOMParser === 'undefined') return [];
    var doc;
    try { doc = new DOMParser().parseFromString(xmlString, 'text/xml'); } catch (e) { return []; }
    if (!doc || doc.getElementsByTagName('parsererror').length) return [];
    function childText(node, name) {
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === name || c.nodeName === name) return (c.textContent || '').replace(/\s+/g, ' ').trim();
      }
      return '';
    }
    var out = [];
    var items = doc.getElementsByTagName('item');
    for (var i = 0; i < items.length; i++) {
      var title = childText(items[i], 'title');
      var link = fixFeedLink(childText(items[i], 'link') || childText(items[i], 'guid'));
      if (!title && !link) continue;
      out.push({ title: title, link: link, pubDate: childText(items[i], 'pubDate') });
    }
    return out;
  }

  /** "just now", "5 minutes ago", "1 hour ago", "3 days ago" (plain words). '' if unknown. */
  function timeAgo(date, nowMs) {
    var t = date instanceof Date ? date.getTime() : typeof date === 'number' ? date : Date.parse(date);
    if (!isFinite(t)) return '';
    var now = isFinite(Number(nowMs)) && nowMs != null ? Number(nowMs) : Date.now();
    var mins = Math.round((now - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    var hrs = Math.floor(mins / 60);
    if (hrs < 48) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hrs / 24);
    return days + ' days ago';
  }

  /** Test hook: array of ISO strings (sorted, unique). */
  function parseWmsTimes(xmlText, layerName) {
    return parseWmsDimension(xmlText, layerName).times;
  }

  /** Pick up to max frames from sorted ISO times: latest, then going back at least minGapMs apart, within windowMs. */
  function pickFrames(times, max, minGapMs, windowMs) {
    if (!times.length) return [];
    var latest = Date.parse(times[times.length - 1]);
    var picked = [times[times.length - 1]];
    var lastPicked = latest;
    for (var i = times.length - 2; i >= 0 && picked.length < max; i--) {
      var t = Date.parse(times[i]);
      if (latest - t > windowMs) break;
      if (lastPicked - t >= minGapMs) { picked.push(times[i]); lastPicked = t; }
    }
    return picked.reverse();
  }

  // ----- Local weather helpers (pure) -----
  /** Celsius to Fahrenheit. null/NaN in -> null out. */
  function cToF(c) {
    if (c === null || c === undefined || c === '' || !isFinite(Number(c))) return null;
    return Number(c) * 9 / 5 + 32;
  }
  /** Fahrenheit to Celsius. null/NaN in -> null out. */
  function fToC(f) {
    if (f === null || f === undefined || f === '' || !isFinite(Number(f))) return null;
    return (Number(f) - 32) * 5 / 9;
  }

  var WMO_TEXT = {
    0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy',
    45: 'Fog', 48: 'Icy fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Light freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Light freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
  };
  /** WMO weather code (Open-Meteo weather_code) to plain words. */
  function wmoCodeText(code) {
    var n = Number(code);
    if (code === null || code === undefined || code === '' || !isFinite(n)) return 'Unknown';
    if (WMO_TEXT[n]) return WMO_TEXT[n];
    if (n >= 50 && n < 60) return 'Drizzle';
    if (n >= 60 && n < 70) return 'Rain';
    if (n >= 70 && n < 80) return 'Snow';
    if (n >= 80 && n < 90) return 'Showers';
    if (n >= 90) return 'Thunderstorm';
    return 'Cloudy';
  }

  var COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  /** Degrees (where the wind comes from) to a 16-point compass name, e.g. 225 -> 'SW'. null if unknown. */
  function degToCompass(deg) {
    if (deg === null || deg === undefined || deg === '' || !isFinite(Number(deg))) return null;
    return COMPASS16[Math.round((((Number(deg) % 360) + 360) % 360) / 22.5) % 16];
  }
  var COMPASS_WORDS = { N: 'north', E: 'east', S: 'south', W: 'west' };
  /** 'SW' -> 'southwest', 'NNE' -> 'north-northeast'. Unknown text is returned as is. */
  function compassWords(abbr) {
    var s = String(abbr || '').toUpperCase();
    if (!/^[NESW]{1,3}$/.test(s)) return String(abbr || '');
    var word = function (t) { return t.split('').map(function (ch) { return COMPASS_WORDS[ch]; }).join(''); };
    return s.length === 3 ? word(s[0]) + '-' + word(s.slice(1)) : word(s);
  }

  /** fetch with timeout (AbortController); also respects an outer signal. */
  function fetchWithTimeout(url, opts, ms, outerSignal) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () { ctrl.abort(); }, ms || FETCH_TIMEOUT_MS);
      if (outerSignal) {
        if (outerSignal.aborted) ctrl.abort();
        else outerSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }
      opts.signal = ctrl.signal;
    }
    return fetch(url, opts).finally(function () { if (timer) clearTimeout(timer); });
  }

  // Expose helpers early so tests can use them even if map setup fails.
  var ReadyMap = window.ReadyMap = {
    version: VERSION,
    toDMS: toDMS,
    formatDecimal: formatDecimal,
    parseParams: parseParams,
    buildGpx: buildGpx,
    escapeXml: escapeXml,
    googleDirUrl: googleDirUrl,
    appleDirUrl: appleDirUrl,
    googleSearchUrl: googleSearchUrl,
    appleSearchUrl: appleSearchUrl,
    OVERPASS_MIRRORS: OVERPASS_MIRRORS.slice(),
    overpassQuery: function (key, lat, lon, radiusM) { return overpassQuery(key, lat, lon, radiusM); },
    buildSpotUrl: buildSpotUrl,
    tilesForBounds: tilesForBounds,
    distanceMeters: distanceMeters,
    cardinal: cardinal,
    pickWmsTime: pickWmsTime,
    mercatorTileBbox: mercatorTileBbox,
    erddapCurrentsUrl: erddapCurrentsUrl,
    inNoaaRadarCoverage: inNoaaRadarCoverage,
    parseGdacsDate: parseGdacsDate,
    parseRssItems: parseRssItems,
    fixFeedLink: fixFeedLink,
    timeAgo: timeAgo,
    shareFallbackPlan: shareFallbackPlan,
    cToF: cToF,
    fToC: fToC,
    wmoCodeText: wmoCodeText,
    degToCompass: degToCompass,
    compassWords: compassWords,
    map: null,
    weather: {
      parseWmsTimes: parseWmsTimes,
      parseWmsDimension: parseWmsDimension,
      severityColor: severityColor,
      pickFrames: pickFrames
    }
  };

  // ---------------------------------------------------------------------------
  // 3. DOM + status helpers
  // ---------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  /** Create element; text is always set with textContent (never innerHTML). */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'className') node.className = v;
        else if (k === 'on') Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var statusTimer = null;
  /**
   * Show a message in the status banner (also an aria-live region).
   * kind: 'info' | 'ok' (auto-hides after ~6 s) | 'error' (stays until the next message).
   * action: optional { label, href } link, { label, onClick, id } button, or { box: text }
   *   (read-only selectable text box); or an array of these, shown after the text.
   */
  function setStatus(msg, kind, action) {
    var banner = $('status-banner');
    if (!banner) return;
    clearTimeout(statusTimer);
    clear(banner);
    if (!msg) { banner.hidden = true; return; }
    banner.appendChild(el('span', { text: msg }));
    var actions = !action ? [] : (Array.isArray(action) ? action : [action]);
    actions.forEach(function (a) {
      if (!a) return;
      if (a.box != null) {
        var box = el('textarea', { className: 'share-box', readonly: 'readonly', rows: '3', 'aria-label': a.label || 'Text to copy' });
        box.value = a.box;
        box.addEventListener('focus', function () { try { box.select(); } catch (e) { /* */ } });
        banner.appendChild(box);
      } else if (a.onClick) {
        banner.appendChild(document.createTextNode(' '));
        banner.appendChild(el('button', { type: 'button', id: a.id, className: 'banner-btn', text: a.label, on: { click: a.onClick } }));
      } else if (a.href) {
        banner.appendChild(document.createTextNode(' '));
        banner.appendChild(el('a', { href: a.href, text: a.label, className: 'banner-action' }));
      }
    });
    banner.classList.toggle('is-error', kind === 'error');
    banner.hidden = false;
    if (kind === 'ok') statusTimer = setTimeout(function () { banner.hidden = true; clear(banner); }, 6000);
    updateLayoutVars();
    if (state.map) setTimeout(function () { state.map.invalidateSize(); }, 0);
  }

  function updateLayoutVars() {
    var footer = document.querySelector('.emergency');
    if (footer) {
      var height = document.body.classList.contains('full-map')
        ? window.innerHeight - footer.getBoundingClientRect().top : footer.offsetHeight;
      document.documentElement.style.setProperty('--footer-h', height + 'px');
    }
  }

  // 1.4.5 Full map: presentation only; GPS, layers and radar keep their state.
  var FULL_MAP_KEY = 'readyMap.fullMap.v1';
  var fullMap = false;

  function setFullMap(enabled, persist) {
    fullMap = enabled === true;
    document.body.classList.toggle('full-map', fullMap);
    var button = $('btn-full-map');
    button.textContent = fullMap ? 'Restore controls' : 'Full map';
    button.setAttribute('aria-pressed', String(fullMap));
    button.setAttribute('aria-label', fullMap ? 'Restore map controls' : 'Full map. Hide map controls');
    if (persist) {
      try { localStorage.setItem(FULL_MAP_KEY, String(fullMap)); } catch (e) { /* storage may be unavailable */ }
    }
    // Never leave keyboard focus inside the now-hidden chrome.
    var active = document.activeElement;
    if (fullMap && active && active.closest && active.closest('.app-header, .chips, .point-card, .skip-link')) button.focus();
    updateLayoutVars();
    requestAnimationFrame(function () {
      if (state.map) state.map.invalidateSize({ pan: false });
    });
  }

  function initFullMap() {
    var saved = false;
    try { saved = localStorage.getItem(FULL_MAP_KEY) === 'true'; } catch (e) { /* default off */ }
    $('btn-full-map').addEventListener('click', function () { setFullMap(!fullMap, true); });
    setFullMap(saved, false);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && fullMap && !topSheet()) {
        setFullMap(false, true);
        $('btn-full-map').focus();
      }
    });
  }
  ReadyMap.fullMap = { get: function () { return fullMap; }, set: function (enabled) { setFullMap(enabled, true); } };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = {
    map: null,
    follow: false,
    watchId: null,
    userFix: null,          // {lat, lon, accuracy, timestamp}
    selected: null,         // {lat, lon, label, accuracy, source:'user'|'pin'|'url'|'place', id}
    places: [],
    nearbyCache: new Map(),
    nearbyFlight: null,
    nearbyCategory: null,
    compass: { on: false, heading: null, handler: null, eventName: null, gotAbsolute: false, timer: null },
    online: navigator.onLine !== false,
    pendingDelete: null
  };

  // Leaflet layers
  var layers = {
    base: null,
    userDot: null,
    userCircle: null,
    pin: null,
    places: null,
    placeMarkers: new Map(),
    nearby: null
  };

  // ---------------------------------------------------------------------------
  // 4. Map setup
  // ---------------------------------------------------------------------------
  function pinSvg(fill, inner) {
    return '<svg viewBox="0 0 30 40" width="30" height="40" aria-hidden="true" focusable="false">' +
      '<path d="M15 1C7.3 1 1 7.2 1 14.8 1 25 15 39 15 39s14-14 14-24.2C29 7.2 22.7 1 15 1z" fill="' + fill +
      '" stroke="#9A3412" stroke-width="2"/>' + inner + '</svg>';
  }
  var ICON_PIN = null, ICON_PLACE = null;
  function makeIcons() {
    ICON_PIN = L.divIcon({
      className: 'pin-icon',
      html: pinSvg('#E86A17', '<circle cx="15" cy="15" r="5" fill="#FFFBF7"/>'),
      iconSize: [30, 40], iconAnchor: [15, 39], tooltipAnchor: [0, -34]
    });
    ICON_PLACE = L.divIcon({
      className: 'pin-icon',
      html: pinSvg('#1C1917', '<path d="M15 8 22 14h-1.5v7h-11v-7H8z" fill="#E86A17"/>'),
      iconSize: [30, 40], iconAnchor: [15, 39], tooltipAnchor: [0, -34]
    });
  }

  function textNode(s) {
    var span = document.createElement('span');
    span.textContent = s;
    return span;
  }

  function moveTo(lat, lon, zoom) {
    var z = zoom == null ? state.map.getZoom() : zoom;
    if (reducedMotion()) state.map.setView([lat, lon], z, { animate: false });
    else state.map.setView([lat, lon], z, { animate: true });
  }

  // --- Map names (1.4.3): readable international names, or local-language names ---------
  function readMapNames() {
    var v = lsGet(MAP_NAMES_KEY);
    return BASEMAPS.hasOwnProperty(v) ? v : DEFAULT_MAP_NAMES;
  }

  function makeBaseLayer(kind) {
    var p = BASEMAPS[kind];
    if (p.style && (typeof maplibregl === 'undefined' || typeof L.maplibreGL !== 'function')) {
      var raster = makeBaseLayer('local');
      raster._rmFallback = true;
      return raster;
    }
    if (p.style) {
      maplibregl.setWorkerUrl(new URL('./vendor/maplibre/maplibre-gl-csp-worker.js', document.baseURI).href);
      // Keep Leaflet in charge of interactions and all weather/marker panes. No runtime CDN.
      return L.maplibreGL({ style: p.style, interactive: false, pane: 'tilePane',
        attributionControl: { customAttribution: p.attribution },
        renderWorldCopies: true, maxZoom: 19, refreshExpiredTiles: true,
        cancelPendingTileRequestsWhileZooming: true });
    }
    return L.tileLayer(p.url, {
      maxZoom: p.maxZoom, attribution: p.attribution,
      updateWhenIdle: true, keepBuffer: 1, crossOrigin: 'anonymous'
    });
  }

  // No WebGL, lost context, or unavailable vector service: use the original detailed map.
  // Do not overwrite the saved preference, so the next visit can retry readable labels.
  function fallbackBase(layer) {
    if (layers.base !== layer) return;
    // A constructor can fail before the bridge finishes onAdd; make removal safe then too.
    if (layer.getMaplibreMap && !layer.getMaplibreMap()) {
      layer.onRemove = function () { if (this._container) L.DomUtil.remove(this._container); };
    }
    state.map.removeLayer(layer);
    layers.base = makeBaseLayer('local');
    layers.base._rmKind = 'readable';
    layers.base._rmFallback = true;
    layers.base.addTo(state.map);
    layers.base.bringToBack();
    setStatus('Readable map unavailable. Showing the original map with local names.', 'warn');
  }

  /** Switch the base map. save: remember the choice on this device. */
  function setMapNames(kind, save) {
    if (!BASEMAPS.hasOwnProperty(kind)) kind = DEFAULT_MAP_NAMES;
    if (save) lsSet(MAP_NAMES_KEY, kind);
    TILE_PROVIDER = BASEMAPS[kind];
    state.mapNames = kind;
    if (layers.base && layers.base._rmKind !== kind) {
      state.map.removeLayer(layers.base);
      layers.base = null;
    }
    if (!layers.base) {
      layers.base = makeBaseLayer(kind);
      layers.base._rmKind = kind;
      var base = layers.base;
      try {
        base.addTo(state.map);
        if (base.bringToBack) base.bringToBack();
        if (base._rmFallback) setStatus('Readable map unavailable. Showing the original map with local names.', 'warn');
        if (base.getMaplibreMap) {
          var gl = base.getMaplibreMap();
          var timer = setTimeout(function () { fallbackBase(base); }, 25000);
          gl.once('load', function () { clearTimeout(timer); });
          base.once('remove', function () { clearTimeout(timer); });
          gl.getCanvas().addEventListener('webglcontextlost', function () { fallbackBase(base); });
        }
      } catch (e) { fallbackBase(base); }
    }
    var radios = document.querySelectorAll('input[name="map-names"]');
    Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === kind; });
  }

  function initMap() {
    var map = L.map('map', {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 1,  // matches the URL ?zoom= range (1-19)
      maxZoom: TILE_PROVIDER.maxZoom,
      zoomSnap: 1,
      zoomDelta: 1,
      worldCopyJump: true,
      zoomAnimation: !reducedMotion(),
      fadeAnimation: !reducedMotion(),
      markerZoomAnimation: !reducedMotion()
    });
    state.map = map;
    ReadyMap.map = map;
    ReadyMap.mapNames = { get: function () { return state.mapNames; }, set: function (k) { setMapNames(k, true); }, layer: function () { return layers.base; }, kinds: BASEMAPS };

    setMapNames(readMapNames(), false);

    // Weather overlays sit above base tiles (200) and below vector overlays (400) / markers (600).
    var wxPane = map.createPane('weather');
    wxPane.style.zIndex = 350;
    wxPane.style.pointerEvents = 'none';
    var alertsPane = map.createPane('alerts');
    alertsPane.style.zIndex = 380;
    // Ocean fills (sea temperature, currents, depth charts) sit just under the weather pane, so
    // radar and clouds stay readable on top. Marine zone outlines sit above the weather pane.
    var oceanPane = map.createPane('ocean');
    oceanPane.style.zIndex = 330;
    oceanPane.style.pointerEvents = 'none';
    var oceanLinesPane = map.createPane('oceanlines');
    oceanLinesPane.style.zIndex = 360;
    oceanLinesPane.style.pointerEvents = 'none';

    makeIcons();
    layers.places = L.layerGroup().addTo(map);
    layers.nearby = L.layerGroup().addTo(map);

    map.on('click', function (e) {
      var ll = e.latlng.wrap();
      if (measure.on) { addMeasurePoint(ll.lat, ll.lng); return; } // 1.4.0 Measure distance
      dropPin(ll.lat, ll.lng, 'Dropped pin', 'pin');
    });
    map.on('dragstart', function () {
      if (state.follow) setFollow(false, true);
    });
    // Keyboard: Enter on the focused map drops a pin at the center.
    map.getContainer().addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target === map.getContainer()) {
        var c = map.getCenter().wrap();
        if (measure.on) { addMeasurePoint(c.lat, c.lng); e.preventDefault(); return; }
        dropPin(c.lat, c.lng, 'Dropped pin', 'pin');
        e.preventDefault();
      }
    });
    map.getContainer().setAttribute('aria-label', 'Map. Tap the map to drop a pin. With a keyboard, press Enter to drop a pin at the center.');
  }

  // ---------------------------------------------------------------------------
  // 5. Selected point + point card
  // ---------------------------------------------------------------------------
  function select(point) {
    state.selected = point;
    renderPoint();
    if (typeof SpotWx !== 'undefined' && SpotWx) { try { SpotWx.update(); } catch (e) { /* optional */ } }
  }

  function dropPin(lat, lon, label, source) {
    if (layers.pin) {
      layers.pin.setLatLng([lat, lon]);
    } else {
      layers.pin = L.marker([lat, lon], { icon: ICON_PIN, keyboard: true, title: 'Pin', alt: 'Pin' }).addTo(state.map);
      layers.pin.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        var ll = layers.pin.getLatLng();
        select({ lat: ll.lat, lon: ll.lng, label: layers.pin._rmLabel || 'Dropped pin', source: layers.pin._rmSource || 'pin' });
      });
    }
    layers.pin._rmLabel = label;
    layers.pin._rmSource = source;
    layers.pin.unbindTooltip();
    if (label && label !== 'Dropped pin') {
      layers.pin.bindTooltip(textNode(label), { permanent: true, direction: 'top' });
    }
    if (state.follow) setFollow(false, true);
    select({ lat: lat, lon: lon, label: label, source: source, accuracy: null });
  }

  function removePin() {
    if (layers.pin) { state.map.removeLayer(layers.pin); layers.pin = null; }
  }

  function renderPoint() {
    var p = state.selected;
    var has = !!p;
    $('point-title').textContent = has ? (p.label || 'Selected point') : 'No point yet';
    $('coords-decimal').textContent = has ? formatDecimal(p.lat, p.lon) : 'No point yet';
    $('coords-dms').textContent = has ? toDMS(p.lat, p.lon) : 'Tap the map or tap Show my location.';
    var acc = $('coords-accuracy');
    if (has && p.accuracy) {
      acc.textContent = (p.source === 'place' ? 'Accuracy when saved: ' : 'About ') + formatAccuracy(p.accuracy) + '.';
      acc.hidden = false;
    } else {
      acc.hidden = true;
      acc.textContent = '';
    }
    // Copy and Share stay tappable: with no point they say what to do (never disabled silently).
    $('btn-more').disabled = !has;
    if (!has && !$('sheet-more').hidden) closeSheet('sheet-more');
    if (has) {
      $('link-google-dir').href = googleDirUrl(p.lat, p.lon);
      $('link-apple-dir').href = appleDirUrl(p.lat, p.lon);
      var nameInput = $('place-name');
      if (document.activeElement !== nameInput) {
        nameInput.value = p.source === 'place' || p.source === 'url' ? (p.label || '') : '';
      }
      $('btn-save-place').textContent = p.source === 'place' ? 'Rename place' : 'Save place';
    }
  }

  function selectedText(p) {
    return formatDecimal(p.lat, p.lon) + ' (' + toDMS(p.lat, p.lon) + ')';
  }

  // ---------------------------------------------------------------------------
  // 6. GPS
  // ---------------------------------------------------------------------------
  var GEO_MESSAGES = {
    unsupported: 'This browser cannot use GPS. Try a newer browser, or use the Google Maps or Apple Maps app.',
    insecure: 'GPS needs a secure page. This page is not using https, so your phone will not share your location. Open Ready Map from an https:// link.',
    1: 'Location is blocked. To use GPS, allow location for this site. ' +
       'On iPhone: Settings > Privacy & Security > Location Services > [your browser, e.g. Safari Websites, Brave, Chrome] > While Using the App. Then reload this page. ' +
       'Android: tap the lock icon by the web address > Permissions > Location > Allow.',
    2: 'We cannot find your location right now. Turn on Location Services, go outside or near a window, and try again.',
    3: 'Finding your location took too long. Try again, best outside with a clear view of the sky.'
  };

  function geoProblem() {
    if (!('geolocation' in navigator)) return GEO_MESSAGES.unsupported;
    if (window.isSecureContext === false) return GEO_MESSAGES.insecure;
    return null;
  }

  function geoErrorMessage(err) {
    return GEO_MESSAGES[err && err.code] || GEO_MESSAGES[2];
  }

  function onPosition(pos) {
    var first = !state.userFix || state.watchId === null;
    var c = pos.coords;
    state.userFix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, timestamp: pos.timestamp || Date.now() };
    drawUser();
    if (pointer.target) renderPointer();
    var wasFirstFix = !layers._hadFix;
    layers._hadFix = true;
    // Weather chip: load on the first fix, then only after moving > 5 km or the 5-minute limit.
    if (typeof WxChip !== 'undefined' && WxChip) setTimeout(function () { try { WxChip.check(wasFirstFix); } catch (e) { /* optional */ } }, 0);
    $('btn-follow').disabled = false;
    if (wasFirstFix) {
      setFollow(true, true);
      select(userPoint());
      moveTo(c.latitude, c.longitude, Math.max(state.map.getZoom(), 16));
      setStatus('Found you. Accuracy about ' + formatAccuracy(c.accuracy) + '.', 'ok');
    } else {
      if (state.selected && state.selected.source === 'user') select(userPoint());
      if (state.follow) moveTo(c.latitude, c.longitude);
    }
    return first;
  }

  function userPoint() {
    var f = state.userFix;
    return { lat: f.lat, lon: f.lon, accuracy: f.accuracy, label: state.watchId !== null ? 'My location' : 'My last known location', source: 'user' };
  }

  function drawUser() {
    var f = state.userFix;
    if (!f) return;
    var ll = [f.lat, f.lon];
    if (!layers.userCircle) {
      layers.userCircle = L.circle(ll, {
        radius: f.accuracy, color: '#9A3412', weight: 1, fillColor: '#E86A17', fillOpacity: 0.15, interactive: false
      }).addTo(state.map);
    } else {
      layers.userCircle.setLatLng(ll).setRadius(f.accuracy);
    }
    if (!layers.userDot) {
      layers.userDot = L.circleMarker(ll, {
        radius: 8, color: '#FFFFFF', weight: 3, fillColor: '#E86A17', fillOpacity: 1
      }).addTo(state.map);
      layers.userDot.bindTooltip(textNode('You are here'), { direction: 'top', offset: [0, -8] });
      layers.userDot.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        if (state.userFix) select(userPoint());
      });
    } else {
      layers.userDot.setLatLng(ll);
    }
  }

  function onWatchError(err) {
    // Timeouts during an active watch after a fix are normal; keep the watch going.
    if (err && err.code === 3 && layers._hadFix) return;
    if (err && err.code === 1) stopWatch(true);
    setStatus(geoErrorMessage(err), 'error');
  }

  function startWatch() {
    var problem = geoProblem();
    if (problem) { setStatus(problem, 'error'); return; }
    if (state.watchId !== null) return;
    layers._hadFix = false;
    setStatus('Finding your location… This can take up to a minute.', 'info');
    try {
      state.watchId = navigator.geolocation.watchPosition(onPosition, onWatchError, {
        enableHighAccuracy: true, maximumAge: 5000, timeout: 30000
      });
    } catch (e) {
      state.watchId = null;
      setStatus(GEO_MESSAGES[2], 'error');
    }
    renderLocateButtons();
  }

  function stopWatch(silent) {
    if (state.watchId !== null) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (e) { /* ignore */ }
    }
    state.watchId = null;
    setFollow(false, true);
    $('btn-follow').disabled = true;
    if (layers.userDot) { state.map.removeLayer(layers.userDot); layers.userDot = null; }
    if (layers.userCircle) { state.map.removeLayer(layers.userCircle); layers.userCircle = null; }
    if (state.selected && state.selected.source === 'user' && state.userFix) select(userPoint());
    renderLocateButtons();
    if (!silent) setStatus('GPS is off. Your last location is kept for sharing.', 'ok');
  }

  function renderLocateButtons() {
    var on = state.watchId !== null;
    var b = $('btn-locate');
    b.textContent = on ? 'Stop GPS' : 'Show my location';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setFollow(on, quiet) {
    state.follow = !!on;
    var b = $('btn-follow');
    b.setAttribute('aria-pressed', state.follow ? 'true' : 'false');
    b.textContent = state.follow ? 'Following' : 'Follow me';
    if (state.follow && state.userFix) moveTo(state.userFix.lat, state.userFix.lon);
    if (!quiet) setStatus(state.follow ? 'Follow me is on. The map moves with you.' : 'Follow me is off.', 'ok');
  }

  /** Get a fresh-enough fix (uses the live one if recent). */
  function getFixOnce() {
    return new Promise(function (resolve, reject) {
      var problem = geoProblem();
      if (problem) { reject(new Error(problem)); return; }
      if (state.userFix && Date.now() - state.userFix.timestamp < 120000) { resolve(state.userFix); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var c = pos.coords;
        state.userFix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, timestamp: pos.timestamp || Date.now() };
        if (state.watchId !== null) drawUser();
        resolve(state.userFix);
      }, function (err) {
        reject(new Error(geoErrorMessage(err)));
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Copy / share
  // ---------------------------------------------------------------------------
  function legacyCopy(text) {
    var ta = $('copy-fallback');
    try {
      ta.value = text;
      ta.removeAttribute('aria-hidden');
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand && document.execCommand('copy');
      ta.setAttribute('aria-hidden', 'true');
      ta.blur();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  /** Copy text; resolves true/false. */
  function copyText(text) {
    var active = document.activeElement;
    var restore = function (r) { if (active && active.focus) { try { active.focus({ preventScroll: true }); } catch (e) { /* */ } } return r; };
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
        return restore(legacyCopy(text));
      });
    }
    return Promise.resolve(restore(legacyCopy(text)));
  }

  /**
   * Pure decision for the Share buttons (exposed for tests).
   * 'need-point': nothing to share yet; 'share': use the share sheet; 'copy': copy + text-message link.
   */
  function shareFallbackPlan(o) {
    o = o || {};
    if (!o.hasPoint) return 'need-point';
    return o.hasShare ? 'share' : 'copy';
  }

  var NEED_POINT_MSG = 'Tap Show my location first, or tap the map to pick a spot. Then tap Share.';

  function smsHref(body) {
    // "sms:?&body=" works on both iOS and Android.
    return 'sms:?&body=' + encodeURIComponent(body);
  }

  /**
   * Start a copy right now. Call it synchronously inside a tap handler (before any await)
   * so the tap's user activation is still valid. Resolves true only if the copy really worked.
   */
  function copyNow(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      var pr;
      try { pr = navigator.clipboard.writeText(text); } catch (e) { pr = Promise.reject(e); }
      return Promise.resolve(pr).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return copyText(text);
  }

  /** Copy failed: show the text in a selectable read-only box (not an error), optionally with the text link. */
  function showCopyBox(text, withSms) {
    var actions = [{ box: text, label: 'Text to copy' }];
    if (withSms) actions.push({ label: 'Send it as a text message', href: smsHref(text) });
    setStatus('Press and hold to copy:', 'info', actions);
  }

  function copyFailedMessage(text) { showCopyBox(text, false); }

  /** Copy (started now) and report "Copied" + text link, or the press-and-hold box + text link. */
  function copyAndReport(full) {
    return copyNow(full).then(function (ok) {
      if (ok) {
        setStatus('Copied your location. Paste it in a message.', 'info',
          { label: 'Or send it as a text message', href: smsHref(full) });
      } else {
        showCopyBox(full, true);
      }
      return ok;
    });
  }

  /** Call navigator.share safely; always returns a promise. */
  function callShare(data) {
    try { return Promise.resolve(navigator.share(data)); } catch (e) { return Promise.reject(e); }
  }

  /** Share text via the share sheet; if there is none (or it fails), copy + offer a text-message link. */
  function shareText(title, text, url) {
    var full = url ? text + ' ' + url : text;
    if (shareFallbackPlan({ hasShare: !!navigator.share, hasPoint: true }) === 'share') {
      return callShare(url ? { title: title, text: text, url: url } : { title: title, text: text })
        .then(function () { setStatus('Shared.', 'ok'); })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return; // user closed the share sheet
          return copyAndReport(full);
        });
    }
    return copyAndReport(full);
  }

  function onCopy() {
    var p = state.selected;
    if (!p) { setStatus(NEED_POINT_MSG, 'info'); return; }
    var text = selectedText(p);
    copyNow(text).then(function (ok) {
      if (ok) setStatus('Copied: ' + text, 'ok');
      else copyFailedMessage(text);
    });
  }

  function onShare() {
    var p = state.selected;
    if (shareFallbackPlan({ hasShare: !!navigator.share, hasPoint: !!p }) === 'need-point') {
      setStatus(NEED_POINT_MSG, 'info');
      return;
    }
    var label = p.label && p.label !== 'Dropped pin' ? p.label + ': ' : '';
    var text = label + selectedText(p) + '. Map: ' + googlePointUrl(p.lat, p.lon);
    shareText('Location', text); // share sheet or clipboard copy starts synchronously, inside the tap
  }

  function emergencyMessage(f) {
    return 'I need help. My location: ' + formatDecimal(f.lat, f.lon) + ' (' + toDMS(f.lat, f.lon) + '). Map: ' +
      googlePointUrl(f.lat, f.lon);
  }

  /** After waiting for GPS: two one-tap actions (Copy button = a new tap, and the text-message link). */
  function locationReadyActions(msg) {
    return [
      { label: 'Copy', id: 'btn-copy-location', onClick: function () { copyAndReport(msg); } },
      { label: 'Text it', href: smsHref(msg) }
    ];
  }

  function onShareMyLocation() {
    var btn = $('btn-share-location');
    var fresh = state.userFix && Date.now() - state.userFix.timestamp < 120000;
    if (fresh) {
      // Use the fix right away, while the tap still counts as a user action.
      shareText('I need help', emergencyMessage(state.userFix));
      return;
    }
    var problem = geoProblem();
    if (problem) { setStatus(problem + ' You can still call 911.', 'error'); return; }
    setStatus('Getting your location to share… Please wait.', 'info');
    btn.disabled = true;
    getFixOnce().then(function (f) {
      btn.disabled = false;
      var msg = emergencyMessage(f);
      // The tap's permission to share or copy has probably expired while we waited for GPS,
      // so show one-tap Copy and Text it actions, then try once anyway.
      setStatus('Location ready. Tap Copy, or Text it.', 'info', locationReadyActions(msg));
      var tryCopy = function () {
        return copyNow(msg).then(function (ok) {
          if (ok) setStatus('Copied your location. Paste it in a message.', 'info', locationReadyActions(msg));
          else setStatus('Press and hold to copy:', 'info', [{ box: msg, label: 'Text to copy' }].concat(locationReadyActions(msg)));
        });
      };
      if (!navigator.share) return tryCopy();
      return callShare({ title: 'I need help', text: msg }).then(function () { setStatus('Shared.', 'ok'); }, function (err) {
        if (err && err.name === 'AbortError') return;
        return tryCopy();
      });
    }).catch(function (err) {
      btn.disabled = false;
      setStatus((err && err.message ? err.message : GEO_MESSAGES[2]) + ' You can still call 911.', 'error');
    });
  }

  function onCopyLink() {
    var p = state.selected;
    if (!p) return;
    var label = p.source === 'user' || p.label === 'Dropped pin' ? '' : p.label;
    var url = buildSpotUrl(p.lat, p.lon, label, state.map.getZoom());
    copyText(url).then(function (ok) {
      if (ok) setStatus('Link copied.', 'ok');
      else copyFailedMessage(url);
    });
  }

  // ---------------------------------------------------------------------------
  // 8. Sheets (dialogs)
  // ---------------------------------------------------------------------------
  var sheetStack = [];       // [{id, opener}]
  var sheetCloseHooks = {};  // id -> fn

  function isModal(sheet) { return sheet.getAttribute('aria-modal') === 'true'; }

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])'),
      function (n) { return n.offsetParent !== null || n === document.activeElement; }
    );
  }

  function openSheet(id, opener) {
    var sheet = $(id);
    if (!sheet) return;
    if (!sheet.hidden) { var f0 = focusables(sheet)[0]; if (f0) f0.focus(); return; }
    // Tools opened from the "More tools" menu return focus to the menu button (the menu closes).
    if (opener && opener.closest && opener.closest('#sheet-tools') && id !== 'sheet-tools') opener = $('btn-tools');
    // Only one non-stacking sheet at a time, except the delete confirm which stacks over My places.
    if (id !== 'sheet-confirm' && id !== 'sheet-alert') {
      sheetStack.slice().reverse().forEach(function (s) { if (s.id !== id) closeSheet(s.id, true); });
    }
    sheet.hidden = false;
    sheetStack.push({ id: id, opener: opener || document.activeElement });
    syncBackdrop();
    updateLayoutVars();
    var target = sheet.querySelector('[data-autofocus]') || sheet.querySelector('.sheet-close') || focusables(sheet)[0];
    if (target) target.focus();
    if (id === 'sheet-more') { $('btn-more').setAttribute('aria-expanded', 'true'); $('btn-more').textContent = 'Less'; }
    if (id === 'sheet-tools') $('btn-tools').setAttribute('aria-expanded', 'true');
    if (state.map) state.map.invalidateSize();
  }

  function closeSheet(id, noFocus) {
    var sheet = $(id);
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    var idx = -1;
    for (var i = sheetStack.length - 1; i >= 0; i--) if (sheetStack[i].id === id) { idx = i; break; }
    var entry = idx >= 0 ? sheetStack.splice(idx, 1)[0] : null;
    syncBackdrop();
    if (id === 'sheet-more') { $('btn-more').setAttribute('aria-expanded', 'false'); $('btn-more').textContent = 'More'; }
    if (sheetCloseHooks[id]) sheetCloseHooks[id]();
    if (!noFocus && entry && entry.opener && document.contains(entry.opener) && entry.opener.focus) {
      entry.opener.focus();
    }
    if (state.map) state.map.invalidateSize();
  }

  function topSheet() { return sheetStack.length ? sheetStack[sheetStack.length - 1] : null; }

  function syncBackdrop() {
    var anyModal = sheetStack.some(function (s) { return isModal($(s.id)); });
    $('backdrop').hidden = !anyModal;
  }

  function initSheets() {
    document.addEventListener('click', function (e) {
      var closer = e.target.closest && e.target.closest('[data-close]');
      if (closer) {
        var sheet = closer.closest('.sheet');
        if (sheet) closeSheet(sheet.id);
      }
    });
    $('backdrop').addEventListener('click', function () {
      var t = topSheet();
      if (t) closeSheet(t.id);
    });
    document.addEventListener('keydown', function (e) {
      var t = topSheet();
      if (!t) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSheet(t.id);
        return;
      }
      if (e.key === 'Tab') {
        var sheet = $(t.id);
        if (!isModal(sheet)) return;
        var f = focusables(sheet);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 9. Saved places + GPX
  // ---------------------------------------------------------------------------
  function loadPlaces() {
    try {
      var raw = localStorage.getItem(PLACES_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (p) {
        return p && typeof p.id === 'string' && isFinite(p.lat) && isFinite(p.lon) &&
          Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
      }).map(function (p) {
        return {
          id: p.id, name: String(p.name || 'Place').slice(0, 60), lat: Number(p.lat), lon: Number(p.lon),
          accuracy: isFinite(p.accuracy) && p.accuracy > 0 ? Number(p.accuracy) : null, created: p.created || null
        };
      });
    } catch (e) {
      return [];
    }
  }

  function persistPlaces() {
    try {
      localStorage.setItem(PLACES_KEY, JSON.stringify(state.places));
      return true;
    } catch (e) {
      setStatus('Could not save on this device. Storage may be full or turned off (private mode).', 'error');
      return false;
    }
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function drawPlaces() {
    layers.places.clearLayers();
    layers.placeMarkers.clear();
    state.places.forEach(function (p) {
      var m = L.marker([p.lat, p.lon], { icon: ICON_PLACE, keyboard: true, title: p.name, alt: p.name });
      m.bindTooltip(textNode(p.name), { direction: 'top' });
      m.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        selectPlace(p.id, false);
      });
      layers.places.addLayer(m);
      layers.placeMarkers.set(p.id, m);
    });
  }

  function selectPlace(id, center) {
    var p = state.places.find(function (x) { return x.id === id; });
    if (!p) return;
    if (center) moveTo(p.lat, p.lon, Math.max(state.map.getZoom(), 15));
    if (state.follow) setFollow(false, true);
    select({ lat: p.lat, lon: p.lon, label: p.name, accuracy: p.accuracy, source: 'place', id: p.id });
  }

  function renderPlacesList() {
    var list = $('places-list');
    clear(list);
    $('places-empty').hidden = state.places.length > 0;
    $('btn-gpx').disabled = state.places.length === 0;
    state.places.forEach(function (p) {
      var row = el('div', { className: 'place-row' }, [
        el('span', { className: 'place-name', text: p.name }),
        el('span', { className: 'place-coords', text: formatDecimal(p.lat, p.lon) }),
        el('button', {
          type: 'button', className: 'btn', text: 'Go to', 'aria-label': 'Go to ' + p.name,
          on: { click: function () { closeSheet('sheet-places', true); selectPlace(p.id, true); $('point-card').focus(); } }
        }),
        el('button', {
          type: 'button', className: 'btn', text: 'Delete', 'aria-label': 'Delete ' + p.name,
          on: { click: function (e) { askDelete(p.id, e.currentTarget); } }
        })
      ]);
      list.appendChild(el('li', null, [row]));
    });
  }

  function onSavePlace(e) {
    e.preventDefault();
    var p = state.selected;
    if (!p) return;
    var name = $('place-name').value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 60);
    if (p.source === 'place') {
      var existing = state.places.find(function (x) { return x.id === p.id; });
      if (existing) {
        existing.name = name || existing.name;
        if (persistPlaces()) {
          drawPlaces();
          select({ lat: existing.lat, lon: existing.lon, label: existing.name, accuracy: existing.accuracy, source: 'place', id: existing.id });
          setStatus('Place renamed to ' + existing.name + '.', 'ok');
        }
        return;
      }
    }
    if (!name) name = p.source === 'user' ? 'My location ' + formatLocalTime(new Date()) : (p.label && p.label !== 'Dropped pin' ? p.label : 'Saved place');
    var place = {
      id: newId(), name: name, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)),
      accuracy: p.source === 'user' && p.accuracy ? Math.round(p.accuracy) : null, created: new Date().toISOString()
    };
    state.places.push(place);
    if (!persistPlaces()) { state.places.pop(); return; }
    if (p.source === 'pin' || p.source === 'url') removePin();
    drawPlaces();
    select({ lat: place.lat, lon: place.lon, label: place.name, accuracy: place.accuracy, source: 'place', id: place.id });
    setStatus('Saved "' + place.name + '" to My places.', 'ok');
  }

  function askDelete(id, opener) {
    var p = state.places.find(function (x) { return x.id === id; });
    if (!p) return;
    state.pendingDelete = id;
    $('confirm-name').textContent = p.name;
    openSheet('sheet-confirm', opener);
    $('btn-confirm-keep').focus();
  }

  function confirmDelete() {
    var id = state.pendingDelete;
    state.pendingDelete = null;
    var p = state.places.find(function (x) { return x.id === id; });
    closeSheet('sheet-confirm', true);
    if (!p) return;
    state.places = state.places.filter(function (x) { return x.id !== id; });
    persistPlaces();
    drawPlaces();
    renderPlacesList();
    if (state.selected && state.selected.source === 'place' && state.selected.id === id) select(null);
    setStatus('Deleted "' + p.name + '".', 'ok');
    var first = $('places-list').querySelector('button') || $('btn-gpx');
    if (first && !first.disabled) first.focus(); else $('places-title').parentNode.querySelector('.sheet-close').focus();
  }

  function downloadGpx() {
    if (!state.places.length) { setStatus('You have no saved places to download yet.', 'error'); return; }
    var blob = new Blob([buildGpx(state.places)], { type: 'application/gpx+xml' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'ready-map-places.gpx' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    setStatus('GPX file downloaded.', 'ok');
  }

  // ---------------------------------------------------------------------------
  // 10. Find nearby
  // ---------------------------------------------------------------------------
  function around(lat, lon, radiusM) {
    return '(around:' + Math.round(radiusM || 2000) + ',' + Number(lat).toFixed(5) + ',' + Number(lon).toFixed(5) + ')';
  }
  // photon: OSM tags for the Photon backup; nominatim: amenity value for the Nominatim backup.
  var NEARBY = {
    hospital: { key: 'hospital', label: 'Hospital', plural: 'hospitals', word: 'hospital', letter: 'H', color: '#9F1239',
      photon: ['amenity:hospital'], nominatim: 'hospital',
      q: function (a) { return 'nwr["amenity"="hospital"]' + a + ';'; } },
    shelter: { key: 'shelter', label: 'Shelter', plural: 'shelters', word: 'emergency shelter', letter: 'S', color: '#1D4ED8',
      photon: ['amenity:community_centre', 'amenity:social_facility'], nominatim: 'community_centre',
      // 1.3.1: shelters and community centers in one request (shelters are listed first).
      q: function (a) {
        return 'nwr["social_facility"="shelter"]' + a + ';' +
          'nwr["emergency"="shelter"]' + a + ';' +
          'nwr["amenity"="shelter"]["emergency"="yes"]' + a + ';' +
          'nwr["amenity"="shelter"]["emergency"="designated"]' + a + ';' +
          'nwr["amenity"="community_centre"]' + a + ';';
      } },
    police: { key: 'police', label: 'Police', plural: 'police stations', word: 'police station', letter: 'P', color: '#1E3A8A',
      photon: ['amenity:police'], nominatim: 'police',
      q: function (a) { return 'nwr["amenity"="police"]' + a + ';'; } },
    fire: { key: 'fire', label: 'Fire station', plural: 'fire stations', word: 'fire station', letter: 'F', color: '#C2410C',
      photon: ['amenity:fire_station'], nominatim: 'fire_station',
      q: function (a) { return 'nwr["amenity"="fire_station"]' + a + ';'; } },
    gas: { key: 'gas', label: 'Gas', plural: 'gas stations', word: 'gas station', letter: 'G', color: '#3F6212',
      photon: ['amenity:fuel'], nominatim: 'fuel',
      q: function (a) { return 'nwr["amenity"="fuel"]' + a + ';'; } }
  };
  var NEARBY_EXTRA = {
    community_centre: { note: 'Community center (may open as a shelter)',
      q: function (a) { return 'nwr["amenity"="community_centre"]' + a + ';'; } }
  };

  /** Full Overpass QL query for a category key (or 'community_centre') around a point. */
  function overpassQuery(key, lat, lon, radiusM) {
    var def = NEARBY[key] || NEARBY_EXTRA[key];
    if (!def) return '';
    return '[out:json][timeout:15];(' + def.q(around(lat, lon, radiusM)) + ');out center 150;';
  }

  function radiusWords(m) {
    var mi = m / 1609.344;
    if (mi < 1.5) return '1 mile';
    return Math.round(mi) + ' miles';
  }

  // --- Overpass: staggered race across mirrors ---------------------------------
  // 1.3.1: the mirrors are no longer tried one after another with long timeouts (that could take
  // a minute when they were all busy). The last good mirror starts first; if it has not answered
  // after OVERPASS_STAGGER_MS the next one starts too, and so on. The first good answer wins and
  // the others are cancelled. Each try gives up after OVERPASS_TRY_MS.
  var mirrorFailedAt = {};

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage full or blocked */ } }

  /** Mirrors in the order to try: last good first, recently failed ones last. */
  function mirrorOrder() {
    var good = lsGet(OVERPASS_MIRROR_KEY);
    var list = OVERPASS_MIRRORS.slice();
    if (good && list.indexOf(good) > 0) { list.splice(list.indexOf(good), 1); list.unshift(good); }
    var now = Date.now();
    var bad = function (u) { return mirrorFailedAt[u] && now - mirrorFailedAt[u] < OVERPASS_SKIP_MS; };
    return list.filter(function (u) { return !bad(u); }).concat(list.filter(bad));
  }

  /** Abort-aware sleep. */
  function nearbySleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(new Error('aborted')); return; }
      var t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', function () { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
  }

  /** POST a query to the mirrors (staggered race). Resolves to the parsed JSON, rejects if all fail. */
  function overpassFetch(query, signal) {
    var order = mirrorOrder();
    return new Promise(function (resolve, reject) {
      var done = false, started = 0, pending = 0, ctrls = [], timers = [];
      function finish(ok, val) {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        ctrls.forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
        if (ok) resolve(val); else reject(val);
      }
      function start() {
        if (done || started >= order.length) return;
        var url = order[started++];
        var c = new AbortController();
        ctrls.push(c);
        pending++;
        fetchWithTimeout(url, {
          method: 'POST',
          // Simple form POST: no CORS preflight.
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          credentials: 'omit'
        }, OVERPASS_TRY_MS, c.signal).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status); // 429, 5xx, anything not OK
          return res.text();
        }).then(function (txt) {
          var json = JSON.parse(txt); // invalid JSON (e.g. an HTML error page) counts as a failure
          if (!json || !Array.isArray(json.elements)) throw new Error('bad reply');
          if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark) && !json.elements.length) {
            throw new Error('server busy');
          }
          delete mirrorFailedAt[url];
          lsSet(OVERPASS_MIRROR_KEY, url);
          finish(true, json);
        }).catch(function () {
          pending--;
          if (done) return;
          mirrorFailedAt[url] = Date.now();
          if (started < order.length) start(); // a failure starts the next mirror right away
          else if (!pending) finish(false, new Error('all Overpass mirrors failed'));
        });
        if (started < order.length) timers.push(setTimeout(start, OVERPASS_STAGGER_MS));
      }
      if (signal) {
        if (signal.aborted) { finish(false, new Error('aborted')); return; }
        signal.addEventListener('abort', function () { finish(false, new Error('aborted')); }, { once: true });
      }
      start();
    });
  }

  // --- Result items -------------------------------------------------------------
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180;
    var y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
    var x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return ((Math.atan2(y, x) / r) + 360) % 360;
  }
  /** 'northeast' etc. from the spot to a place ('' when it is right here). */
  function directionWords(p, lat, lon) {
    if (distanceMeters(p.lat, p.lon, lat, lon) < 30) return '';
    return compassWords(cardinal(bearingDeg(p.lat, p.lon, lat, lon)));
  }

  /** Sort (closest first; for shelters, real shelters before community centers) and trim. */
  function finishItems(items) {
    var seen = {};
    return items.filter(function (it) {
      if (!it || !isFinite(it.lat) || !isFinite(it.lon)) return false;
      var k = it.name + '|' + it.lat.toFixed(4) + ',' + it.lon.toFixed(4);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).sort(function (a, b) { return (a.rank || 0) - (b.rank || 0) || a.dist - b.dist; }).slice(0, NEARBY_MAX_ITEMS);
  }

  function makeItem(cat, p, o) {
    var named = !!o.name;
    return {
      name: String(o.name || o.note || ('Unnamed ' + cat.label.toLowerCase())).slice(0, 100),
      note: named && o.note ? o.note : '',
      rank: o.rank || 0,
      addr: String(o.addr || '').slice(0, 120),
      phone: String(o.phone || '').slice(0, 40),
      lat: o.lat, lon: o.lon, dist: distanceMeters(p.lat, p.lon, o.lat, o.lon)
    };
  }

  /** Shelter kind from OSM tags: rank 0 = shelter, 1 = community center, 2 = social facility. */
  function shelterKind(tags) {
    if (tags.social_facility === 'shelter' || tags.emergency === 'shelter' ||
        (tags.amenity === 'shelter' && /^(yes|designated)$/.test(tags.emergency || ''))) {
      return { rank: 0, note: 'Shelter' };
    }
    if (tags.amenity === 'community_centre') return { rank: 1, note: NEARBY_EXTRA.community_centre.note };
    if (tags.amenity === 'social_facility') return { rank: 2, note: 'Social services (ask about shelter)' };
    return { rank: 1, note: '' };
  }

  function parseNearbyItems(json, cat, p, note) {
    return finishItems((json.elements || []).map(function (e) {
      var lat = e.lat != null ? e.lat : e.center && e.center.lat;
      var lon = e.lon != null ? e.lon : e.center && e.center.lon;
      if (!isFinite(lat) || !isFinite(lon)) return null;
      var tags = e.tags || {};
      var kind = cat.key === 'shelter' ? shelterKind(tags) : { rank: 0, note: '' };
      return makeItem(cat, p, {
        name: tags.name || tags['name:en'] || tags.operator, note: note || kind.note, rank: kind.rank,
        addr: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' '),
        phone: tags.phone || tags['contact:phone'], lat: lat, lon: lon
      });
    }));
  }

  // --- Sources (each resolves { items, r, source } or rejects) ------------------------
  /** 1. OpenStreetMap via Overpass: small radius first, wider only if nothing was found. */
  function searchOverpass(cat, p, signal) {
    var i = 0;
    function step() {
      var r = NEARBY_RADII[i];
      return overpassFetch(overpassQuery(cat.key, p.lat, p.lon, r), signal).then(function (json) {
        var items = parseNearbyItems(json, cat, p);
        if (!items.length && i < NEARBY_RADII.length - 1) { i++; return step(); }
        return { items: items, r: r, source: 'OpenStreetMap (Overpass)' };
      });
    }
    return step();
  }

  function photonAddr(pr) {
    return [[pr.housenumber, pr.street].filter(Boolean).join(' '), pr.city || pr.district || pr.county].filter(Boolean).join(', ');
  }
  /** 2. OpenStreetMap via Photon (komoot) reverse search by tag: nearest places of that kind. */
  function searchPhoton(cat, p, signal) {
    var i = 0;
    function step() {
      var km = PHOTON_RADII_KM[i];
      var url = PHOTON_URL + '?lat=' + p.lat.toFixed(4) + '&lon=' + wrapLon(p.lon).toFixed(4) +
        '&radius=' + km + '&limit=' + NEARBY_MAX_ITEMS +
        cat.photon.map(function (t) { return '&osm_tag=' + encodeURIComponent(t); }).join('');
      return fetchWithTimeout(url, { credentials: 'omit' }, NEARBY_SOURCE_MS, signal).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (j) {
        if (!j || !Array.isArray(j.features)) throw new Error('bad reply');
        var items = finishItems(j.features.map(function (f) {
          var c = f.geometry && f.geometry.coordinates;
          if (!c) return null;
          var pr = f.properties || {};
          var kind = cat.key === 'shelter' ? shelterKind({ amenity: pr.osm_value }) : { rank: 0, note: '' };
          return makeItem(cat, p, { name: pr.name, note: kind.note, rank: kind.rank, addr: photonAddr(pr), lat: Number(c[1]), lon: Number(c[0]) });
        }));
        if (!items.length && i < PHOTON_RADII_KM.length - 1) { i++; return step(); }
        return { items: items, r: km * 1000, source: 'OpenStreetMap (Photon)' };
      });
    }
    return step();
  }

  /** 3. OpenStreetMap via Nominatim, inside a box around the spot (at most 1 request a second). */
  var lastNominatimAt = 0;
  function searchNominatim(cat, p, signal) {
    var i = 0;
    function step() {
      var r = NOMINATIM_RADII[i];
      var dLat = r / 111320, dLon = r / (111320 * Math.max(0.05, Math.cos(p.lat * Math.PI / 180)));
      var lon = wrapLon(p.lon);
      var box = [lon - dLon, p.lat + dLat, lon + dLon, p.lat - dLat].map(function (n) { return n.toFixed(4); }).join(',');
      var wait = Math.max(0, 1100 - (Date.now() - lastNominatimAt));
      return nearbySleep(wait, signal).then(function () {
        lastNominatimAt = Date.now();
        var url = NOMINATIM_URL + '?format=jsonv2&addressdetails=1&limit=40&bounded=1&viewbox=' + box +
          '&amenity=' + encodeURIComponent(cat.nominatim);
        return fetchWithTimeout(url, { credentials: 'omit' }, NEARBY_SOURCE_MS, signal);
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (j) {
        if (!Array.isArray(j)) throw new Error('bad reply');
        var items = finishItems(j.map(function (f) {
          var a = f.address || {};
          var kind = cat.key === 'shelter' ? shelterKind({ amenity: f.type }) : { rank: 0, note: '' };
          return makeItem(cat, p, {
            name: f.name, note: kind.note, rank: kind.rank,
            addr: [[a.house_number, a.road].filter(Boolean).join(' '), a.city || a.town || a.village || a.suburb].filter(Boolean).join(', '),
            lat: Number(f.lat), lon: Number(f.lon)
          });
        })).filter(function (it) { return it.dist <= r * 1.5; });
        if (!items.length && i < NOMINATIM_RADII.length - 1) { i++; return step(); }
        return { items: items, r: r, source: 'OpenStreetMap (Nominatim)' };
      });
    }
    return step();
  }

  /**
   * Run the sources: Overpass first; Photon starts when Overpass fails, finds nothing, or has not
   * answered after NEARBY_BACKUP_AFTER_MS; Nominatim when both are done without results.
   * The first source with results wins. Resolves { items, r, source } (items may be empty when
   * every source answered but found nothing), rejects when every source failed.
   * say(text) gets progress messages.
   */
  function findNearby(cat, p, signal, say) {
    var sources = [
      { name: 'overpass', fn: searchOverpass, msg: 'Searching OpenStreetMap…' },
      { name: 'photon', fn: searchPhoton, msg: 'Map server is slow. Trying a backup source…' },
      { name: 'nominatim', fn: searchNominatim, msg: 'Trying one more source…' }
    ];
    return new Promise(function (resolve, reject) {
      var done = false, next = 0, running = 0, empties = [], timer = null;
      function finish(ok, v) { if (done) return; done = true; clearTimeout(timer); if (ok) resolve(v); else reject(v); }
      function launch() {
        if (done || next >= sources.length) return;
        var s = sources[next++];
        running++;
        say(s.msg);
        if (next === 1) timer = setTimeout(launch, NEARBY_BACKUP_AFTER_MS);
        s.fn(cat, p, signal).then(function (res) {
          running--;
          if (done) return;
          res.via = s.name;
          if (res.items.length) { finish(true, res); return; }
          empties.push(res);
          advance();
        }, function () {
          running--;
          if (done) return;
          advance();
        });
      }
      function advance() {
        if (done) return;
        if (next === 1) { clearTimeout(timer); launch(); return; } // backup now, without waiting
        if (running) return; // another source is still working
        if (next < sources.length) { launch(); return; }
        if (empties.length) {
          finish(true, empties.sort(function (a, b) { return b.r - a.r; })[0]);
          return;
        }
        finish(false, new Error('no source answered'));
      }
      if (signal) signal.addEventListener('abort', function () { finish(false, new Error('aborted')); }, { once: true });
      launch();
    });
  }
  ReadyMap.nearby = { findNearby: findNearby, sources: { overpass: searchOverpass, photon: searchPhoton, nominatim: searchNominatim }, NEARBY: NEARBY };

  // --- Saved results (localStorage) -------------------------------------------
  function loadNearbyStore() {
    try {
      var o = JSON.parse(lsGet(NEARBY_STORE_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }
  function saveNearbyResult(ck, result) {
    var store = loadNearbyStore();
    var now = Date.now();
    Object.keys(store).forEach(function (k) { if (!store[k] || !(now - store[k].t <= NEARBY_STORE_TTL)) delete store[k]; });
    store[ck] = result;
    var keys = Object.keys(store).sort(function (a, b) { return store[a].t - store[b].t; });
    while (keys.length > NEARBY_STORE_MAX) delete store[keys.shift()];
    lsSet(NEARBY_STORE_KEY, JSON.stringify(store));
  }
  function getSavedNearby(ck) {
    var r = loadNearbyStore()[ck];
    if (!r || !Array.isArray(r.items) || !(Date.now() - r.t <= NEARBY_STORE_TTL)) return null;
    return r;
  }

  var US_CODES = ['US', 'PR', 'VI', 'GU', 'AS', 'MP'];
  /** Shelter help box: official shelters are announced by local authorities. */
  function showShelterInfo(key, p) {
    var box = $('nearby-shelter-info');
    if (!box) return;
    box.hidden = key !== 'shelter';
    if (key !== 'shelter') return;
    var set = function (us) {
      if (state.selected !== p || state.nearbyCategory !== 'shelter') return;
      $('nearby-shelter-us').hidden = !us;
      $('nearby-shelter-world').hidden = !!us;
    };
    var cc = Country.known(p.lat, p.lon);
    if (cc !== undefined && cc !== null) { set(US_CODES.indexOf(cc) !== -1); return; }
    set(inNoaaRadarCoverage(p.lat, p.lon)); // rough guess first, then the real country
    Country.lookup(p.lat, p.lon).then(function (c) { if (c !== null) set(US_CODES.indexOf(c) !== -1); });
  }

  function openNearby(key, opener) {
    var cat = NEARBY[key];
    var p = state.selected;
    if (!cat || !p) return;
    if (state.nearbyFlight && state.nearbyFlight.key !== nearbyKey(key, p)) {
      state.nearbyFlight.ctrl.abort(); // a different search: stop the old one
    }
    state.nearbyCategory = key;
    $('nearby-title').textContent = cat.label + ' nearby';
    $('link-google-search').href = googleSearchUrl(cat.word, p.lat, p.lon);
    $('link-apple-search').href = appleSearchUrl(cat.word, p.lat, p.lon);
    $('link-google-search').textContent = 'Search ' + cat.plural + ' in Google Maps';
    $('link-apple-search').textContent = 'Search in Apple Maps';
    $('nearby-status').textContent = '';
    $('nearby-status').classList.remove('is-error');
    clear($('nearby-list'));
    showShelterInfo(key, p);
    openSheet('sheet-nearby', opener);
    // 1.3.1: search right away (one tap), instead of waiting for "Show on this map".
    showNearbyOnMap();
  }

  function nearbyKey(key, p) { return key + ':' + p.lat.toFixed(3) + ',' + p.lon.toFixed(3); }

  function showNearbyOnMap() {
    var key = state.nearbyCategory;
    var cat = NEARBY[key];
    var p = state.selected;
    if (!cat || !p) return;
    var status = $('nearby-status');
    var ck = nearbyKey(key, p);
    if (state.nearbyCache.has(ck)) { renderNearby(cat, p, state.nearbyCache.get(ck)); return; }
    if (state.nearbyFlight && state.nearbyFlight.key === ck) { status.textContent = 'Still looking… please wait.'; return; }
    var saved = getSavedNearby(ck);
    if (saved && (!navigator.onLine || Date.now() - saved.t < NEARBY_FRESH_MS)) { renderNearby(cat, p, saved, true); return; }
    if (!navigator.onLine) {
      renderNearbyFailed(cat, p, 'You are offline, so this map cannot search. When you have signal, use the Google Maps or Apple Maps buttons.');
      return;
    }
    var btn = $('btn-nearby-show');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    status.classList.remove('is-error');
    clear($('nearby-list'));
    var ctrl = new AbortController();
    var flight = { key: ck, ctrl: ctrl };
    state.nearbyFlight = flight;
    var current = function () { return state.nearbyCategory === key && state.selected === p; };
    var say = function (t) { if (current()) status.textContent = t; };
    // Hard cap: never leave a spinner. After NEARBY_GIVE_UP_MS everything is cancelled.
    var giveUp = setTimeout(function () { ctrl.abort(); }, NEARBY_GIVE_UP_MS);

    findNearby(cat, p, ctrl.signal, say).then(function (result) {
      result.t = Date.now();
      state.nearbyCache.set(ck, result);
      if (state.nearbyCache.size > 30) state.nearbyCache.delete(state.nearbyCache.keys().next().value);
      saveNearbyResult(ck, result);
      if (current()) renderNearby(cat, p, result);
    }).catch(function () {
      if (!current()) return;
      var old = getSavedNearby(ck);
      if (old) { renderNearby(cat, p, old, true); return; }
      renderNearbyFailed(cat, p, 'The free map servers did not answer in time, so this map cannot list ' + cat.plural +
        ' right now. These buttons open a search for ' + cat.plural + ' around this spot:');
    }).finally(function () {
      clearTimeout(giveUp);
      if (state.nearbyFlight === flight) state.nearbyFlight = null;
      btn.disabled = false;
      btn.textContent = 'Search again on this map';
    });
  }

  /** Clear message plus big working map-search buttons (used when nothing could be listed). */
  function mapSearchButtons(cat, p) {
    return el('li', { className: 'nearby-fallback' }, [
      el('div', { className: 'btn-row' }, [
        el('a', { className: 'btn btn-primary', href: googleSearchUrl(cat.word, p.lat, p.lon), target: '_blank', rel: 'noopener noreferrer',
          text: 'Google Maps: ' + cat.plural }),
        el('a', { className: 'btn btn-primary', href: appleSearchUrl(cat.word, p.lat, p.lon), target: '_blank', rel: 'noopener noreferrer',
          text: 'Apple Maps: ' + cat.plural })
      ])
    ]);
  }
  function renderNearbyFailed(cat, p, msg) {
    var status = $('nearby-status');
    status.textContent = msg + ' In an emergency, call 911 (or your local emergency number).';
    status.classList.add('is-error');
    var list = $('nearby-list');
    clear(list);
    list.appendChild(mapSearchButtons(cat, p));
  }

  /** result = { t, r (radius m), items, source }. fromSaved: shown from localStorage. */
  function renderNearby(cat, p, result, fromSaved) {
    var items = result.items || [];
    var list = $('nearby-list');
    var status = $('nearby-status');
    clear(list);
    status.classList.remove('is-error');
    layers.nearby.clearLayers();
    var savedNote = fromSaved ? ' Saved from ' + new Date(result.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) +
      ' (' + timeAgo(result.t) + ').' : '';
    var within = radiusWords(result.r || NEARBY_RADII[NEARBY_RADII.length - 1]);
    var farthest = items.reduce(function (m, it) { return Math.max(m, it.dist); }, 0);
    var src = result.source ? ' Source: ' + result.source + '.' : '';
    if (!items.length) {
      status.textContent = 'No ' + cat.plural + ' found within ' + within + ' on OpenStreetMap (it may be missing places).' +
        ' Try Google Maps or Apple Maps:' + savedNote;
      list.appendChild(mapSearchButtons(cat, p));
      return;
    }
    var shelters = items.filter(function (it) { return !it.rank; }).length;
    var head = cat.key === 'shelter' && !shelters
      ? 'No shelters mapped nearby. Found ' + items.length + ' community center' + (items.length === 1 ? '' : 's') +
        ' or social service' + (items.length === 1 ? '' : 's') + ' (may open as a shelter; check local news).'
      : 'Found ' + items.length + ' within ' + formatDistance(farthest) + '.';
    status.textContent = head + ' Closest first. They are now on the map.' + src + savedNote;
    var group = [];
    items.forEach(function (it, n) {
      var icon = L.divIcon({
        className: 'nearby-icon',
        html: '<span aria-hidden="true">' + cat.letter + '</span>',
        iconSize: [30, 30], iconAnchor: [15, 15]
      });
      var marker = L.marker([it.lat, it.lon], { icon: icon, title: it.name, alt: cat.label + ': ' + it.name, keyboard: true });
      marker.on('add', function () { var node = marker.getElement(); if (node) node.style.background = cat.color; });
      var dir = directionWords(p, it.lat, it.lon);
      var where = formatDistance(it.dist) + (dir ? ' ' + dir : '') + ' of this spot';
      marker.bindTooltip(textNode((n + 1) + '. ' + it.name + ' (' + formatDistance(it.dist) + ')'), { direction: 'top', offset: [0, -14] });
      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        marker.openTooltip();
      });
      layers.nearby.addLayer(marker);
      group.push([it.lat, it.lon]);
      var li = el('li', null, [
        el('div', { className: 'result-name', text: (n + 1) + '. ' + it.name }),
        it.note ? el('div', { className: 'result-meta', text: it.note }) : null,
        el('div', { className: 'result-meta', text: where + (it.addr ? ' · ' + it.addr : '') }),
        it.phone ? el('a', { href: 'tel:' + it.phone.replace(/[^0-9+]/g, ''), text: 'Call ' + it.phone, className: 'btn' }) : null,
        el('div', { className: 'nearby-actions' }, [
          el('button', {
            type: 'button', className: 'btn', text: 'Show on map', 'aria-label': 'Show ' + it.name + ' on map',
            on: { click: function () { closeSheet('sheet-nearby', true); moveTo(it.lat, it.lon, Math.max(state.map.getZoom(), 16)); marker.openTooltip(); } }
          }),
          el('button', {
            type: 'button', className: 'btn', text: 'Point here (compass)', 'aria-label': 'Point to ' + it.name + ' with the compass',
            on: { click: function (e) { pointToSpot({ lat: it.lat, lon: it.lon, name: it.name }, e.currentTarget); } }
          }),
          el('a', {
            className: 'btn', href: googleDirUrl(it.lat, it.lon), target: '_blank', rel: 'noopener noreferrer',
            text: 'Google directions', 'aria-label': 'Directions to ' + it.name + ' in Google Maps'
          }),
          el('a', {
            className: 'btn', href: appleDirUrl(it.lat, it.lon), target: '_blank', rel: 'noopener noreferrer',
            text: 'Apple directions', 'aria-label': 'Directions to ' + it.name + ' in Apple Maps'
          })
        ])
      ]);
      list.appendChild(li);
    });
    group.push([p.lat, p.lon]);
    state.map.fitBounds(group, { padding: [30, 30], maxZoom: 16, animate: !reducedMotion() });
  }

  // ---------------------------------------------------------------------------
  // 11. Offline map helper
  // The OSM tile policy forbids prefetch / bulk download, so there is no "download this area"
  // (TILE_PROVIDER.allowPrefetch is false). The service worker keeps only the tiles the user has
  // already viewed (max MAX_VIEWED_TILES). This panel explains that, shows how many tiles are
  // kept, and can clear them. It never fetches tiles itself.
  // ---------------------------------------------------------------------------
  function canUseCaches() { return 'caches' in window && window.isSecureContext !== false; }

  /** Count tiles kept for offline use. Resolves to a number, or null if unknown. */
  function countSavedTiles() {
    if (!canUseCaches()) return Promise.resolve(null);
    return caches.has(TILE_CACHE).then(function (has) {
      if (!has) return 0;
      return caches.open(TILE_CACHE).then(function (c) { return c.keys(); }).then(function (k) { return k.length; });
    }).catch(function () { return null; });
  }

  function prepareOffline() {
    var count = $('save-count');
    if (!canUseCaches()) {
      count.textContent = 'Keeping the map for offline use needs a secure page (https). Open Ready Map from an https:// link.';
      $('btn-save-clear').disabled = true;
      return Promise.resolve(null);
    }
    $('btn-save-clear').disabled = false;
    count.textContent = 'Counting saved map pieces…';
    return countSavedTiles().then(function (n) {
      if (n === null) count.textContent = 'Could not check the saved map right now.';
      else if (n === 0) count.textContent = 'No map pieces are saved yet. Look around the map to save some.';
      else count.textContent = 'Saved now: ' + n + ' map piece' + (n === 1 ? '' : 's') + ' (tiles). The most it keeps is ' + MAX_VIEWED_TILES + '.';
      return n;
    });
  }

  /** Delete kept tiles (and the old 1.0.0 prefetch cache). statusId: where to show the result. */
  function clearSavedMap(statusId) {
    var status = $(statusId || 'clear-status');
    if (!canUseCaches()) { status.textContent = 'There is no saved map on this page.'; return Promise.resolve(); }
    return Promise.all([caches.delete(TILE_CACHE), caches.delete(SAVED_CACHE)]).then(function () {
      return $('sheet-save').hidden ? null : prepareOffline();
    }).then(function () {
      status.textContent = 'Saved map cleared.';
    }, function () {
      status.textContent = 'Could not clear the saved map.';
    });
  }

  // ---------------------------------------------------------------------------
  // 12. Network status + service worker
  // ---------------------------------------------------------------------------
  function renderNet() {
    state.online = navigator.onLine !== false;
    var b = $('net-status');
    b.textContent = state.online ? 'Online' : 'Offline';
    b.className = 'net-badge ' + (state.online ? 'net-online' : 'net-offline');
    b.setAttribute('aria-label', state.online ? 'Online' : 'Offline. Only map parts you looked at before will show.');
  }

  function initNet() {
    renderNet();
    window.addEventListener('online', function () {
      renderNet();
      setStatus('You are back online.', 'ok');
      Weather.onOnline();
    });
    window.addEventListener('offline', function () {
      renderNet();
      setStatus('You are offline. The map shows only parts you looked at before. Call 911 still works.', 'info');
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || window.isSecureContext === false) return;
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () { /* app still works online */ });
  }

  // ---------------------------------------------------------------------------
  // 13. Compass
  // ---------------------------------------------------------------------------
  var compassRaf = 0;
  function renderHeading() {
    compassRaf = 0;
    var h = state.compass.heading;
    if (h == null) return;
    var rounded = Math.round(h) % 360;
    $('compass-reading').textContent = cardinal(rounded) + ' ' + rounded + '°';
    // Arrow points to north: rotate opposite to the heading.
    $('compass-arrow').style.transform = 'rotate(' + (-h) + 'deg)';
    if (pointer.target) renderPointer();
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
  }

  function onOrientation(e) {
    var heading = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      heading = e.webkitCompassHeading; // iOS: degrees from north, already clockwise
    } else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && typeof e.alpha === 'number') {
      heading = 360 - e.alpha;          // alpha is counter-clockwise from north
    }
    if (heading == null) return;
    state.compass.gotAbsolute = true;
    state.compass.heading = (((heading + screenAngle()) % 360) + 360) % 360;
    if (!compassRaf) compassRaf = requestAnimationFrame(renderHeading);
  }

  function startCompass(opener, keepTarget) {
    if (!keepTarget && pointer.target) stopPointer();
    // 1.4.0 Point to a spot: without a compass (or permission), still open the view for distance,
    // direction in degrees and the GPS direction of travel.
    var noSensor = function (msg) {
      stopCompass();
      $('compass-reading').textContent = 'No compass';
      openSheet('sheet-compass', opener);
      setStatus(msg, 'error');
      renderPointer();
    };
    if (!('DeviceOrientationEvent' in window)) {
      if (keepTarget) { noSensor('A compass is not available on this device or browser. Distance and direction are still shown.'); return; }
      setStatus('A compass is not available on this device or browser.', 'error');
      return;
    }
    var begin = function () {
      stopCompass();
      var name = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
      state.compass.on = true;
      state.compass.gotAbsolute = false;
      state.compass.heading = null;
      state.compass.eventName = name;
      state.compass.handler = onOrientation;
      window.addEventListener(name, onOrientation);
      $('compass-reading').textContent = 'Waiting for compass…';
      $('btn-compass').setAttribute('aria-pressed', 'true');
      openSheet('sheet-compass', opener);
      state.compass.timer = setTimeout(function () {
        if (!state.compass.gotAbsolute) {
          $('compass-reading').textContent = 'No compass found';
          setStatus('This device did not send compass data. Many computers have no compass. On a phone, try moving it in a figure 8.', 'error');
        }
      }, 3500);
    };
    var DOE = window.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      // iOS 13+: must be called directly from the tap.
      DOE.requestPermission().then(function (result) {
        if (result === 'granted') begin();
        else if (keepTarget) noSensor('Compass permission was not given, so the arrow cannot turn with your phone. Distance and direction are still shown.');
        else setStatus('Compass permission was not given. To use it, allow Motion & Orientation access in Safari settings.', 'error');
      }).catch(function () {
        if (keepTarget) noSensor('Could not turn on the compass. Distance and direction are still shown.');
        else setStatus('Could not turn on the compass. Please try again.', 'error');
      });
    } else {
      begin();
    }
  }

  function stopCompass() {
    var c = state.compass;
    if (c.handler && c.eventName) window.removeEventListener(c.eventName, c.handler);
    clearTimeout(c.timer);
    c.on = false;
    c.handler = null;
    c.eventName = null;
    $('btn-compass').setAttribute('aria-pressed', 'false');
  }

  // ---------------------------------------------------------------------------
  // 13b. Point to a spot (1.4.0): a blue arrow in the compass view points from your GPS spot to
  // a chosen spot as the phone turns. Uses the same heading as the compass (state.compass.heading);
  // without a compass it falls back to the GPS direction of travel when you are moving.
  // ---------------------------------------------------------------------------
  var pointer = { target: null, watchId: null, fix: null, gpsMsg: '' };

  function formatMeasure(m) {
    if (m < 400) return Math.round(m * 3.28084).toLocaleString('en-US') + ' ft (' + Math.round(m) + ' m)';
    var mi = m / 1609.344, km = m / 1000;
    return (mi < 10 ? mi.toFixed(2) : mi.toFixed(1)) + ' mi (' + (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' km)';
  }

  /** Freshest GPS fix: the app's own (Show my location) or the pointer's own watch. */
  function pointerFix() {
    var a = state.userFix, b = pointer.fix;
    if (a && b) return (a.timestamp || 0) >= (b.timestamp || 0) ? a : b;
    return a || b || null;
  }

  function pointToSpot(target, opener) {
    if (!target || !isFinite(target.lat) || !isFinite(target.lon)) return;
    pointer.target = { lat: Number(target.lat), lon: Number(target.lon), name: String(target.name || 'This spot').slice(0, 100) };
    pointer.gpsMsg = '';
    startPointerGps();
    startCompass(opener, true); // must run inside the tap (iOS permission prompt)
    renderPointer();
  }

  function startPointerGps() {
    if (pointer.watchId !== null || state.watchId !== null) return; // the app's GPS is already on
    if (!('geolocation' in navigator)) { pointer.gpsMsg = 'This browser cannot get your GPS location.'; return; }
    try {
      pointer.watchId = navigator.geolocation.watchPosition(function (pos) {
        var c = pos.coords;
        pointer.fix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, timestamp: pos.timestamp || Date.now() };
        pointer.gpsMsg = '';
        renderPointer();
      }, function (err) {
        pointer.gpsMsg = err && err.code === 1
          ? 'Location permission is off, so the distance from you cannot be shown. Allow location for this site in your browser settings.'
          : 'Could not get your GPS location yet. Go outside or near a window and wait a moment.';
        renderPointer();
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } catch (e) { pointer.gpsMsg = 'Could not start GPS.'; }
  }

  function stopPointer() {
    if (pointer.watchId !== null) { try { navigator.geolocation.clearWatch(pointer.watchId); } catch (e) { /* ignore */ } }
    pointer.watchId = null;
    pointer.target = null;
    renderPointer();
  }

  function renderPointer() {
    var box = $('compass-target'), arrow = $('compass-target-arrow');
    if (!box || !arrow) return;
    var t = pointer.target;
    if (!t) { box.hidden = true; arrow.hidden = true; $('compass-legend').hidden = true; return; }
    box.hidden = false;
    $('compass-legend').hidden = false;
    $('compass-target-name').textContent = 'To: ' + t.name;
    var info = $('compass-target-info'), turn = $('compass-target-turn');
    var f = pointerFix();
    if (!f) {
      info.textContent = pointer.gpsMsg || 'Getting your GPS location…';
      turn.textContent = '';
      arrow.hidden = true;
      return;
    }
    var d = distanceMeters(f.lat, f.lon, t.lat, t.lon);
    var b = bearingDeg(f.lat, f.lon, t.lat, t.lon);
    var br = Math.round(b) % 360;
    var acc = f.accuracy ? ' GPS accuracy about ' + formatAccuracy(f.accuracy) + '.' : '';
    if (d < Math.max(15, Math.min(f.accuracy || 0, 50))) {
      info.textContent = 'You are at this spot (within GPS accuracy).' + acc;
      turn.textContent = '';
      arrow.hidden = true;
      return;
    }
    info.textContent = formatMeasure(d) + ' away in a straight line, toward ' + cardinal(br) + ' ' + br + '° (' + compassWords(cardinal(br)) + ').' + acc;
    var h = null, viaGps = false;
    if (state.compass.on && state.compass.gotAbsolute && state.compass.heading != null) h = state.compass.heading;
    else if (f.speed != null && f.speed > 1 && f.heading != null && isFinite(f.heading)) { h = f.heading; viaGps = true; }
    if (h == null) {
      arrow.hidden = true;
      turn.textContent = 'No compass heading. Face ' + compassWords(cardinal(br)) + ' (' + br + '°), or start walking so GPS can tell your direction.';
      return;
    }
    var rel = ((b - h) % 360 + 540) % 360 - 180; // -180..180, + = to your right
    arrow.hidden = false;
    arrow.style.transform = 'rotate(' + rel + 'deg)';
    var a = Math.round(Math.abs(rel));
    turn.textContent = (a <= 10 ? 'Straight ahead.' : a >= 170 ? 'Behind you. Turn around.' : 'Turn ' + (rel > 0 ? 'right' : 'left') + ' about ' + a + '°.') +
      (viaGps ? ' (Using your GPS direction of travel: no compass.)' : '');
  }
  ReadyMap.pointer = { pointToSpot: pointToSpot, state: pointer, render: renderPointer, formatMeasure: formatMeasure, bearingDeg: function (a, b, c, d) { return bearingDeg(a, b, c, d); } };

  // ---------------------------------------------------------------------------
  // 13c. Measure distance (1.4.0): while on, map taps add numbered points joined by a line.
  // ---------------------------------------------------------------------------
  var measure = { on: false, pts: [], layer: null };

  function startMeasure() {
    closeSheet('sheet-tools', true);
    sheetStack.slice().reverse().forEach(function (s) { closeSheet(s.id, true); });
    measure.on = true;
    if (!measure.layer) measure.layer = L.layerGroup().addTo(state.map);
    $('measure-panel').hidden = false;
    state.map.getContainer().classList.add('is-measuring');
    document.body.classList.add('is-measuring');   // hides the spot card so the map gets more room
    setTimeout(function () { state.map.invalidateSize(); }, 0);
    $('btn-measure').setAttribute('aria-pressed', 'true');
    renderMeasure();
    $('measure-title').focus();
  }
  function stopMeasure() {
    measure.on = false;
    measure.pts = [];
    if (measure.layer) measure.layer.clearLayers();
    $('measure-panel').hidden = true;
    state.map.getContainer().classList.remove('is-measuring');
    document.body.classList.remove('is-measuring');
    setTimeout(function () { state.map.invalidateSize(); }, 0);
    $('btn-measure').setAttribute('aria-pressed', 'false');
    $('btn-measure').focus();
  }
  function addMeasurePoint(lat, lon, isMe) {
    var pt = { lat: lat, lon: wrapLon(lon), me: !!isMe };
    if (isMe) {
      if (measure.pts.length && measure.pts[0].me) measure.pts[0] = pt; else measure.pts.unshift(pt);
    } else measure.pts.push(pt);
    renderMeasure();
  }
  function measureFromMe() {
    var f = pointerFix();
    var use = function (fx) { addMeasurePoint(fx.lat, fx.lon, true); };
    if (f && Date.now() - (f.timestamp || 0) < 120000) { use(f); return; }
    if (!('geolocation' in navigator)) { $('measure-status').textContent = 'This browser cannot get your GPS location.'; return; }
    $('measure-status').textContent = 'Getting your GPS location…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var c = pos.coords;
      pointer.fix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, timestamp: pos.timestamp || Date.now() };
      if (measure.on) use(pointer.fix);
    }, function (err) {
      $('measure-status').textContent = err && err.code === 1 ? 'Location permission is off. Allow location for this site to start from your location.' : 'Could not get your GPS location. Try again.';
    }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
  }
  function measureTotal() {
    var t = 0;
    for (var i = 1; i < measure.pts.length; i++) t += distanceMeters(measure.pts[i - 1].lat, measure.pts[i - 1].lon, measure.pts[i].lat, measure.pts[i].lon);
    return t;
  }
  function renderMeasure() {
    var pts = measure.pts;
    if (measure.layer) {
      measure.layer.clearLayers();
      if (pts.length > 1) {
        measure.layer.addLayer(L.polyline(pts.map(function (p) { return [p.lat, p.lon]; }), { color: '#1D4ED8', weight: 4, dashArray: '8 6', interactive: false }));
      }
      pts.forEach(function (p, i) {
        measure.layer.addLayer(L.marker([p.lat, p.lon], {
          icon: L.divIcon({ className: 'measure-icon', html: '<span>' + (p.me ? 'Me' : (i + 1)) + '</span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
          interactive: false, keyboard: false
        }));
      });
    }
    var list = $('measure-legs');
    clear(list);
    for (var i = 1; i < pts.length; i++) {
      var d = distanceMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
      var from = pts[i - 1].me ? 'Me' : String(i), to = String(i + 1);
      list.appendChild(el('li', { text: from + ' → ' + to + ': ' + formatMeasure(d) }));
    }
    list.hidden = pts.length < 2;
    $('measure-total').textContent = pts.length < 2 ? '' : 'Total: ' + formatMeasure(measureTotal());
    $('measure-status').textContent = !pts.length ? 'Tap the map to add the first point.' :
      pts.length === 1 ? 'Tap the map to add the next point.' : pts.length + ' points. Tap to add more.';
    $('btn-measure-undo').disabled = !pts.length;
    $('btn-measure-clear').disabled = !pts.length;
    if (list.lastChild) list.scrollTop = list.scrollHeight;
  }
  ReadyMap.measure = { state: measure, add: addMeasurePoint, total: measureTotal, start: function () { startMeasure(); }, stop: function () { stopMeasure(); } };

  // ---------------------------------------------------------------------------
  // 13z. Country lookup + sharper forecast models (1.3.0)
  // Country: which country a spot is in (for national radar, the forecast model and the official
  // weather service link). BigDataCloud's free client-side reverse geocoder; cached in page memory
  // per 0.1 degree cell. '' = no country (open sea), null = lookup failed.
  // ---------------------------------------------------------------------------
  var Country = (function () {
    var API = 'https://api-bdc.io/data/reverse-geocode-client';
    var OK_MS = 24 * 3600 * 1000, FAIL_MS = 10 * 60 * 1000, WAIT_MS = 5000;
    var cache = new Map(), flights = new Map();
    function key(lat, lon) { return Number(lat).toFixed(1) + ',' + wrapLon(lon).toFixed(1); }
    /** Cached country code: 'CA', '' (sea), null (failed) or undefined (not looked up yet). */
    function known(lat, lon) {
      var c = cache.get(key(lat, lon));
      if (!c) return undefined;
      if (Date.now() - c.at > (c.cc === null ? FAIL_MS : OK_MS)) return undefined;
      return c.cc;
    }
    function nameOf(lat, lon) { var c = cache.get(key(lat, lon)); return c && c.name ? c.name : ''; }
    function lookup(lat, lon) {
      var k = key(lat, lon);
      var have = known(lat, lon);
      if (have !== undefined) return Promise.resolve(have);
      if (flights.has(k)) return flights.get(k);
      if (!navigator.onLine) return Promise.resolve(null);
      var url = API + '?latitude=' + Number(lat).toFixed(3) + '&longitude=' + wrapLon(lon).toFixed(3) + '&localityLanguage=en';
      var p = fetchWithTimeout(url, { credentials: 'omit' }, WAIT_MS).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (j) {
        var cc = j && typeof j.countryCode === 'string' && /^[A-Z]{2}$/.test(j.countryCode) ? j.countryCode : '';
        var name = j && typeof j.countryName === 'string' ? j.countryName.slice(0, 80) : '';
        cache.set(k, { cc: cc, name: name, at: Date.now() });
        return cc;
      }).catch(function () {
        cache.set(k, { cc: null, name: '', at: Date.now() });
        return null;
      }).then(function (cc) { flights.delete(k); return cc; });
      flights.set(k, p);
      return p;
    }
    return { lookup: lookup, known: known, nameOf: nameOf, key: key, cache: cache };
  })();
  ReadyMap.country = Country;

  /**
   * Open-Meteo regional high-resolution models. "best_match" does not say which model it used, so
   * for places with a sharp national model we ask for that model by name ("seamless" = the sharp
   * model first, then the national/global one for later days) and say which one it is.
   * cc: countries that get this model when the country is known; area: [south, west, north, east]
   * where the model has data; core: boxes used when the country is not known (open sea, failed lookup).
   * Checked with api.open-meteo.com on 2026-11-02.
   */
  var OM_MODELS = [
    { id: 'ukmo_seamless', label: 'UK Met Office UKV (2 km)', cc: ['GB', 'IE', 'IM', 'JE', 'GG'],
      area: [[49.5, -11, 61, 2.5]], core: [[49.8, -10.7, 61, 1.8]] },
    { id: 'meteoswiss_icon_seamless', label: 'MeteoSwiss ICON-CH1 (1 km)', cc: ['CH', 'LI'],
      area: [[45.6, 5.7, 48, 10.7]], core: [[45.8, 5.95, 47.8, 10.5]] },
    { id: 'knmi_seamless', label: 'KNMI HARMONIE-AROME (2 km)', cc: ['NL'],
      area: [[50.5, 3.2, 53.8, 7.4]], core: [[51.2, 3.4, 53.6, 7.1]] },
    { id: 'dmi_seamless', label: 'DMI HARMONIE-AROME (2 km)', cc: ['DK'],
      area: [[54.4, 7.8, 58, 15.4]], core: [[54.8, 8, 57.8, 15.2]] },
    { id: 'meteofrance_seamless', label: 'Météo-France AROME (1.3 km)', cc: ['FR', 'BE', 'LU', 'MC', 'AD'],
      area: [[41.3, -5.5, 51.5, 10]], core: [[42.3, -4.8, 51.1, 8.2]] },
    { id: 'icon_seamless', label: 'DWD ICON-D2 (2 km)', cc: ['DE', 'AT', 'CZ', 'PL', 'SI', 'SK', 'HU'],
      area: [[43.2, -3.9, 58, 20.3]], core: [[47.2, 5.8, 55.1, 15.1], [46.3, 9.5, 51.1, 17.2]] },
    { id: 'italia_meteo_arpae_icon_2i', label: 'ItaliaMeteo ICON-2I (2 km)', cc: ['IT', 'SM', 'VA', 'MT'],
      area: [[35.5, 6.5, 47.2, 18.7]], core: [[36.5, 7.5, 46.6, 18.5]] },
    { id: 'metno_seamless', label: 'MET Norway Nordic (1 km)', cc: ['NO', 'SE', 'FI'],
      area: [[54.5, 4, 71.5, 32]], core: [[55.3, 4.5, 71.2, 31.5]] },
    { id: 'jma_seamless', label: 'JMA MSM (5 km)', cc: ['JP'],
      area: [[22, 120, 48, 150]], core: [[24, 122.5, 46, 146.5]] },
    { id: 'gem_seamless', label: 'Canada HRDPS (2.5 km)', cc: ['CA'],
      area: [[41.6, -141.1, 72, -52]], core: [[49.1, -141, 72, -52]] },
    { id: 'gfs_seamless', label: 'NOAA HRRR (3 km)', cc: ['US'],
      area: [[21.1, -134.1, 52.6, -60.9]], core: [[24, -125, 49.3, -66.9]] }
  ];
  var OM_BEST = { id: 'best_match', label: 'Open-Meteo best match (global models)' };

  function inBoxes(boxes, lat, lon) {
    lon = wrapLon(lon);
    return (boxes || []).some(function (b) { return lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]; });
  }
  /** Which Open-Meteo model to ask for at a spot. cc: country code if known ('' / null / undefined if not). */
  function omModelFor(lat, lon, cc) {
    var i;
    if (cc) {
      for (i = 0; i < OM_MODELS.length; i++) {
        if (OM_MODELS[i].cc.indexOf(cc) !== -1 && inBoxes(OM_MODELS[i].area, lat, lon)) return OM_MODELS[i];
      }
      return OM_BEST; // a known country without a sharp model
    }
    for (i = 0; i < OM_MODELS.length; i++) {
      if (inBoxes(OM_MODELS[i].core, lat, lon)) return OM_MODELS[i];
    }
    return OM_BEST;
  }
  function omHasGaps(j) {
    var any = false;
    ['current', 'hourly', 'daily'].forEach(function (sec) {
      var s = j && j[sec];
      if (!s) return;
      Object.keys(s).forEach(function (k) {
        if (k === 'time' || k === 'interval') return;
        var v = s[k];
        if (v === null) any = true;
        else if (Array.isArray(v) && v.some(function (x) { return x === null; })) any = true;
      });
    });
    return any;
  }
  /** Fill nulls in a (regional model) reply with the best_match reply. Returns true if any were filled. */
  function omFill(j, b) {
    var filled = false;
    ['current', 'hourly', 'daily'].forEach(function (sec) {
      var s = j && j[sec], t = b && b[sec];
      if (!s || !t) return;
      if (Array.isArray(s.time) && Array.isArray(t.time) && s.time.join() !== t.time.join()) return;
      Object.keys(s).forEach(function (k) {
        if (k === 'time' || k === 'interval') return;
        if (s[k] === null && t[k] !== null && t[k] !== undefined) { s[k] = t[k]; filled = true; }
        else if (Array.isArray(s[k]) && Array.isArray(t[k])) {
          s[k] = s[k].map(function (x, i) { if (x === null && t[k][i] !== null && t[k][i] !== undefined) { filled = true; return t[k][i]; } return x; });
        }
      });
    });
    return filled;
  }
  /**
   * Fetch an Open-Meteo forecast URL (without &models) with the sharpest model for the spot.
   * Missing values (the sharp model only covers 1-4 days) are filled from best_match.
   * Resolves { j, model, filled }.
   */
  function omFetch(baseUrl, lat, lon, cc, getJson) {
    var m = omModelFor(lat, lon, cc);
    var best = function () { return getJson(baseUrl).then(function (b) { return { j: b, model: OM_BEST, filled: false }; }); };
    if (m === OM_BEST) return best();
    return getJson(baseUrl + '&models=' + m.id).then(function (j) {
      var c = j && j.current;
      if (!c || c.temperature_2m === null || c.temperature_2m === undefined) return best(); // no data here
      if (!omHasGaps(j)) return { j: j, model: m, filled: false };
      return getJson(baseUrl).then(function (b) { return { j: j, model: m, filled: omFill(j, b) }; },
        function () { return { j: j, model: m, filled: false }; });
    }, function (e) {
      if (e && e.name === 'AbortError') throw e;
      return best();
    });
  }
  function modelText(model, filled) {
    if (!model) return '';
    return 'Model: ' + model.label + (filled ? '; later hours from Open-Meteo best match' : '');
  }
  ReadyMap.models = { list: OM_MODELS, best: OM_BEST, pick: omModelFor, hasGaps: omHasGaps, fill: omFill, text: modelText };

  /** Country lookup with a time limit, so a slow lookup never holds up the weather. */
  function countryQuick(lat, lon, ms) {
    var have = Country.known(lat, lon);
    if (have !== undefined) return Promise.resolve(have);
    return Promise.race([Country.lookup(lat, lon), new Promise(function (r) { setTimeout(function () { r(undefined); }, ms || 2500); })]);
  }

  /**
   * Official national weather services (1.3.0), by country code. Every URL was opened on
   * 2026-11-02 and loaded (HTTP 200). The U.S. link is built for the spot (NWS point forecast).
   */
  var WX_SERVICES = {
    US: ['National Weather Service (NOAA)', 'https://www.weather.gov/'],
    PR: ['National Weather Service (NOAA)', 'https://www.weather.gov/'],
    VI: ['National Weather Service (NOAA)', 'https://www.weather.gov/'],
    GU: ['National Weather Service (NOAA)', 'https://www.weather.gov/'],
    MP: ['National Weather Service (NOAA)', 'https://www.weather.gov/'],
    AS: ['National Weather Service (NOAA)', 'https://www.weather.gov/'],
    CA: ['Environment Canada (ECCC)', 'https://weather.gc.ca/'],
    GB: ['UK Met Office', 'https://www.metoffice.gov.uk/'],
    DE: ['Deutscher Wetterdienst (DWD)', 'https://www.dwd.de/'],
    FR: ['Météo-France', 'https://meteofrance.com/'],
    JP: ['Japan Meteorological Agency (JMA)', 'https://www.jma.go.jp/jma/indexe.html'],
    AU: ['Bureau of Meteorology (BoM)', 'https://www.bom.gov.au/'],
    CR: ['Instituto Meteorológico Nacional (IMN) radar', 'https://www.imn.ac.cr/radar'],
    MX: ['Servicio Meteorológico Nacional (SMN)', 'https://smn.conagua.gob.mx/es/'],
    ES: ['AEMET', 'https://www.aemet.es/'],
    IT: ['Aeronautica Militare Meteo', 'https://www.meteoam.it/'],
    NL: ['KNMI', 'https://www.knmi.nl/'],
    BE: ['Royal Meteorological Institute (RMI)', 'https://www.meteo.be/'],
    CH: ['MeteoSwiss', 'https://www.meteoswiss.admin.ch/'],
    LI: ['MeteoSwiss', 'https://www.meteoswiss.admin.ch/'],
    AT: ['GeoSphere Austria', 'https://www.geosphere.at/'],
    NO: ['MET Norway (Yr)', 'https://www.met.no/'],
    SE: ['SMHI', 'https://www.smhi.se/'],
    DK: ['DMI', 'https://www.dmi.dk/'],
    FI: ['Finnish Meteorological Institute', 'https://en.ilmatieteenlaitos.fi/'],
    IE: ['Met Éireann', 'https://www.met.ie/'],
    PT: ['IPMA', 'https://www.ipma.pt/'],
    NZ: ['MetService', 'https://www.metservice.com/'],
    BR: ['INMET', 'https://portal.inmet.gov.br/'],
    CL: ['Dirección Meteorológica de Chile', 'https://www.meteochile.gob.cl/'],
    CO: ['IDEAM', 'https://www.ideam.gov.co/'],
    UY: ['INUMET', 'https://www.inumet.gub.uy/'],
    EC: ['INAMHI', 'https://www.inamhi.gob.ec/'],
    BO: ['SENAMHI Bolivia', 'https://senamhi.gob.bo/'],
    PY: ['Dirección de Meteorología e Hidrología', 'https://www.meteorologia.gov.py/'],
    GT: ['INSIVUMEH', 'https://insivumeh.gob.gt/'],
    DO: ['INDOMET', 'https://indomet.gob.do/'],
    JM: ['Meteorological Service of Jamaica', 'https://metservice.gov.jm/'],
    IN: ['India Meteorological Department (IMD)', 'https://mausam.imd.gov.in/'],
    CN: ['China Meteorological Administration', 'https://www.cma.gov.cn/en/'],
    KR: ['Korea Meteorological Administration', 'https://www.weather.go.kr/'],
    TW: ['Central Weather Administration', 'https://www.cwa.gov.tw/'],
    HK: ['Hong Kong Observatory', 'https://www.hko.gov.hk/'],
    SG: ['Meteorological Service Singapore', 'https://www.weather.gov.sg/'],
    MY: ['MetMalaysia', 'https://www.met.gov.my/'],
    ID: ['BMKG', 'https://www.bmkg.go.id/'],
    PH: ['PAGASA', 'https://www.pagasa.dost.gov.ph/'],
    VN: ['National Center for Hydro-Meteorological Forecasting', 'https://www.nchmf.gov.vn/kttvsite/'],
    PK: ['Pakistan Meteorological Department', 'https://www.pmd.gov.pk/'],
    NP: ['Department of Hydrology and Meteorology', 'https://www.dhm.gov.np/'],
    BT: ['National Center for Hydrology and Meteorology', 'https://www.nchm.gov.bt/'],
    ZA: ['South African Weather Service', 'https://www.weathersa.co.za/'],
    KE: ['Kenya Meteorological Department', 'https://meteo.go.ke/'],
    PL: ['IMGW', 'https://imgw.pl/'],
    CZ: ['CHMI', 'https://www.chmi.cz/'],
    SK: ['SHMU', 'https://www.shmu.sk/'],
    HU: ['HungaroMet', 'https://www.met.hu/'],
    RO: ['Meteo Romania', 'https://www.meteoromania.ro/'],
    SI: ['ARSO Meteo', 'https://meteo.arso.gov.si/'],
    HR: ['DHMZ', 'https://meteo.hr/'],
    LT: ['Lithuanian Hydrometeorological Service', 'https://www.meteo.lt/'],
    EE: ['Estonian Environment Agency', 'https://www.ilmateenistus.ee/'],
    UA: ['Ukrainian Hydrometeorological Center', 'https://www.meteo.gov.ua/'],
    TR: ['Turkish State Meteorological Service', 'https://www.mgm.gov.tr/'],
    IL: ['Israel Meteorological Service', 'https://ims.gov.il/'],
    IS: ['Icelandic Met Office', 'https://www.vedur.is/']
  };
  /** { name, url } of the official weather service for a country, or null. */
  function officialService(cc, lat, lon) {
    var s = cc && WX_SERVICES[cc];
    if (!s) return null;
    var url = s[1];
    if (cc === 'US' && isFinite(lat) && isFinite(lon)) {
      url = 'https://forecast.weather.gov/MapClick.php?lat=' + Number(lat).toFixed(4) + '&lon=' + Number(lon).toFixed(4);
    }
    return { name: s[0], url: url };
  }
  ReadyMap.officialService = officialService;
  ReadyMap.wxServices = WX_SERVICES;

  // ---------------------------------------------------------------------------
  // 14. Weather overlays
  // ---------------------------------------------------------------------------
  var Weather = (function () {
    var RADAR_WMS = 'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows';
    var SAT_WMS = 'https://nowcoast.noaa.gov/geoserver/observations/satellite/ows';
    var RADAR_LAYER = 'base_reflectivity_mosaic';
    var RADAR_TIME_LAYER = 'conus_base_reflectivity_mosaic';
    var RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
    var ALERTS_API = 'https://api.weather.gov/alerts/active';
    var NWS_ACCEPT = 'application/geo+json';
    var FRAME_MS = 700;
    var MAX_FRAMES = 8;
    var ALERT_REFRESH_MS = 5 * 60 * 1000;
    var CAPS_MAX_AGE = 4 * 60 * 1000;
    var OFFLINE_MSG = 'Weather needs internet. Try again when you have signal.';
    // 1.3.0: sharper national radar, used automatically when zoomed in over that country.
    // Both servers send Access-Control-Allow-Origin: * and were checked to return radar tiles
    // (EPSG:3857 PNG) on 2026-11-02. boxes: [south, west, north, east].
    var NATIONAL_MIN_ZOOM = 6;
    var NATIONAL_RADARS = [
      { id: 'eccc', cc: 'CA', name: 'Environment Canada', where: 'Canada',
        url: 'https://geo.weather.gc.ca/geomet', layer: 'RADAR_1KM_RRAI',
        caps: 'https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetCapabilities&layer=RADAR_1KM_RRAI',
        boxes: [[41.6, -141.1, 72, -52.5]],
        attribution: 'Radar: <a href="https://eccc-msc.github.io/open-data/licence/readme_en/">Environment and Climate Change Canada</a>',
        note: 'Canada radar from Environment Canada (1 km detail, every 6 minutes). Used when you zoom in over Canada.' },
      { id: 'dwd', cc: 'DE', name: 'DWD', where: 'Germany',
        url: 'https://maps.dwd.de/geoserver/dwd/wms', layer: 'dwd:RADOLAN-RY', capsLayer: 'RADOLAN-RY',
        caps: 'https://maps.dwd.de/geoserver/dwd/RADOLAN-RY/ows?service=WMS&version=1.3.0&request=GetCapabilities',
        boxes: [[47.2, 5.8, 55.1, 15.1]],
        attribution: 'Radar: <a href="https://www.dwd.de/">Deutscher Wetterdienst (DWD)</a>',
        note: 'Germany radar from the DWD (1 km detail, every 5 minutes). Used when you zoom in over Germany.' }
    ];
    function nationalById(id) {
      for (var i = 0; i < NATIONAL_RADARS.length; i++) if (NATIONAL_RADARS[i].id === id) return NATIONAL_RADARS[i];
      return null;
    }

    var capsCache = {}; // url -> {text, at}
    var zoneCache = new Map(); // zone url -> geometry|null

    // fallbackGen: the radar generation that already started the RainViewer fallback (one per
    // generation); fallbackFlight: the in-flight RainViewer request, if any.
    // area: the "Which radar" choice ('auto' | 'us' | 'world'); pick: what auto/us/world chose
    // for this generation ('noaa' | 'world'). mode is what is really on screen (NOAA can fall
    // back to RainViewer).
    var radar = { on: false, mode: 'noaa', layer: null, frames: [], frameLayers: [], idx: 0, timer: null,
      playing: false, lastGood: null, gen: 0, errors: 0, loads: 0, fallbackGen: -1, fallbackFlight: null,
      area: 'auto', pick: 'noaa', moveTimer: null, nat: null, wantLoop: false };
    var sat = { on: false, kind: 'goes_longwave_imagery', layer: null, lastGood: null, gen: 0 };
    var gdacs = { on: false, layer: null, gen: 0, ctrl: null, features: [], lastGood: null, listTimer: null };
    var alerts = { on: false, layer: null, renderer: null, timer: null, lastGood: null, lastFetch: 0, gen: 0,
      ctrl: null, features: [], featuresKey: null, stateCode: null, stateKey: null, wholeState: false };

    function opacity(id) { return Number($(id).value) / 100; }

    function setToggle(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

    function lastUpdatedText(t) { return t ? ' Last updated ' + formatLocalTime(t) + '.' : ''; }

    function getCaps(url) {
      var c = capsCache[url];
      if (c && Date.now() - c.at < CAPS_MAX_AGE) return Promise.resolve(c.text);
      var capsUrl = url.indexOf('?') !== -1 ? url : url + '?service=WMS&version=1.3.0&request=GetCapabilities';
      return fetchWithTimeout(capsUrl, { credentials: 'omit' }, FETCH_TIMEOUT_MS).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (text) {
        capsCache[url] = { text: text, at: Date.now() };
        return text;
      });
    }

    function legendUrl(url, layer) {
      return url + '?service=WMS&request=GetLegendGraphic&format=image/png&layer=' + encodeURIComponent(layer);
    }

    function showLegend(imgId, src) {
      var img = $(imgId);
      if (img.getAttribute('src') === src) return;
      img.onload = function () { img.hidden = false; };
      img.onerror = function () { img.hidden = true; };
      img.src = src;
    }

    function wmsLayer(url, layerName, time, opac, attribution) {
      var opts = {
        layers: layerName,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        tileSize: 256,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 0,
        maxZoom: 19,
        pane: 'weather',
        opacity: opac,
        attribution: attribution
      };
      if (time) opts.time = time; // extra option -> becomes the WMS TIME param
      return L.tileLayer.wms(url, opts);
    }

    // ----- Radar -----
    function radarOpacity() { return opacity('opacity-radar'); }

    function makeRadarLayer(frame, opac) {
      if (radar.mode === 'rainviewer') {
        return L.tileLayer(frame.url, {
          tileSize: 256, maxNativeZoom: 7, maxZoom: 19, pane: 'weather', opacity: opac,  // RainViewer free API: max zoom 7 since 2026-01-01 (rainviewer.com/api/transition-faq.html); higher z returns a "Zoom Level Not Supported" tile.
          updateWhenIdle: true, attribution: RAINVIEWER_ATTRIBUTION
        });
      }
      if (radar.mode === 'national' && radar.nat) {
        return wmsLayer(radar.nat.url, radar.nat.layer, frame.time, opac, radar.nat.attribution);
      }
      return wmsLayer(RADAR_WMS, RADAR_LAYER, frame.time, opac, NOAA_ATTRIBUTION);
    }

    /**
     * Which radar this generation should use: 'noaa' | 'world' | a national radar id.
     * Auto: a national radar when zoomed in (zoom 6+) over that country, NOAA in its coverage,
     * RainViewer elsewhere. Near borders the country is looked up once per area (cached); until
     * it is known, NOAA wins inside NOAA coverage.
     */
    function radarWant() {
      if (radar.area === 'us') return 'noaa';
      if (radar.area === 'world') return 'world';
      var c = state.map.getCenter();
      var lat = c.lat, lon = wrapLon(c.lng);
      var noaa = inNoaaRadarCoverage(lat, lon);
      if (state.map.getZoom() >= NATIONAL_MIN_ZOOM) {
        for (var i = 0; i < NATIONAL_RADARS.length; i++) {
          var n = NATIONAL_RADARS[i];
          if (!inBoxes(n.boxes, lat, lon)) continue;
          var cc = Country.known(lat, lon);
          if (cc === undefined) {
            Country.lookup(lat, lon).then(function () {
              if (radar.on && radar.area === 'auto' && radarWant() !== radar.pick) radarOn();
            });
            if (!noaa) return n.id;
            continue;
          }
          if (cc === n.cc || (cc === null && !noaa)) return n.id;
        }
      }
      return noaa ? 'noaa' : 'world';
    }
    function radarWantsNoaa() { return radarWant() === 'noaa'; }

    function radarNational(nat, gen) {
      showLegend('legend-radar', legendUrl(nat.url, nat.layer));
      $('legend-radar').alt = 'Radar color key from ' + nat.name;
      getCaps(nat.caps).then(function (xml) {
        if (gen !== radar.gen) return;
        var dim = parseWmsDimension(xml, nat.capsLayer || nat.layer);
        if (!dim.times.length) throw new Error('no times');
        var latest = dim.def && dim.def >= dim.times[dim.times.length - 1] ? dim.def : dim.times[dim.times.length - 1];
        if (Date.parse(latest) > Date.now() + 5 * 60000) throw new Error('bad time');
        var frames = pickFrames(dim.times.filter(function (t) { return t <= latest; }), MAX_FRAMES, 9 * 60000, 70 * 60000);
        radar.mode = 'national';
        radar.nat = nat;
        showRadarFrames(frames.map(function (t) { return { time: t.replace('.000Z', 'Z'), date: new Date(t) }; }));
      }).catch(function () {
        if (gen !== radar.gen) return;
        useRainViewer(gen);
      });
    }

    function radarOn() {
      radar.on = true;
      setToggle('toggle-radar', true);
      var gen = ++radar.gen;
      $('radar-note').textContent = '';
      radar.pick = radarWant();
      if (!navigator.onLine) { radarOffline(); return; }
      $('time-radar').textContent = 'Loading…';
      if (radar.pick === 'world') { useRainViewer(gen); return; }
      var nat = nationalById(radar.pick);
      if (nat) { radarNational(nat, gen); return; }
      showLegend('legend-radar', legendUrl(RADAR_WMS, RADAR_LAYER));
      $('legend-radar').alt = 'Radar color key from NOAA, in dBZ (rain strength)';
      getCaps(RADAR_WMS).then(function (xml) {
        if (gen !== radar.gen) return;
        var dim = parseWmsDimension(xml, RADAR_TIME_LAYER);
        if (!dim.times.length) throw new Error('no times');
        var latest = dim.def && dim.def >= dim.times[dim.times.length - 1] ? dim.def : dim.times[dim.times.length - 1];
        var frames = pickFrames(dim.times.filter(function (t) { return t <= latest; }), MAX_FRAMES, 9 * 60000, 70 * 60000);
        radar.mode = 'noaa';
        showRadarFrames(frames.map(function (t) { return { time: t, date: new Date(t) }; }));
      }).catch(function () {
        if (gen !== radar.gen) return;
        useRainViewer(gen);
      });
    }

    function showRadarFrames(frames) {
      removeRadarLayers();
      radar.frames = frames;
      radar.idx = frames.length - 1;
      radar.errors = 0;
      radar.loads = 0;
      var latest = frames[frames.length - 1];
      var layer = makeRadarLayer(latest, radarOpacity());
      var gen = radar.gen;
      var isNoaa = radar.mode !== 'rainviewer'; // NOAA or a national radar: RainViewer is the backup
      // Count per viewport load: Leaflet fires 'loading' when a new batch of tiles starts
      // (pan/zoom) and 'load' when every tile of the batch has finished (errors included).
      layer.on('loading', function () { radar.errors = 0; radar.loads = 0; });
      layer.on('tileload', function () { radar.loads++; });
      layer.on('tileerror', function () {
        radar.errors++;
        // Many errors and nothing loaded in this batch: no need to wait for the rest.
        if (isNoaa && radar.loads === 0 && radar.errors >= 3 && gen === radar.gen) useRainViewer(gen);
      });
      layer.on('load', function () {
        // The whole batch failed (also covers small views with only 1-2 tiles).
        if (isNoaa && radar.errors > 0 && radar.loads === 0 && gen === radar.gen) useRainViewer(gen);
        radar.errors = 0;
        radar.loads = 0;
      });
      layer.addTo(state.map);
      radar.layer = layer;
      radar.frameLayers = [];
      radar.frameLayers[radar.idx] = layer;
      radar.lastGood = latest.date;
      $('time-radar').textContent = formatLocalTime(latest.date) + radarSourceText();
      $('radar-frame-time').textContent = '';
      $('btn-radar-play').disabled = frames.length < 2;
      updateLoopUi();
      // 1.4.2: new frames (map moved to another radar, backup radar, retry) keep a loop the user started.
      if (radar.wantLoop && frames.length >= 2 && !document.hidden) startLoop();
      if (radar.mode === 'rainviewer' && radar.pick === 'world') {
        $('radar-note').textContent = 'World radar from RainViewer. It is less detailed when you zoom in close.';
      } else if (radar.mode === 'rainviewer') {
        $('radar-note').textContent = 'Using backup radar (RainViewer).';
      } else if (radar.mode === 'national' && radar.nat) {
        $('radar-note').textContent = radar.nat.note;
      } else {
        $('radar-note').textContent = 'U.S. radar from NOAA. It covers the U.S. and its territories.';
      }
    }

    function radarSourceText() {
      if (radar.mode === 'national' && radar.nat) return ' · ' + radar.nat.name + ' (' + radar.nat.where + ')';
      if (radar.mode !== 'rainviewer') return ' · NOAA (U.S.)';
      return radar.pick === 'world' ? ' · RainViewer (world)' : ' · RainViewer (backup)';
    }

    /** Auto mode: after the map stops moving, switch source if the center crossed the NOAA edge. */
    function onMapMoveForRadar() {
      clearTimeout(radar.moveTimer);
      radar.moveTimer = setTimeout(function () {
        if (!radar.on || radar.area !== 'auto') return;
        var want = radarWant();
        if (want !== radar.pick) radarOn();
      }, 800);
    }

    /** Switch to RainViewer. Guarded: at most one API request per radar generation. */
    function useRainViewer(gen) {
      if (gen !== radar.gen || !radar.on) return Promise.resolve();
      if (radar.fallbackFlight) return radar.fallbackFlight;
      if (radar.fallbackGen === gen) return Promise.resolve();
      if (!navigator.onLine) { radarOffline(); return Promise.resolve(); }
      radar.fallbackGen = gen;
      var natFail = nationalById(radar.pick);
      $('radar-note').textContent = radar.pick === 'world' ? 'Loading world radar…'
        : natFail ? natFail.where + ' radar is not loading. Trying backup radar…' : 'NOAA radar is not loading. Trying backup radar…';
      var flight = fetchWithTimeout(RAINVIEWER_API, { credentials: 'omit' }, FETCH_TIMEOUT_MS).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        if (gen !== radar.gen) return;
        var past = (json && json.radar && json.radar.past) || [];
        var host = String(json.host || '');
        if (!past.length || !/^https:\/\/[a-z0-9.-]+$/i.test(host)) throw new Error('no frames');
        var frames = past.slice(-MAX_FRAMES).map(function (f) {
          return { time: String(f.time), date: new Date(f.time * 1000), url: host + f.path + '/256/{z}/{x}/{y}/2/1_1.png' };
        });
        radar.mode = 'rainviewer';
        showRadarFrames(frames);
      }).catch(function () {
        if (gen !== radar.gen) return;
        radarFailed();
      }).finally(function () {
        if (radar.fallbackFlight === flight) radar.fallbackFlight = null;
      });
      radar.fallbackFlight = flight;
      return flight;
    }

    function radarOffline() {
      $('radar-note').textContent = OFFLINE_MSG + lastUpdatedText(radar.lastGood);
      $('time-radar').textContent = radar.lastGood ? formatLocalTime(radar.lastGood) + ' (old)' : 'Not loaded';
    }
    function radarFailed() {
      $('radar-note').textContent = (navigator.onLine ? 'Radar could not load right now. Turn it off and on to try again.' : OFFLINE_MSG) +
        lastUpdatedText(radar.lastGood);
      $('time-radar').textContent = radar.lastGood ? formatLocalTime(radar.lastGood) + ' (old)' : 'Not loaded';
    }

    function removeRadarLayers() {
      stopLoop();
      radar.frameLayers.forEach(function (l) { if (l && state.map.hasLayer(l)) state.map.removeLayer(l); });
      if (radar.layer && state.map.hasLayer(radar.layer)) state.map.removeLayer(radar.layer);
      radar.frameLayers = [];
      radar.layer = null;
    }

    function radarOff() {
      radar.on = false;
      radar.wantLoop = false;
      radar.gen++;
      radar.fallbackFlight = null; // a late reply is ignored by its gen check
      removeRadarLayers();
      setToggle('toggle-radar', false);
      $('time-radar').textContent = 'Off';
      $('radar-note').textContent = '';
      $('radar-frame-time').textContent = '';
      $('btn-radar-play').disabled = true;
      updateLoopUi();
    }

    /** 1.4.2 On-map loop button: shown whenever radar is on with 2+ frames, mirrors Play/Pause loop. */
    function updateLoopUi() {
      var b = $('btn-map-loop');
      if (!b) return;
      var can = radar.on && radar.frames.length >= 2;
      b.hidden = !can;
      b.setAttribute('aria-pressed', radar.playing ? 'true' : 'false');
      $('map-loop-label').textContent = radar.playing ? 'Pause radar loop' : 'Play radar loop';
      var f = radar.playing && radar.frames[radar.idx];
      $('map-loop-time').textContent = f ? formatLocalTime(f.date) : '';
    }

    /** User Play/Pause (Weather sheet button or the on-map button). Only this and Radar off end a loop for good. */
    function toggleLoopByUser() {
      if (radar.playing) { radar.wantLoop = false; stopLoop(); }
      else { radar.wantLoop = true; startLoop(); }
    }

    function showFrame(i) {
      var op = radarOpacity();
      radar.idx = i;
      radar.frameLayers.forEach(function (l, j) { if (l) l.setOpacity(j === i ? op : 0); });
      var f = radar.frames[i];
      $('radar-frame-time').textContent = 'Frame ' + (i + 1) + ' of ' + radar.frames.length + ': ' + formatLocalTime(f.date);
      updateLoopUi();
    }

    function startLoop() {
      if (!radar.on || radar.frames.length < 2 || radar.playing) return;
      // Preload: one layer per frame, hidden (opacity 0), switch by opacity.
      radar.frames.forEach(function (f, i) {
        if (!radar.frameLayers[i]) {
          var l = makeRadarLayer(f, 0);
          l.addTo(state.map);
          radar.frameLayers[i] = l;
        }
      });
      radar.playing = true;
      radar.wantLoop = true;
      var b = $('btn-radar-play');
      b.textContent = 'Pause loop';
      b.setAttribute('aria-pressed', 'true');
      var i = 0;
      showFrame(i);
      radar.timer = setInterval(function () {
        i = (i + 1) % radar.frames.length;
        showFrame(i);
      }, FRAME_MS);
    }

    function stopLoop() {
      if (radar.timer) clearInterval(radar.timer);
      radar.timer = null;
      if (!radar.playing) return;
      radar.playing = false;
      var b = $('btn-radar-play');
      b.textContent = 'Play loop';
      b.setAttribute('aria-pressed', 'false');
      // Back to the newest frame and drop the extra layers to keep requests low.
      var last = radar.frames.length - 1;
      radar.frameLayers.forEach(function (l, j) {
        if (l && j !== last && state.map.hasLayer(l)) state.map.removeLayer(l);
      });
      var keep = radar.frameLayers[last];
      radar.frameLayers = [];
      radar.frameLayers[last] = keep;
      if (keep) keep.setOpacity(radarOpacity());
      radar.idx = last;
      $('radar-frame-time').textContent = '';
      updateLoopUi();
    }

    // ----- Satellite -----
    function satOn() {
      sat.on = true;
      setToggle('toggle-satellite', true);
      var gen = ++sat.gen;
      $('satellite-note').textContent = '';
      if (!navigator.onLine) { satProblem(); return; }
      $('time-satellite').textContent = 'Loading…';
      var world = isWorldSat(sat.kind);
      showLegend('legend-satellite', legendUrl(SAT_WMS, sat.kind));
      $('satellite-source').textContent = world
        ? 'World pictures: NOAA/NESDIS GMGSI, a mix of many weather satellites (GOES, Himawari, Meteosat). Updated every hour, about 2 to 3 hours old. Not shown near the poles.'
        : 'Americas pictures: NOAA GOES satellites. They cover North and South America and are updated every few minutes.';
      getCaps(SAT_WMS).then(function (xml) {
        if (gen !== sat.gen) return;
        var dim = parseWmsDimension(xml, sat.kind);
        // Exact listed time (see pickWmsTime); the server default only if nothing is listed.
        var latest = pickWmsTime(dim.listed, Date.now()) || dim.def;
        if (!latest) throw new Error('no time');
        if (sat.layer) state.map.removeLayer(sat.layer);
        var errors = 0, loads = 0;
        sat.layer = wmsLayer(SAT_WMS, sat.kind, latest, opacity('opacity-satellite'), world ? GMGSI_ATTRIBUTION : NOAA_ATTRIBUTION);
        sat.layer.on('tileload', function () { loads++; });
        sat.layer.on('tileerror', function () {
          errors++;
          if (errors === 3 && loads === 0 && gen === sat.gen) {
            $('satellite-note').textContent = 'Cloud pictures are not loading right now. Try again later.';
          }
        });
        sat.layer.addTo(state.map);
        sat.lastGood = new Date(latest);
        $('time-satellite').textContent = formatLocalTime(sat.lastGood) + (world ? ' · World mix (GMGSI)' : ' · GOES (Americas)');
        if (/visible/.test(sat.kind)) {
          $('satellite-note').textContent = 'Daytime pictures are dark at night. Use "Night and day" after sunset.';
        } else if (world) {
          $('satellite-note').textContent = 'World pictures are updated every hour and are about 2 to 3 hours old.';
        }
      }).catch(function () {
        if (gen !== sat.gen) return;
        satProblem();
      });
    }

    function isWorldSat(kind) { return /^global_/.test(kind); }

    function satProblem() {
      $('satellite-note').textContent = (navigator.onLine ? 'Cloud pictures could not load right now. Turn it off and on to try again.' : OFFLINE_MSG) +
        lastUpdatedText(sat.lastGood);
      $('time-satellite').textContent = sat.lastGood ? formatLocalTime(sat.lastGood) + ' (old)' : 'Not loaded';
    }

    function satOff() {
      sat.on = false;
      sat.gen++;
      if (sat.layer) state.map.removeLayer(sat.layer);
      sat.layer = null;
      setToggle('toggle-satellite', false);
      $('time-satellite').textContent = 'Off';
      $('satellite-note').textContent = '';
    }

    // ----- Alerts -----
    function alertPoint() {
      if (state.userFix) return { lat: state.userFix.lat, lon: state.userFix.lon, where: 'your location' };
      var c = state.map.getCenter().wrap();
      return { lat: c.lat, lon: c.lng, where: 'the center of the map' };
    }

    // Note: browsers do not let page JS set User-Agent (fetch silently drops it), so the browser's own
    // UA is sent to api.weather.gov. We only send Accept (a CORS-safelisted header) to avoid a preflight.
    function nwsFetch(url, signal) {
      return fetchWithTimeout(url, { headers: { Accept: NWS_ACCEPT }, credentials: 'omit' }, FETCH_TIMEOUT_MS, signal);
    }

    function alertsOn() {
      alerts.on = true;
      setToggle('toggle-alerts', true);
      $('btn-alerts-refresh').disabled = false;
      $('alerts-state').disabled = false;
      fetchAlerts();
      scheduleAlerts();
    }

    function scheduleAlerts() {
      clearInterval(alerts.timer);
      alerts.timer = null;
      if (!alerts.on || document.hidden) return;
      alerts.timer = setInterval(function () { if (!document.hidden) fetchAlerts(); }, ALERT_REFRESH_MS);
    }

    function stateCodeFromFeatures(features) {
      for (var i = 0; i < features.length; i++) {
        var g = features[i].properties && features[i].properties.geocode;
        var ugc = g && g.UGC && g.UGC[0];
        if (ugc && /^[A-Z]{2}[CZ]\d{3}$/.test(ugc)) return ugc.slice(0, 2);
      }
      return null;
    }

    /** About 1 km grid key: the cached state code belongs to the spot it was found for. */
    function placeKey(pt) { return pt.lat.toFixed(2) + ',' + pt.lon.toFixed(2); }

    /** Forget the state code when the spot we check has moved. */
    function syncStateFor(pt) {
      var key = placeKey(pt);
      if (alerts.stateKey === key) return;
      alerts.stateKey = key;
      alerts.stateCode = null;
      $('alerts-state-code').textContent = '';
    }

    function setStateCode(code, pt) {
      alerts.stateCode = code;
      alerts.stateKey = placeKey(pt);
      $('alerts-state-code').textContent = ' (' + code + ')';
    }

    function lookupStateCode(pt, signal) {
      syncStateFor(pt);
      if (alerts.stateCode) return Promise.resolve(alerts.stateCode);
      // Only reuse alert geocodes from a point query for this same spot.
      if (alerts.featuresKey === placeKey(pt)) {
        var fromAlerts = stateCodeFromFeatures(alerts.features);
        if (fromAlerts) return Promise.resolve(fromAlerts);
      }
      return nwsFetch('https://api.weather.gov/points/' + pt.lat.toFixed(4) + ',' + pt.lon.toFixed(4), signal)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function (j) {
          var s = j && j.properties && j.properties.relativeLocation && j.properties.relativeLocation.properties &&
            j.properties.relativeLocation.properties.state;
          if (!s || !/^[A-Z]{2}$/.test(s)) throw new Error('no state');
          return s;
        });
    }

    /** Usable alert features from an api.weather.gov alerts answer, worst first. Shared with Local weather. */
    function alertFeatures(json) {
      var features = (json && Array.isArray(json.features) ? json.features : []).filter(function (f) {
        return f && f.properties;
      });
      features.sort(function (a, b) { return severityRank(b.properties.severity) - severityRank(a.properties.severity); });
      return features;
    }

    function fetchAlerts() {
      if (!alerts.on) return;
      var gen = ++alerts.gen;
      if (alerts.ctrl) alerts.ctrl.abort();
      var ctrl = new AbortController();
      alerts.ctrl = ctrl;
      var note = $('alerts-note');
      if (!navigator.onLine) {
        note.textContent = OFFLINE_MSG + lastUpdatedText(alerts.lastGood);
        if (!alerts.lastGood) $('time-alerts').textContent = 'Not loaded';
        return;
      }
      alerts.lastFetch = Date.now();
      var pt = alertPoint();
      syncStateFor(pt);
      var wholeState = alerts.wholeState;
      note.textContent = 'Checking for warnings…';
      if (!alerts.lastGood) $('time-alerts').textContent = 'Loading…';
      var urlPromise = wholeState
        ? lookupStateCode(pt, ctrl.signal).then(function (code) {
            if (gen === alerts.gen) setStateCode(code, pt);
            return { url: ALERTS_API + '?area=' + code, where: 'the state of ' + code };
          })
        : Promise.resolve({ url: ALERTS_API + '?point=' + pt.lat.toFixed(4) + ',' + pt.lon.toFixed(4), where: pt.where });

      urlPromise.then(function (q) {
        return nwsFetch(q.url, ctrl.signal).then(function (res) {
          if (res.status === 400 || res.status === 404) {
            var e = new Error('outside'); e.outside = true; throw e;
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function (json) {
          if (gen !== alerts.gen) return;
          var features = alertFeatures(json);
          alerts.features = features;
          // Point results tell us the state of this spot; state-wide results do not change it.
          alerts.featuresKey = wholeState ? null : placeKey(pt);
          if (!wholeState && !alerts.stateCode) {
            var sc = stateCodeFromFeatures(features);
            if (sc) setStateCode(sc, pt);
          }
          alerts.lastGood = json.updated ? new Date(json.updated) : new Date();
          if (isNaN(alerts.lastGood)) alerts.lastGood = new Date();
          $('time-alerts').textContent = formatLocalTime(alerts.lastGood);
          note.textContent = features.length
            ? features.length + ' active warning' + (features.length === 1 ? '' : 's') + ' for ' + q.where + '.'
            : 'No active warnings here right now (' + q.where + ').';
          renderAlertList(features);
          return drawAlerts(features, gen, ctrl.signal);
        });
      }).catch(function (err) {
        if (gen !== alerts.gen) return;
        if (err && err.outside) {
          note.textContent = 'Weather warnings are only for the United States. Move the map or your location to a U.S. spot. ' +
            'For other countries, turn on World disaster alerts below.';
          $('time-alerts').textContent = formatLocalTime(new Date());
          renderAlertList([]);
          clearAlertShapes();
          return;
        }
        if (err && err.name === 'AbortError' && !navigator.onLine) { /* fall through */ }
        note.textContent = (navigator.onLine ? 'Could not get weather warnings right now. Tap Refresh to try again.' : OFFLINE_MSG) +
          lastUpdatedText(alerts.lastGood);
        if (!alerts.lastGood) $('time-alerts').textContent = 'Not loaded';
      });
    }

    function clearAlertShapes() {
      if (alerts.layer) alerts.layer.clearLayers();
    }

    function ensureAlertLayer() {
      if (!alerts.renderer) alerts.renderer = L.svg({ pane: 'alerts' });
      if (!alerts.layer) {
        alerts.layer = L.featureGroup([], { attribution: NOAA_ATTRIBUTION });
        alerts.layer.getAttribution = function () { return NOAA_ATTRIBUTION; };
        alerts.layer.addTo(state.map);
      }
    }

    function alertStyle(sev) {
      var c = severityColor(sev);
      return { color: c, weight: 2, opacity: 0.95, fillColor: c, fillOpacity: opacity('opacity-alerts') };
    }

    function addAlertShape(feature, geometry) {
      var p = feature.properties;
      var gj = L.geoJSON({ type: 'Feature', geometry: geometry, properties: {} }, {
        pane: 'alerts', renderer: alerts.renderer, style: function () { return alertStyle(p.severity); }
      });
      gj.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        openAlert(feature);
      });
      gj._rmSeverity = p.severity;
      alerts.layer.addLayer(gj);
    }

    function zoneUrls(f) {
      var seen = {};
      return (f.properties.affectedZones || []).filter(function (u) {
        if (typeof u !== 'string' || !/^https:\/\/api\.weather\.gov\/zones\//.test(u) || seen[u]) return false;
        seen[u] = true;
        return true;
      });
    }

    /** Re-stack shapes so the most severe sit on top (least severe drawn/brought first). */
    function restackAlerts() {
      if (!alerts.layer) return;
      var list = [];
      alerts.layer.eachLayer(function (l) { list.push(l); });
      list.sort(function (a, b) { return severityRank(a._rmSeverity) - severityRank(b._rmSeverity); });
      list.forEach(function (l) { if (l.bringToFront) l.bringToFront(); });
    }

    /**
     * Draw alert polygons. Alerts without geometry need their zone shapes: at most ZONE_BUDGET
     * new zone requests per refresh, one at a time, cached in memory. The budget goes to the
     * most severe alerts first (features arrive sorted most severe first) and each zone URL is
     * fetched once even if several alerts share it. Shapes are drawn least severe first so the
     * most severe end up on top.
     */
    function drawAlerts(features, gen, signal) {
      ensureAlertLayer();
      clearAlertShapes();
      var ZONE_BUDGET = 10;
      var budget = ZONE_BUDGET;
      var toFetch = [];   // unique uncached zone URLs, most severe alert first
      var queued = {};
      features.forEach(function (f) {
        if (f.geometry) return;
        zoneUrls(f).forEach(function (u) {
          if (zoneCache.has(u) || queued[u] || budget <= 0) return;
          queued[u] = true;
          budget--;
          toFetch.push(u);
        });
      });

      // Shapes we can draw now: real geometry plus cached zones, least severe first.
      function drawAvailable(onlyZones) {
        features.slice().reverse().forEach(function (f) {
          if (f.geometry) { if (!onlyZones) addAlertShape(f, f.geometry); return; }
          zoneUrls(f).forEach(function (u) {
            var g = zoneCache.get(u);
            if (g && (!onlyZones || queued[u])) addAlertShape(f, g);
          });
        });
      }
      drawAvailable(false);
      restackAlerts();
      if (!toFetch.length) return Promise.resolve();

      return toFetch.reduce(function (chain, url) {
        return chain.then(function () {
          if (gen !== alerts.gen || !alerts.on) return;
          return nwsFetch(url, signal).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function (z) {
            zoneCache.set(url, z && z.geometry ? z.geometry : null);
          }).catch(function () { /* skip this zone */ });
        });
      }, Promise.resolve()).then(function () {
        if (gen !== alerts.gen || !alerts.on) return;
        // Newly fetched zones, drawn in ascending severity, then re-stack everything.
        drawAvailable(true);
        restackAlerts();
      });
    }

    function renderAlertList(features) {
      var list = $('alerts-list');
      clear(list);
      if (!features.length) {
        list.appendChild(el('li', { text: 'No active warnings here right now.' }));
        return;
      }
      features.forEach(function (f) {
        var p = f.properties;
        var li = el('li', null, [
          el('div', { className: 'alert-item-title', text: p.event || 'Weather alert' }),
          el('div', { className: 'alert-item-meta', text: (p.severity || 'Unknown') + (p.expires || p.ends ? ' · Ends ' + formatLocalTime(p.ends || p.expires) : '') }),
          el('button', {
            type: 'button', className: 'btn', text: 'Read more', 'aria-label': 'Read more about ' + (p.event || 'this alert'),
            on: { click: function (e) { openAlert(f, e.currentTarget); } }
          })
        ]);
        li.style.borderLeftColor = severityColor(p.severity);
        list.appendChild(li);
      });
    }

    function openAlert(feature, opener) {
      var p = feature.properties || {};
      $('alert-event').textContent = p.event || 'Weather alert';
      var sev = $('alert-severity');
      sev.textContent = (p.severity || 'Unknown') + (p.urgency ? ' · ' + p.urgency : '');
      var c = severityColor(p.severity);
      sev.style.background = c;
      sev.style.color = String(p.severity).toLowerCase() === 'minor' ? '#1C1917' : '#FFFFFF';
      $('alert-headline').textContent = p.headline || '';
      $('alert-area').textContent = p.areaDesc || 'Not listed';
      var ends = p.ends || p.expires;
      $('alert-ends').textContent = ends ? formatLocalTime(ends) : 'Not listed';
      $('alert-instruction').textContent = p.instruction || 'Stay alert and follow local officials.';
      $('alert-description').textContent = p.description || '';
      $('alert-description').hidden = true;
      var more = $('btn-alert-more');
      more.hidden = !p.description;
      more.textContent = 'More';
      more.setAttribute('aria-expanded', 'false');
      $('alert-sender').textContent = p.senderName ? 'From ' + p.senderName + '.' : '';
      // 1.4.2: the radar loop keeps playing behind the alert detail sheet.
      openSheet('sheet-alert', opener || document.activeElement);
    }

    function alertsOff() {
      alerts.on = false;
      alerts.gen++;
      if (alerts.ctrl) alerts.ctrl.abort();
      clearInterval(alerts.timer);
      alerts.timer = null;
      if (alerts.layer) { state.map.removeLayer(alerts.layer); alerts.layer = null; }
      setToggle('toggle-alerts', false);
      $('btn-alerts-refresh').disabled = true;
      $('alerts-state').disabled = true;
      $('time-alerts').textContent = 'Off';
      $('alerts-note').textContent = '';
      clear($('alerts-list'));
    }

    function applyAlertOpacity() {
      if (!alerts.layer) return;
      var o = opacity('opacity-alerts');
      alerts.layer.eachLayer(function (gj) { gj.setStyle({ fillOpacity: o }); });
    }

    // ----- World disaster alerts (GDACS) -----
    // One request for the whole world list (about 100 events); the map area and the user's
    // spot are never sent. Feed text is only ever put on the page with textContent.
    var GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';
    var GDACS_REPORT_RE = /^https:\/\/www\.gdacs\.org\//;
    var GDACS_LIST_MAX = 10;
    var GDACS_RANK = { Red: 3, Orange: 2, Green: 1, Unknown: 0 };

    function gdacsNote(text) { $('gdacs-note').textContent = text; }

    function gdacsOn() {
      gdacs.on = true;
      setToggle('toggle-gdacs', true);
      $('btn-gdacs-refresh').disabled = false;
      fetchGdacs();
    }

    function gdacsOff() {
      gdacs.on = false;
      gdacs.gen++;
      if (gdacs.ctrl) gdacs.ctrl.abort();
      gdacs.ctrl = null;
      clearTimeout(gdacs.listTimer);
      if (gdacs.layer) { state.map.removeLayer(gdacs.layer); gdacs.layer = null; }
      gdacs.features = [];
      setToggle('toggle-gdacs', false);
      $('btn-gdacs-refresh').disabled = true;
      $('time-gdacs').textContent = 'Off';
      gdacsNote('');
      clear($('gdacs-list'));
    }

    function gdacsProblem() {
      gdacsNote((navigator.onLine ? 'Could not get world disaster alerts right now. Tap Refresh to try again.' : OFFLINE_MSG) +
        lastUpdatedText(gdacs.lastGood));
      if (!gdacs.lastGood) $('time-gdacs').textContent = 'Not loaded';
      else $('time-gdacs').textContent = formatLocalTime(gdacs.lastGood) + ' (old)';
    }

    /** Clean one GeoJSON feature into plain values we control. null if unusable. */
    function gdacsEvent(f) {
      if (!f || !f.geometry || f.geometry.type !== 'Point' || !f.properties) return null;
      var c = f.geometry.coordinates || [];
      var lon = Number(c[0]), lat = Number(c[1]);
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
      var p = f.properties;
      var report = p.url && typeof p.url.report === 'string' && GDACS_REPORT_RE.test(p.url.report) ? p.url.report : null;
      var sev = p.severitydata && typeof p.severitydata.severitytext === 'string' ? p.severitydata.severitytext : '';
      return {
        lat: lat,
        lon: wrapLon(lon),
        type: gdacsTypeLabel(p.eventtype),
        level: gdacsLevel(p.alertlevel),
        name: String(p.name || p.eventname || gdacsTypeLabel(p.eventtype)).slice(0, 200),
        country: typeof p.country === 'string' ? p.country.slice(0, 200) : '',
        severity: sev.slice(0, 200),
        from: parseGdacsDate(p.fromdate),
        to: parseGdacsDate(p.todate),
        modified: parseGdacsDate(p.datemodified),
        report: report
      };
    }

    function fetchGdacs() {
      if (!gdacs.on) return;
      var gen = ++gdacs.gen;
      if (gdacs.ctrl) gdacs.ctrl.abort();
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      gdacs.ctrl = ctrl;
      if (!navigator.onLine) { gdacsProblem(); return; }
      gdacsNote('Checking for disaster alerts…');
      if (!gdacs.lastGood) $('time-gdacs').textContent = 'Loading…';
      fetchWithTimeout(GDACS_API, { credentials: 'omit', headers: { Accept: 'application/json' } }, 25000, ctrl && ctrl.signal)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function (json) {
          if (gen !== gdacs.gen || !gdacs.on) return;
          var list = (json && Array.isArray(json.features) ? json.features : []).map(gdacsEvent).filter(Boolean);
          gdacs.features = list;
          var newest = null;
          list.forEach(function (e) { if (e.modified && (!newest || e.modified > newest)) newest = e.modified; });
          gdacs.lastGood = newest || new Date();
          $('time-gdacs').textContent = formatLocalTime(gdacs.lastGood) + ' (newest update)';
          var big = list.filter(function (e) { return e.level === 'Red' || e.level === 'Orange'; }).length;
          gdacsNote(list.length
            ? list.length + ' alert' + (list.length === 1 ? '' : 's') + ' in the world now (' + big + ' orange or red).'
            : 'No disaster alerts in the world right now.');
          drawGdacs();
          renderGdacsList();
        }).catch(function () {
          if (gen !== gdacs.gen || !gdacs.on) return;
          gdacsProblem();
        });
    }

    function gdacsLevelClass(level) { return 'gdacs-' + level.toLowerCase(); }

    function gdacsIcon(level) {
      var size = level === 'Red' ? 30 : level === 'Orange' ? 26 : 22;
      // Only fixed, known strings go into this HTML (never feed text).
      return L.divIcon({
        className: 'gdacs-icon',
        html: '<span class="gdacs-dot ' + gdacsLevelClass(level) + '">' + level.charAt(0) + '</span>',
        iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2]
      });
    }

    function gdacsPopup(e) {
      var kids = [
        el('p', { className: 'gdacs-pop-title', text: e.name }),
        el('p', { text: e.type + ' · ' + e.level + ' alert' }),
        e.severity ? el('p', { text: e.severity }) : null,
        e.country ? el('p', { text: 'Where: ' + e.country }) : null,
        e.from ? el('p', { text: 'Started: ' + formatLocalTime(e.from) }) : null,
        e.modified ? el('p', { text: 'Updated: ' + formatLocalTime(e.modified) }) : null
      ];
      if (e.report) {
        kids.push(el('p', null, [el('a', { href: e.report, target: '_blank', rel: 'noopener noreferrer', text: 'Read the GDACS report' })]));
      }
      return el('div', { className: 'gdacs-pop' }, kids);
    }

    function drawGdacs() {
      if (gdacs.layer) state.map.removeLayer(gdacs.layer);
      gdacs.layer = L.featureGroup([], { attribution: GDACS_ATTRIBUTION });
      gdacs.layer.getAttribution = function () { return GDACS_ATTRIBUTION; };
      var op = opacity('opacity-gdacs');
      // Least serious first so red ends up on top.
      gdacs.features.slice().sort(function (a, b) { return GDACS_RANK[a.level] - GDACS_RANK[b.level]; }).forEach(function (e) {
        var m = L.marker([e.lat, e.lon], {
          icon: gdacsIcon(e.level),
          title: e.type + ', ' + e.level + ' alert: ' + e.name,
          alt: e.type + ', ' + e.level + ' alert',
          opacity: op,
          zIndexOffset: GDACS_RANK[e.level] * 100,
          keyboard: true
        });
        m.bindPopup(function () { return gdacsPopup(e); });
        e.marker = m;
        gdacs.layer.addLayer(m);
      });
      gdacs.layer.addTo(state.map);
    }

    function formatFar(m) {
      if (m < 16093) return formatDistance(m) + ' (' + (m / 1000).toFixed(1) + ' km)';
      return Math.round(m / 1609.344).toLocaleString() + ' mi (' + Math.round(m / 1000).toLocaleString() + ' km)';
    }

    /** The 10 alerts nearest the map center, with distance. */
    function renderGdacsList() {
      var list = $('gdacs-list');
      clear(list);
      if (!gdacs.on || !gdacs.features.length) return;
      var c = state.map.getCenter().wrap();
      var near = gdacs.features.map(function (e) {
        return { e: e, d: distanceMeters(c.lat, c.lng, e.lat, e.lon) };
      }).sort(function (a, b) { return a.d - b.d; }).slice(0, GDACS_LIST_MAX);
      near.forEach(function (n) {
        var e = n.e;
        var dot = el('span', { className: 'gdacs-dot ' + gdacsLevelClass(e.level), 'aria-hidden': 'true', text: e.level.charAt(0) });
        var li = el('li', { className: 'gdacs-item' }, [
          el('div', { className: 'gdacs-item-head' }, [dot, el('span', { className: 'alert-item-title', text: e.type + ' · ' + e.level })]),
          el('div', { text: e.name }),
          el('div', { className: 'alert-item-meta', text: formatFar(n.d) + ' from the map center' +
            (e.severity ? ' · ' + e.severity : '') }),
          el('button', {
            type: 'button', className: 'btn', text: 'Show on map', 'aria-label': 'Show on map: ' + e.name,
            on: { click: function () {
              state.map.setView([e.lat, e.lon], Math.max(state.map.getZoom(), 5), { animate: !reducedMotion() });
              // Open after the move ends so the popup's own auto-pan is not cut short.
              setTimeout(function () {
                if (e.marker && gdacs.layer && gdacs.layer.hasLayer(e.marker)) e.marker.openPopup();
              }, reducedMotion() ? 0 : 450);
            } }
          })
        ]);
        li.style.borderLeftColor = { Red: '#C62828', Orange: '#EF6C00', Green: '#2E7D32' }[e.level] || '#607D8B';
        list.appendChild(li);
      });
    }

    function onMapMoveForGdacs() {
      if (!gdacs.on) return;
      clearTimeout(gdacs.listTimer);
      gdacs.listTimer = setTimeout(function () {
        // Do not rebuild the list under the user's keyboard focus (e.g. right after "Show on map").
        var list = $('gdacs-list');
        if (list.contains(document.activeElement)) return;
        renderGdacsList();
      }, 500);
    }

    function applyGdacsOpacity() {
      if (!gdacs.layer) return;
      var o = opacity('opacity-gdacs');
      gdacs.layer.eachLayer(function (m) { if (m.setOpacity) m.setOpacity(o); });
    }

    // ----- Ocean -----
    // All NOAA, no key. Tiles are plain <img> loads and are never cached by the service worker.
    var NOWCOAST_WMS = 'https://nowcoast.noaa.gov/geoserver/ows';
    var NOWCOAST_ROOT = 'https://nowcoast.noaa.gov/geoserver/';
    var RTOFS_WS = 'grtofs';
    var RTOFS_EAST = 'rtofs_east_sfc_currents';
    var RTOFS_WEST = 'rtofs_west_sfc_currents';
    var LAKE_WS = ['leofs', 'lmhofs', 'loofs', 'lsofs']; // Erie, Michigan-Huron, Ontario, Superior
    var SST_WS = 'sea_surface_temperature';
    var SST_NAME = 'nasa_sport_sea_surface_temperature';
    var ENC_WMS = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer';
    var ZONES_EXPORT = 'https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/export';
    // Data areas (from GetCapabilities, rounded out a little) so no tiles are asked for elsewhere.
    var RTOFS_BOUNDS = [[0, -180], [62.5, -40.5]];
    var LAKES_BOUNDS = [[41.3, -92.2], [49.1, -75.9]];

    var GEBCO_WMS = 'https://wms.gebco.net/mapserv';
    var GEBCO_LAYER = 'GEBCO_LATEST_2';
    var WORLD_CURRENTS_MIN_ZOOM = 3;
    var WORLD_CURRENTS_NATIVE_MAX = 8; // ~11 arrows across a 512 px tile at map zoom 8; closer zooms enlarge them
    var BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    var OCEAN_KEYS = ['currents', 'sst', 'depth', 'marinezones', 'worldcurrents', 'worlddepth'];
    var OCEAN_FAIL = {
      currents: 'Ocean currents could not load right now. Turn it off and on to try again.',
      sst: 'Sea temperature could not load right now. Turn it off and on to try again.',
      depth: 'Depth lines could not load right now. Turn it off and on to try again.',
      marinezones: 'Marine zones could not load right now. Turn it off and on to try again.',
      worldcurrents: 'World currents could not load right now. Turn it off and on to try again.',
      worlddepth: 'World sea depth could not load right now. Turn it off and on to try again.'
    };
    var OCEAN_TILE_FAIL = {
      currents: 'Current pictures are not loading right now. Try again later.',
      sst: 'Sea temperature pictures are not loading right now. Try again later.',
      depth: 'Depth lines are not loading right now. Try again later.',
      marinezones: 'Marine zone lines are not loading right now. Try again later.',
      worldcurrents: 'World current arrows are not loading right now. Try again later.',
      worlddepth: 'World sea depth pictures are not loading right now. Try again later.'
    };
    var ocean = {};
    OCEAN_KEYS.forEach(function (k) { ocean[k] = { on: false, layers: [], gen: 0, lastGood: null }; });

    function wsCapsUrl(ws) { return NOWCOAST_ROOT + ws + '/ows'; }

    function intersect(a, b) {
      var set = new Set(b);
      return a.filter(function (x) { return set.has(x); });
    }

    function oceanWms(url, layerNames, time, opac, attribution, extra) {
      var opts = {
        layers: layerNames,
        styles: '',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        tileSize: 256,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 0,
        maxZoom: 19,
        pane: 'ocean',
        opacity: opac,
        attribution: attribution
      };
      if (time) opts.time = time; // exact value from GetCapabilities (see pickWmsTime)
      Object.keys(extra || {}).forEach(function (k) { opts[k] = extra[k]; });
      return L.tileLayer.wms(url, opts);
    }

    /** NWS marine zone outlines from an ArcGIS MapServer "export" (no WMS there): one image per tile. */
    var ZonesLayer = L.TileLayer.extend({
      getTileUrl: function (coords) {
        var b = mercatorTileBbox(coords.x, coords.y, coords.z).map(function (v) { return v.toFixed(2); });
        return ZONES_EXPORT + '?bbox=' + b.join(',') + '&bboxSR=3857&imageSR=3857&size=256,256' +
          '&format=png32&transparent=true&layers=show:5,6&f=image';
      }
    });

    /**
     * NOAA CoastWatch current arrows: each Mercator tile asks ERDDAP for its lon/lat box.
     * 512 px tiles with zoomOffset -1 cover the same area as 4 normal tiles, so the slow
     * server gets about 4 times fewer requests.
     */
    var WorldCurrentsLayer = L.TileLayer.extend({
      getTileUrl: function (coords) {
        var z = coords.z + (this.options.zoomOffset || 0);
        return erddapCurrentsUrl(coords.x, coords.y, z, this.options.tileSize) || BLANK_TILE;
      }
    });

    function oceanNote(key, text) { $(key + '-note').textContent = text; }
    function oceanTime(key, text) { $('time-' + key).textContent = text; }

    function removeOceanLayers(o) {
      o.layers.forEach(function (l) { if (state.map.hasLayer(l)) state.map.removeLayer(l); });
      o.layers = [];
    }

    /** Add a tile layer for an ocean entry; warn once if a batch of tiles all fail. */
    function addOceanLayer(key, gen, layer) {
      var o = ocean[key];
      var errors = 0, loads = 0;
      layer.on('loading', function () { errors = 0; loads = 0; });
      layer.on('tileload', function () { loads++; });
      layer.on('tileerror', function () {
        errors++;
        if (errors === 3 && loads === 0 && gen === o.gen) oceanNote(key, OCEAN_TILE_FAIL[key]);
      });
      // Small batches (1-2 tiles) never reach 3 errors: check again when the batch is done.
      layer.on('load', function () {
        if (errors > 0 && loads === 0 && gen === o.gen && o.on) oceanNote(key, OCEAN_TILE_FAIL[key]);
      });
      layer.addTo(state.map);
      o.layers.push(layer);
    }

    function oceanProblem(key) {
      var o = ocean[key];
      oceanNote(key, (navigator.onLine ? OCEAN_FAIL[key] : OFFLINE_MSG) + lastUpdatedText(o.lastGood));
      oceanTime(key, o.lastGood ? formatLocalTime(o.lastGood) + ' (old)' : 'Not loaded');
    }

    function oceanOn(key) {
      var o = ocean[key];
      o.on = true;
      setToggle('toggle-' + key, true);
      var gen = ++o.gen;
      oceanNote(key, '');
      if (!navigator.onLine) { oceanProblem(key); return; }
      try {
        OCEAN_START[key](gen);
      } catch (e) {
        if (gen === o.gen) oceanProblem(key);
      }
    }

    function oceanOff(key) {
      var o = ocean[key];
      o.on = false;
      o.gen++;
      removeOceanLayers(o);
      setToggle('toggle-' + key, false);
      oceanTime(key, 'Off');
      oceanNote(key, '');
    }

    /** Model run time (REFERENCE_TIME) of a layer, or null. */
    function modelRun(xml, layerName, nowMs) {
      var ref = parseWmsDimension(xml, layerName, 'REFERENCE_TIME');
      return pickWmsTime(ref.listed, nowMs) || ref.def || null;
    }

    function startCurrents(gen) {
      var o = ocean.currents;
      oceanTime('currents', 'Loading…');
      var now = Date.now();
      // Offshore: NWS/NCEP Global RTOFS, east + west in one request (they share one time list).
      var sea = getCaps(wsCapsUrl(RTOFS_WS)).then(function (xml) {
        var times = intersect(parseWmsDimension(xml, RTOFS_EAST).listed, parseWmsDimension(xml, RTOFS_WEST).listed);
        var t = pickWmsTime(times, now);
        if (!t) throw new Error('no time');
        return { time: t, run: modelRun(xml, RTOFS_EAST, now), layers: RTOFS_WS + ':' + RTOFS_EAST + ',' + RTOFS_WS + ':' + RTOFS_WEST };
      }).catch(function () { return null; });
      // Great Lakes: NOS operational forecast systems (hourly). One request for all lakes that
      // share the picked time.
      var lakes = Promise.all(LAKE_WS.map(function (ws) {
        return getCaps(wsCapsUrl(ws)).then(function (xml) {
          var name = ws + '_sfc_currents';
          return { ws: ws, name: name, times: parseWmsDimension(xml, name).listed, run: modelRun(xml, name, now) };
        }).catch(function () { return null; });
      })).then(function (list) {
        list = list.filter(function (x) { return x && x.times.length; });
        if (!list.length) return null;
        var common = list.reduce(function (acc, x) { return intersect(acc, x.times); }, list[0].times);
        var t = pickWmsTime(common, now);
        if (!t) {
          t = pickWmsTime(list[0].times, now);
          list = list.filter(function (x) { return x.times.indexOf(t) !== -1; });
        }
        if (!t || !list.length) return null;
        return {
          time: t,
          run: list[0].run,
          layers: list.map(function (x) { return x.ws + ':' + x.name; }).join(',')
        };
      }).catch(function () { return null; });

      Promise.all([sea, lakes]).then(function (r) {
        if (gen !== o.gen) return;
        var s = r[0], gl = r[1];
        if (!s && !gl) { oceanProblem('currents'); return; }
        removeOceanLayers(o);
        var op = opacity('opacity-currents');
        if (s) addOceanLayer('currents', gen, oceanWms(NOWCOAST_WMS, s.layers, s.time, op, NOWCOAST_OCEAN_ATTRIBUTION, { bounds: RTOFS_BOUNDS, zIndex: 2 }));
        if (gl) addOceanLayer('currents', gen, oceanWms(NOWCOAST_WMS, gl.layers, gl.time, op, NOWCOAST_OCEAN_ATTRIBUTION, { bounds: LAKES_BOUNDS, zIndex: 2 }));
        var main = s || gl;
        o.lastGood = new Date(main.time);
        if (s && gl && gl.time !== s.time) {
          // Ocean and Great Lakes use different model times: show both so the line matches what is on screen.
          oceanTime('currents', 'Ocean model time ' + formatLocalTime(s.time) +
            ' · Great Lakes model time ' + formatLocalTime(gl.time));
        } else {
          oceanTime('currents', (s ? 'Model time ' : 'Great Lakes model time ') + formatLocalTime(main.time) +
            (main.run ? ' (model run ' + formatLocalTime(main.run) + ')' : ''));
        }
        var note = 'Covers U.S. coasts, nearby ocean and the Great Lakes.';
        if (!s) note = 'Only Great Lakes currents loaded. Ocean currents could not load right now.';
        if (!gl) note += ' Great Lakes currents could not load right now.';
        oceanNote('currents', note);
      }).catch(function () {
        if (gen === o.gen) oceanProblem('currents');
      });
    }

    function startSst(gen) {
      var o = ocean.sst;
      oceanTime('sst', 'Loading…');
      getCaps(wsCapsUrl(SST_WS)).then(function (xml) {
        if (gen !== o.gen) return;
        var t = pickWmsTime(parseWmsDimension(xml, SST_NAME).listed, Date.now());
        if (!t) throw new Error('no time');
        removeOceanLayers(o);
        addOceanLayer('sst', gen, oceanWms(NOWCOAST_WMS, SST_WS + ':' + SST_NAME, t, opacity('opacity-sst'),
          NOWCOAST_OCEAN_ATTRIBUTION, { zIndex: 1 }));
        o.lastGood = new Date(t);
        oceanTime('sst', formatLocalTime(t) + ' (7-day satellite mix)');
      }).catch(function () {
        if (gen === o.gen) oceanProblem('sst');
      });
    }

    function startDepth(gen) {
      // Static chart data: no time list to read.
      removeOceanLayers(ocean.depth);
      addOceanLayer('depth', gen, oceanWms(ENC_WMS, '2', null, opacity('opacity-depth'), ENC_ATTRIBUTION, { zIndex: 3 }));
      oceanTime('depth', 'NOAA ENC charts (updated weekly)');
      oceanNote('depth', 'Covers U.S. coasts and the Great Lakes.');
    }

    function startZones(gen) {
      removeOceanLayers(ocean.marinezones);
      addOceanLayer('marinezones', gen, new ZonesLayer('', {
        tileSize: 256, maxZoom: 19, pane: 'oceanlines', opacity: opacity('opacity-marinezones'),
        updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 0, attribution: MARINE_ZONES_ATTRIBUTION
      }));
      oceanTime('marinezones', 'NWS marine zone map');
      oceanNote('marinezones', 'Covers U.S. coastal and offshore waters.');
    }

    var WORLD_CURRENTS_NOTE = 'Covers oceans worldwide. Arrows can take a few seconds to load.';

    /** World currents note: "Zoom in" below minZoom, "Loading…" while tiles load. */
    function worldCurrentsNote(loading) {
      var o = ocean.worldcurrents;
      if (!o.on) return;
      if (state.map.getZoom() < WORLD_CURRENTS_MIN_ZOOM) { oceanNote('worldcurrents', 'Zoom in to see world currents.'); return; }
      oceanNote('worldcurrents', loading ? 'Loading current arrows… (this can take a few seconds)' : WORLD_CURRENTS_NOTE);
    }

    function startWorldCurrents(gen) {
      // No time list to read: the browser cannot read ERDDAP's time CSV (no CORS header), and the
      // image request asks for the newest day with "(last)".
      var o = ocean.worldcurrents;
      removeOceanLayers(o);
      var layer = new WorldCurrentsLayer('', {
        tileSize: 512, zoomOffset: -1,
        minZoom: WORLD_CURRENTS_MIN_ZOOM, maxNativeZoom: WORLD_CURRENTS_NATIVE_MAX, maxZoom: 19,
        pane: 'oceanlines', opacity: opacity('opacity-worldcurrents'), zIndex: 1,
        updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 0, attribution: COASTWATCH_ATTRIBUTION
      });
      // Registered before addOceanLayer's handlers, so its "not loading" warning (all tiles of a
      // batch failed) still wins over the normal note when a batch finishes.
      layer.on('loading', function () { if (gen === o.gen) worldCurrentsNote(true); });
      layer.on('load', function () { if (gen === o.gen) worldCurrentsNote(false); });
      addOceanLayer('worldcurrents', gen, layer);
      o.lastGood = new Date();
      oceanTime('worldcurrents', 'Newest daily map (NOAA CoastWatch, about 1 to 2 days old)');
      worldCurrentsNote(false);
    }

    function startWorldDepth(gen) {
      // GEBCO grid: does not change, so there is no time list.
      removeOceanLayers(ocean.worlddepth);
      addOceanLayer('worlddepth', gen, oceanWms(GEBCO_WMS, GEBCO_LAYER, null, opacity('opacity-worlddepth'), GEBCO_ATTRIBUTION, { zIndex: 0 }));
      oceanTime('worlddepth', 'GEBCO 2024 world sea floor map (does not change)');
      oceanNote('worlddepth', 'Covers the whole world. Near U.S. coasts, Depth lines have more detail.');
    }

    var OCEAN_START = { currents: startCurrents, sst: startSst, depth: startDepth, marinezones: startZones,
      worldcurrents: startWorldCurrents, worlddepth: startWorldDepth };

    function anyOceanOn() {
      return OCEAN_KEYS.some(function (k) { return ocean[k].on; });
    }

    // ----- Wiring -----
    function bindOpacity(id, apply) {
      var input = $(id);
      var out = $(id + '-val');
      var update = function () {
        var txt = input.value + '%';
        out.textContent = txt;
        input.setAttribute('aria-valuetext', txt + ' visible');
        apply();
      };
      input.addEventListener('input', update);
      update();
    }

    function init() {
      $('toggle-radar').addEventListener('click', function () { if (radar.on) radarOff(); else radarOn(); });
      $('toggle-satellite').addEventListener('click', function () { if (sat.on) satOff(); else satOn(); });
      $('toggle-alerts').addEventListener('click', function () { if (alerts.on) alertsOff(); else alertsOn(); });
      $('btn-alerts-refresh').addEventListener('click', fetchAlerts);
      $('alerts-state').addEventListener('change', function (e) {
        alerts.wholeState = e.target.checked;
        fetchAlerts();
      });
      $('btn-radar-play').addEventListener('click', toggleLoopByUser);
      $('btn-map-loop').addEventListener('click', toggleLoopByUser);
      $('btn-alert-more').addEventListener('click', function () {
        var d = $('alert-description');
        d.hidden = !d.hidden;
        this.textContent = d.hidden ? 'More' : 'Less';
        this.setAttribute('aria-expanded', d.hidden ? 'false' : 'true');
      });
      Array.prototype.forEach.call(document.querySelectorAll('input[name="sat-kind"]'), function (r) {
        if (r.checked) sat.kind = r.value; // the browser may restore a choice on reload
        r.addEventListener('change', function () {
          if (!r.checked) return;
          sat.kind = r.value;
          if (sat.on) satOn();
        });
      });
      bindOpacity('opacity-radar', function () {
        if (radar.playing) showFrame(radar.idx);
        else if (radar.layer && state.map.hasLayer(radar.layer)) radar.layer.setOpacity(radarOpacity());
        var last = radar.frameLayers[radar.frameLayers.length - 1];
        if (!radar.playing && last) last.setOpacity(radarOpacity());
      });
      bindOpacity('opacity-satellite', function () { if (sat.layer) sat.layer.setOpacity(opacity('opacity-satellite')); });
      bindOpacity('opacity-alerts', applyAlertOpacity);

      Array.prototype.forEach.call(document.querySelectorAll('input[name="radar-area"]'), function (r) {
        if (r.checked) radar.area = r.value;
        r.addEventListener('change', function () {
          if (!r.checked) return;
          radar.area = r.value;
          if (radar.on) radarOn();
        });
      });

      $('toggle-gdacs').addEventListener('click', function () { if (gdacs.on) gdacsOff(); else gdacsOn(); });
      $('btn-gdacs-refresh').addEventListener('click', fetchGdacs);
      bindOpacity('opacity-gdacs', applyGdacsOpacity);

      state.map.on('moveend', function () {
        onMapMoveForRadar();
        onMapMoveForGdacs();
      });
      state.map.on('zoomend', function () { worldCurrentsNote(false); });

      OCEAN_KEYS.forEach(function (key) {
        $('toggle-' + key).addEventListener('click', function () { if (ocean[key].on) oceanOff(key); else oceanOn(key); });
        bindOpacity('opacity-' + key, function () {
          var op = opacity('opacity-' + key);
          ocean[key].layers.forEach(function (l) { l.setOpacity(op); });
        });
      });

      // 1.4.2: closing Weather only hides the sheet. The radar overlay and its loop keep running on the map.
      sheetCloseHooks['sheet-weather'] = function () { $('btn-weather').classList.toggle('is-on', radar.on || sat.on || alerts.on || gdacs.on || anyOceanOn()); };
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          // Save battery while the app is in the background; wantLoop stays set so it resumes.
          var keep = radar.wantLoop;
          stopLoop();
          radar.wantLoop = keep;
          clearInterval(alerts.timer);
          alerts.timer = null;
        } else {
          if (radar.wantLoop && !radar.playing) startLoop();
          if (alerts.on) {
            if (Date.now() - alerts.lastFetch > ALERT_REFRESH_MS) fetchAlerts();
            scheduleAlerts();
          }
        }
      });
    }

    function onOnline() {
      if (radar.on && !radar.layer) radarOn();
      if (sat.on && !sat.layer) satOn();
      if (alerts.on) fetchAlerts();
      if (gdacs.on && !gdacs.features.length) fetchGdacs();
      OCEAN_KEYS.forEach(function (k) { if (ocean[k].on && !ocean[k].layers.length) oceanOn(k); });
    }

    return {
      init: init,
      onOnline: onOnline,
      gdacsEvent: gdacsEvent,
      GDACS_API: GDACS_API,
      ALERTS_API: ALERTS_API,
      alertFeatures: alertFeatures,
      openAlert: openAlert,
      state: { radar: radar, sat: sat, alerts: alerts, gdacs: gdacs, ocean: ocean },
      nationalRadars: NATIONAL_RADARS,
      radarWant: radarWant
    };
  })();

  ReadyMap.weather.state = Weather.state;
  ReadyMap.weather.nationalRadars = Weather.nationalRadars;
  ReadyMap.weather.radarWant = Weather.radarWant;

  // ---------------------------------------------------------------------------
  // 14b. Weather news (official headlines for the map area)
  // ---------------------------------------------------------------------------
  // Each feed is fetched on its own; one failing only shows a short line in its group.
  // Feed text only ever goes on the page with textContent. Nothing here is cached by the SW.
  var News = (function () {
    var NWS = 'https://api.weather.gov';
    var RSS_URL = 'https://www.weather.gov/rss_page.php?site_name=nws';
    var LD = 'application/ld+json';
    var STALE_MS = 10 * 60 * 1000;
    var NEWS_MOVED_M = 5000; // map center moved this far since the last load: load news for the new area
    var HOUR = 3600 * 1000;
    var GROUPS = [
      { key: 'local', title: 'Your area' },
      { key: 'tropical', title: 'Tropical storms' },
      { key: 'us', title: 'United States' },
      { key: 'world', title: 'World' }
    ];
    var TROPICAL_OFFICES = {
      KNHC: { name: 'National Hurricane Center', link: 'https://www.nhc.noaa.gov/' },
      PHFO: { name: 'Central Pacific Hurricane Center', link: 'https://www.nhc.noaa.gov/?cpac' },
      PGUM: { name: 'NWS Guam', link: 'https://www.weather.gov/gum/' }
    };
    // WMO headings of the English outlooks. KNHC also sends Spanish copies (ACCA62, ABPZ21): skipped.
    var TWO_AREAS = { ABNT20: 'Atlantic', ABPZ20: 'Eastern Pacific', ACPN50: 'Central Pacific' };
    var news = { gen: 0, lastLoad: 0, pointCache: {}, officeNames: {}, textCache: {} };

    function newsFetch(url, accept, signal, ms) {
      return fetchWithTimeout(url, { headers: { Accept: accept || LD }, credentials: 'omit' }, ms || FETCH_TIMEOUT_MS, signal);
    }
    function getJson(url, accept, signal, ms) {
      return newsFetch(url, accept, signal, ms).then(function (res) {
        if (!res.ok) { var err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
        return res.json();
      });
    }
    /** One retry after 2 s for a server hiccup (api.weather.gov sometimes answers 500/503). */
    function getJsonRetry(url, accept, signal) {
      return getJson(url, accept, signal).catch(function (e) {
        if (!(e && e.status >= 500)) throw e;
        return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return getJson(url, accept, signal); });
      });
    }
    function graph(json) { return json && Array.isArray(json['@graph']) ? json['@graph'] : []; }
    function safeId(id) { return typeof id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(id) ? id : null; }
    function date(s) { var d = new Date(s); return isNaN(d) ? null : d; }
    function within(d, ms) { return d && Date.now() - d.getTime() <= ms; }

    /** Newest product per group key (input is newest-first, but sort anyway). */
    function newestBy(list, keyFn) {
      var seen = {};
      list.slice().sort(function (a, b) { return Date.parse(b.issuanceTime) - Date.parse(a.issuanceTime); })
        .forEach(function (p) { var k = keyFn(p); if (!seen[k]) seen[k] = p; });
      return Object.keys(seen).map(function (k) { return seen[k]; });
    }

    function productText(id, signal) {
      if (news.textCache[id]) return Promise.resolve(news.textCache[id]);
      return getJson(NWS + '/products/' + id, LD, signal).then(function (j) {
        var t = j && typeof j.productText === 'string' ? j.productText : '';
        if (t) news.textCache[id] = t;
        return t;
      });
    }

    // ----- feeds: each resolves to { items: [...] } or { message: '...' } -----
    function lookupPoint(c, signal) {
      var key = c.lat.toFixed(2) + ',' + c.lng.toFixed(2);
      if (news.pointCache[key]) return Promise.resolve(news.pointCache[key]);
      return getJsonRetry(NWS + '/points/' + c.lat.toFixed(4) + ',' + c.lng.toFixed(4), 'application/geo+json', signal)
        .then(function (j) {
          var p = (j && j.properties) || j || {};
          var cwa = typeof p.cwa === 'string' && /^[A-Z]{3}$/.test(p.cwa) ? p.cwa : null;
          if (!cwa) throw new Error('no office');
          var rl = p.relativeLocation && p.relativeLocation.properties;
          var place = rl && rl.city ? String(rl.city).slice(0, 80) + (rl.state ? ', ' + String(rl.state).slice(0, 4) : '') : '';
          var out = { cwa: cwa, place: place };
          news.pointCache[key] = out;
          return out;
        });
    }

    function officeLabel(cwa) { return 'NWS ' + (news.officeNames[cwa] || cwa); }

    function loadLocal(c, signal) {
      return lookupPoint(c, signal).then(function (pt) {
        var codes = [
          { code: 'AFD', maxAge: 72 * HOUR },
          { code: 'HWO', maxAge: 36 * HOUR },
          { code: 'SPS', maxAge: 24 * HOUR }
        ];
        return Promise.all(codes.map(function (k) {
          return getJson(NWS + '/products/types/' + k.code + '/locations/' + pt.cwa, LD, signal).then(function (j) {
            var p = graph(j)[0];
            var d = p && date(p.issuanceTime);
            var id = p && safeId(p.id);
            if (!id || !within(d, k.maxAge)) return null;
            return {
              title: String(p.productName || k.code).slice(0, 200),
              time: d, id: id,
              link: 'https://forecast.weather.gov/product.php?site=' + pt.cwa + '&issuedby=' + pt.cwa + '&product=' + k.code
            };
          }).catch(function () { return null; });
        })).then(function (items) {
          items = items.filter(Boolean);
          // The office's full name ("Denver/Boulder CO") is in the product text.
          var first = items[0];
          var named = news.officeNames[pt.cwa] || !first ? Promise.resolve() : productText(first.id, signal).then(function (t) {
            var m = /^\s*National Weather Service (.{2,60}?)\s*$/m.exec(t || '');
            if (m) news.officeNames[pt.cwa] = m[1];
          }).catch(function () {});
          return named.then(function () {
            items.forEach(function (it) { it.source = officeLabel(pt.cwa); });
            return {
              items: items,
              place: pt.place,
              message: items.length ? '' : 'No new products from ' + officeLabel(pt.cwa) + ' right now.'
            };
          });
        });
      }, function (e) {
        if (e && e.status === 404) return { message: 'Local office news is for the U.S. only. The map center is outside the U.S.' };
        throw e;
      });
    }

    function tropicalSource(office) {
      var o = TROPICAL_OFFICES[office];
      return o ? o.name : 'NWS ' + office;
    }
    function tropicalLink(office) {
      var o = TROPICAL_OFFICES[office];
      return o ? o.link : 'https://www.nhc.noaa.gov/';
    }

    function loadTropical(signal) {
      var two = getJson(NWS + '/products/types/TWO', LD, signal).then(function (j) {
        var list = graph(j).filter(function (p) {
          if (p.issuingOffice === 'KNHC' && !TWO_AREAS[p.wmoCollectiveId]) return false;
          return within(date(p.issuanceTime), 48 * HOUR) && safeId(p.id);
        });
        return newestBy(list, function (p) { return p.issuingOffice + '/' + String(p.wmoCollectiveId || ''); })
          .map(function (p) {
            var office = String(p.issuingOffice || '');
            var area = TWO_AREAS[String(p.wmoCollectiveId || '')];
            return {
              title: 'Tropical Weather Outlook' + (area ? ' (' + area + ')' : ''),
              time: date(p.issuanceTime), id: safeId(p.id),
              source: tropicalSource(office), link: tropicalLink(office)
            };
          });
      });
      var tcp = getJson(NWS + '/products/types/TCP', LD, signal).then(function (j) {
        var list = graph(j).filter(function (p) { return within(date(p.issuanceTime), 24 * HOUR) && safeId(p.id); });
        var items = newestBy(list, function (p) { return p.issuingOffice + '/' + (p.wmoCollectiveId || p.id); }).slice(0, 6)
          .map(function (p) {
            var office = String(p.issuingOffice || '');
            return {
              title: String(p.productName || 'Tropical Cyclone Public Advisory').slice(0, 200),
              time: date(p.issuanceTime), id: safeId(p.id),
              source: tropicalSource(office), link: tropicalLink(office)
            };
          });
        // Put the storm name in the title ("Hurricane Melissa Advisory Number 30") when we can.
        return Promise.all(items.map(function (it) {
          return productText(it.id, signal).then(function (t) {
            var m = /^\s*([A-Za-z][A-Za-z .'-]{2,60} (Intermediate )?Advisory Number\s+\S+)\s*$/mi.exec(t || '');
            if (m) it.title = m[1].replace(/\s+/g, ' ');
          }).catch(function () {});
        })).then(function () { return items; });
      });
      return Promise.all([
        two.catch(function () { return null; }),
        tcp.catch(function () { return null; })
      ]).then(function (r) {
        if (!r[0] && !r[1]) throw new Error('tropical failed');
        var items = (r[1] || []).concat(r[0] || []);
        return { items: items, message: items.length ? (r[1] && r[1].length ? '' : 'No active tropical storm advisories right now.') : 'No tropical storm news right now.' };
      });
    }

    /** Decode the feed with its own charset (the NWS feed is ISO-8859-1). */
    function readText(res) {
      if (!res.arrayBuffer || typeof TextDecoder === 'undefined') return res.text();
      var ct = (res.headers && res.headers.get('content-type')) || '';
      return res.arrayBuffer().then(function (buf) {
        var label = (/charset=["']?([\w-]+)/i.exec(ct) || [])[1];
        if (!label) {
          var head = new TextDecoder('iso-8859-1').decode(new Uint8Array(buf, 0, Math.min(200, buf.byteLength)));
          label = (/encoding=["']([\w-]+)["']/i.exec(head) || [])[1] || 'utf-8';
        }
        try { return new TextDecoder(label).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
      });
    }

    function loadUs(signal) {
      return newsFetch(RSS_URL, 'application/rss+xml, application/xml, text/xml', signal).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return readText(res);
      }).then(function (xml) {
        var items = parseRssItems(xml).slice(0, 6).map(function (it) {
          return { title: it.title || 'NWS news', link: it.link, time: date(it.pubDate), source: 'NWS national' };
        });
        return { items: items, message: items.length ? '' : 'No national headlines right now.' };
      });
    }

    function loadWorld(c, signal) {
      return getJson(Weather.GDACS_API, 'application/json', signal, 25000).then(function (json) {
        var list = (json && Array.isArray(json.features) ? json.features : []).map(Weather.gdacsEvent).filter(Boolean);
        list.forEach(function (e) { e.dist = distanceMeters(c.lat, c.lng, e.lat, e.lon); });
        var pick = list.filter(function (e) { return e.level === 'Red' || e.level === 'Orange'; });
        list.slice().sort(function (a, b) { return a.dist - b.dist; }).slice(0, 3).forEach(function (e) {
          if (pick.indexOf(e) < 0) pick.push(e);
        });
        var items = pick.slice(0, 12).map(function (e) {
          return {
            title: e.name,
            sub: e.type + ' · ' + e.level + ' alert · ' + Math.round(e.dist / 1609.344).toLocaleString() + ' mi (' +
              Math.round(e.dist / 1000).toLocaleString() + ' km) from the map center',
            time: e.modified || e.from, link: e.report, source: 'GDACS'
          };
        });
        return { items: items, message: items.length ? '' : 'No world disaster alerts right now.' };
      });
    }

    // ----- rendering -----
    function sortNewest(items) {
      return items.slice().sort(function (a, b) { return (b.time ? b.time.getTime() : 0) - (a.time ? a.time.getTime() : 0); });
    }

    function readButton(it) {
      var box = el('pre', { className: 'pre news-text', hidden: '' });
      var boxId = 'news-text-' + it.id;
      box.id = boxId;
      var btn = el('button', { type: 'button', className: 'btn btn-small', text: 'Read', 'aria-expanded': 'false', 'aria-controls': boxId });
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        if (open) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Read'; return; }
        box.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = 'Hide';
        if (box.getAttribute('data-loaded')) return;
        box.textContent = 'Loading…';
        productText(it.id).then(function (t) {
          var lines = String(t || '').replace(/\r/g, '').split('\n');
          while (lines.length && !lines[0].trim()) lines.shift();
          box.textContent = lines.slice(0, 25).join('\n').trim() + (lines.length > 25 ? '\n…' : '') || 'No text.';
          box.setAttribute('data-loaded', '1');
        }).catch(function () {
          box.textContent = 'Could not load the text. Use the link above to read it.';
        });
      });
      return [btn, box];
    }

    function renderItem(it) {
      var head = it.link
        ? el('a', { className: 'news-title', href: it.link, target: '_blank', rel: 'noopener noreferrer', text: it.title })
        : el('span', { className: 'news-title', text: it.title });
      var when = it.time ? formatLocalTime(it.time) + ' (' + timeAgo(it.time) + ')' : 'Time not given';
      var kids = [
        el('div', null, [head]),
        it.sub ? el('div', { className: 'news-sub', text: it.sub }) : null,
        el('div', { className: 'alert-item-meta', text: it.source + ' · ' + when })
      ];
      if (it.id) kids = kids.concat(readButton(it));
      return el('li', { className: 'news-item' }, kids);
    }

    function renderGroup(g, result) {
      var sec = $('news-group-' + g.key);
      clear(sec);
      sec.appendChild(el('h3', { text: g.title }));
      if (result.loading) { sec.appendChild(el('p', { className: 'hint', text: 'Loading…' })); return; }
      if (result.error) { sec.appendChild(el('p', { className: 'hint', text: result.error })); return; }
      var items = sortNewest(result.items || []);
      if (items.length) sec.appendChild(el('ul', { className: 'alert-list news-items' }, items.map(renderItem)));
      if (result.message) sec.appendChild(el('p', { className: 'hint', text: result.message }));
    }

    function ensureGroups() {
      var list = $('news-list');
      if (list.childElementCount) return;
      GROUPS.forEach(function (g) {
        list.appendChild(el('section', { id: 'news-group-' + g.key, className: 'news-group', 'aria-label': g.title }));
      });
    }

    var FAIL = {
      local: 'Could not get news from your local weather office right now.',
      tropical: 'Could not get tropical storm news right now.',
      us: 'Could not get national weather news right now.',
      world: 'Could not get world disaster alerts right now.'
    };

    function load() {
      var status = $('news-status');
      ensureGroups();
      if (!navigator.onLine) {
        status.textContent = 'Weather news needs internet. Try again when you have signal.' +
          (news.lastLoad ? ' Showing news from ' + formatLocalTime(new Date(news.lastLoad)) + '.' : '');
        return;
      }
      var gen = ++news.gen;
      if (news.ctrl) news.ctrl.abort();
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      news.ctrl = ctrl;
      var signal = ctrl && ctrl.signal;
      var c = state.map ? state.map.getCenter().wrap() : { lat: 39.8, lng: -98.6 };
      status.textContent = 'Loading weather news…';
      $('news-refresh').disabled = true;
      var jobs = {
        local: function () { return loadLocal(c, signal); },
        tropical: function () { return loadTropical(signal); },
        us: function () { return loadUs(signal); },
        world: function () { return loadWorld(c, signal); }
      };
      var place = '';
      Promise.all(GROUPS.map(function (g) {
        renderGroup(g, { loading: true });
        var p;
        try { p = Promise.resolve(jobs[g.key]()); } catch (e) { p = Promise.reject(e); }
        return p.then(function (r) {
          if (gen !== news.gen) return false;
          if (r && r.place) place = r.place;
          renderGroup(g, r || {});
          return true;
        }, function () {
          if (gen !== news.gen) return false;
          renderGroup(g, { error: FAIL[g.key] + (navigator.onLine ? ' Tap Refresh to try again.' : '') });
          return false;
        });
      })).then(function (ok) {
        if (gen !== news.gen) return;
        $('news-refresh').disabled = false;
        news.lastLoad = Date.now();
        news.center = { lat: c.lat, lng: c.lng };
        var good = ok.filter(Boolean).length;
        status.textContent = good
          ? 'Updated ' + formatLocalTime(new Date()) + '. News for the map center' + (place ? ' (near ' + place + ')' : '') + '.'
          : 'Could not get weather news right now. Tap Refresh to try again.';
      });
    }

    function open(opener) {
      openSheet('sheet-news', opener);
      var moved = false;
      if (news.center && state.map) {
        var c = state.map.getCenter().wrap();
        moved = distanceMeters(news.center.lat, news.center.lng, c.lat, c.lng) > NEWS_MOVED_M;
      }
      if (!news.lastLoad || moved || Date.now() - news.lastLoad > STALE_MS) load();
    }

    function init() {
      $('btn-news').addEventListener('click', function () {
        // The news panel replaces the Weather sheet; focus returns to the Weather button.
        open($('btn-weather'));
      });
      $('news-refresh').addEventListener('click', load);
    }

    return { init: init, load: load, state: news };
  })();
  ReadyMap.news = { state: News.state };

  // ---------------------------------------------------------------------------
  // 14c. Local weather card (one point: GPS, else the selected spot, else the map center)
  // ---------------------------------------------------------------------------
  // U.S.: api.weather.gov (points -> forecast, hourly, nearest station, alerts). Elsewhere, or when
  // points says 404: Open-Meteo. Results live only in memory (never in the SW cache), keyed by the
  // point rounded to 2 decimals. A result is reused for any point within 2 km; nothing is fetched
  // again for the same area within 5 minutes. All feed text goes on the page with textContent.
  var LocalWx = (function () {
    var NWS = 'https://api.weather.gov';
    var NWS_RE = /^https:\/\/api\.weather\.gov\//;
    var GEO = 'application/geo+json';
    var OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
    var MIN_GAP_MS = 5 * 60 * 1000;
    var REFRESH_MS = 15 * 60 * 1000;
    var TICK_MS = 60 * 1000;
    var SAME_AREA_M = 2000;
    var OBS_OLD_MS = 2 * 3600 * 1000;
    var GDACS_NEAR_M = 300000;
    var lw = { opened: false, cache: {}, attempts: {}, points: {}, last: null, gen: 0, ctrl: null, busy: false, timer: null,
      gdacs: null, gdacsFlight: null, flight: null, listeners: [], forced: null };

    function keyOf(pt) { return pt.lat.toFixed(2) + ',' + pt.lon.toFixed(2); }

    /** The card's point. "Full forecast" in This spot pins the card to that spot while it is open. */
    function pickPoint() {
      if (lw.forced && !$('sheet-localwx').hidden) return lw.forced;
      return basePoint();
    }

    /** GPS fix first; with no fix, the tapped/selected spot; with neither, the map center. */
    function basePoint() {
      if (state.userFix) return { lat: state.userFix.lat, lon: state.userFix.lon, kind: 'Your location' };
      var s = state.selected;
      if (s && s.source !== 'user') return { lat: s.lat, lon: s.lon, kind: 'Map point' };
      var c = state.map ? state.map.getCenter().wrap() : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
      return { lat: c.lat, lon: c.lng, kind: 'Map point', center: true };
    }

    /** Freshest saved result within 2 km of pt, or null. */
    function nearResult(pt) {
      var best = null;
      Object.keys(lw.cache).forEach(function (k) {
        var r = lw.cache[k];
        if (distanceMeters(r.lat, r.lon, pt.lat, pt.lon) > SAME_AREA_M) return;
        if (!best || r.fetchedAt > best.fetchedAt) best = r;
      });
      return best;
    }

    /** Most recent request start within 2 km of pt (success or not), or null. */
    function nearAttempt(pt) {
      var best = null;
      Object.keys(lw.attempts).forEach(function (k) {
        var a = lw.attempts[k];
        if (distanceMeters(a.lat, a.lon, pt.lat, pt.lon) > SAME_AREA_M) return;
        if (!best || a.at > best.at) best = a;
      });
      return best;
    }

    // ----- fetch helpers (only Accept is ever sent; browsers do not allow setting User-Agent) -----
    function getJson(url, accept, signal) {
      var opts = { credentials: 'omit' };
      if (accept) opts.headers = { Accept: accept };
      return fetchWithTimeout(url, opts, FETCH_TIMEOUT_MS, signal).then(function (res) {
        if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
        return res.json();
      });
    }
    /** One retry after 2 s when the server has a hiccup (500/503). */
    function getJsonRetry(url, accept, signal) {
      return getJson(url, accept, signal).catch(function (e) {
        if (!(e && e.status >= 500)) throw e;
        return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return getJson(url, accept, signal); });
      });
    }
    function num(v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v); }
    function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 120) : ''; }
    /** A WMO/NWS quantity {unitCode, value} as mph. */
    function qMph(q) {
      var v = q && num(q.value);
      if (v === null) return null;
      var u = String(q.unitCode || '');
      if (/m_s-1/.test(u)) return v * 2.236936;
      if (/km_h-1/.test(u)) return v / 1.609344;
      if (/kn|kt/.test(u)) return v * 1.150779;
      return v / 1.609344; // api.weather.gov default is km/h
    }
    function qTempF(q) {
      var v = q && num(q.value);
      if (v === null) return null;
      return /degF/.test(String(q.unitCode || '')) ? v : cToF(v);
    }
    function periodTempF(p) {
      var t = num(p && p.temperature);
      if (t === null) return null;
      return p.temperatureUnit === 'C' ? cToF(t) : t;
    }
    function periodPop(p) { return p && p.probabilityOfPrecipitation ? num(p.probabilityOfPrecipitation.value) : null; }

    // ----- U.S. (National Weather Service) -----
    function nwsPoint(pt, signal) {
      var key = keyOf(pt);
      if (lw.points[key]) return Promise.resolve(lw.points[key]);
      return getJsonRetry(NWS + '/points/' + pt.lat.toFixed(4) + ',' + pt.lon.toFixed(4), GEO, signal).then(function (j) {
        var p = (j && j.properties) || {};
        var rl = p.relativeLocation && p.relativeLocation.properties;
        var out = {
          forecast: NWS_RE.test(p.forecast) ? p.forecast : null,
          hourly: NWS_RE.test(p.forecastHourly) ? p.forecastHourly : null,
          stations: NWS_RE.test(p.observationStations) ? p.observationStations : null,
          place: rl && rl.city ? str(rl.city, 80) + (rl.state ? ', ' + str(rl.state, 4) : '') : ''
        };
        lw.points[key] = out;
        return out;
      });
    }

    function nwsHourly(j) {
      var now = Date.now();
      var list = (j && j.properties && Array.isArray(j.properties.periods) ? j.properties.periods : []);
      return list.filter(function (p) { return p && !(Date.parse(p.endTime) <= now); }).slice(0, 24).map(function (p) {
        return {
          time: str(p.startTime, 40), tempF: periodTempF(p), sky: str(p.shortForecast, 80), pop: periodPop(p),
          wind: [str(p.windSpeed, 30), str(p.windDirection, 4)].filter(Boolean).join(' ')
        };
      });
    }

    function nwsDaily(j) {
      var list = (j && j.properties && Array.isArray(j.properties.periods) ? j.properties.periods : []).filter(Boolean);
      var out = [];
      for (var i = 0; i < list.length && out.length < 8; i++) {
        var p = list[i];
        var night = p.isDaytime && list[i + 1] && !list[i + 1].isDaytime ? list[i + 1] : null;
        var pops = [periodPop(p), periodPop(night)].filter(function (v) { return v !== null; });
        out.push({
          name: str(p.name, 30) || 'Day',
          hiF: p.isDaytime ? periodTempF(p) : null,
          loF: p.isDaytime ? periodTempF(night) : periodTempF(p),
          sky: str(p.shortForecast, 80),
          pop: pops.length ? Math.max.apply(null, pops) : null
        });
        if (night) i++;
      }
      return out;
    }

    function nwsNow(pt, stationsUrl, signal) {
      if (!stationsUrl) return Promise.reject(new Error('no stations'));
      return getJsonRetry(stationsUrl + '?limit=1', GEO, signal).then(function (j) {
        var f = j && Array.isArray(j.features) ? j.features[0] : null;
        var sp = (f && f.properties) || {};
        var id = /^[A-Z0-9]{3,6}$/.test(sp.stationIdentifier) ? sp.stationIdentifier : null;
        if (!id) throw new Error('no station');
        return getJsonRetry(NWS + '/stations/' + id + '/observations/latest', GEO, signal).then(function (o) {
          var p = (o && o.properties) || {};
          var tF = qTempF(p.temperature);
          var feels = qTempF(p.heatIndex);
          if (feels === null) feels = qTempF(p.windChill);
          var when = p.timestamp ? new Date(p.timestamp) : null;
          return {
            tempF: tF, feelsF: feels === null ? tF : feels, sky: str(p.textDescription, 80),
            windMph: qMph(p.windSpeed), windDeg: p.windDirection ? num(p.windDirection.value) : null,
            gustMph: qMph(p.windGust), humidity: p.relativeHumidity ? num(p.relativeHumidity.value) : null,
            obsTime: when && !isNaN(when) ? when : null,
            station: id + (sp.name ? ' (' + str(sp.name, 80) + ')' : '')
          };
        });
      });
    }

    function nwsAlerts(pt, signal) {
      return getJsonRetry(Weather.ALERTS_API + '?point=' + pt.lat.toFixed(4) + ',' + pt.lon.toFixed(4), GEO, signal)
        .then(function (j) { return { us: true, features: Weather.alertFeatures(j) }; });
    }

    function loadNws(pt, info, signal) {
      var settle = function (p) { return p.then(function (v) { return v; }, function () { return null; }); };
      return Promise.all([
        settle(info.forecast ? getJsonRetry(info.forecast, GEO, signal).then(nwsDaily) : Promise.reject()),
        settle(info.hourly ? getJsonRetry(info.hourly, GEO, signal).then(nwsHourly) : Promise.reject()),
        settle(nwsNow(pt, info.stations, signal)),
        settle(nwsAlerts(pt, signal))
      ]).then(function (r) {
        var res = { src: 'nws', place: info.place, daily: r[0] || [], hourly: r[1] || [], now: r[2], alerts: r[3] || { us: true, failed: true } };
        if (!res.daily.length && !res.hourly.length) {
          // NWS forecast is down: use Open-Meteo for the forecast, keep NWS warnings and place.
          return loadOpenMeteo(pt, signal).then(function (om) {
            om.place = info.place; om.alerts = res.alerts; om.src = 'mixed';
            if (res.now && res.now.tempF !== null) { om.now = res.now; }
            return om;
          }, function () {
            if (!res.now) throw new Error('nws failed');
            return res;
          });
        }
        var n = res.now;
        if (!n || n.tempF === null) {
          // No station reading: use the first hour of the forecast instead.
          var h = res.hourly[0];
          if (h) res.now = { tempF: h.tempF, feelsF: h.tempF, sky: h.sky, windText: h.wind, humidity: null, fromForecast: true,
            station: n ? n.station : '' };
        }
        return res;
      });
    }

    // ----- Outside the U.S. (Open-Meteo) -----
    function loadOpenMeteo(pt, signal) {
      var url = OPEN_METEO + '?latitude=' + pt.lat.toFixed(4) + '&longitude=' + pt.lon.toFixed(4) +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day' +
        '&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
        '&forecast_days=7&forecast_hours=24&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph';
      var model = OM_BEST, filled = false;
      return countryQuick(pt.lat, pt.lon).then(function (cc) {
        return omFetch(url, pt.lat, pt.lon, cc, function (u) { return getJsonRetry(u, null, signal); });
      }).then(function (got) {
        var j = got.j;
        model = got.model; filled = got.filled;
        var c = (j && j.current) || {};
        var h = (j && j.hourly) || {};
        var d = (j && j.daily) || {};
        var at = function (arr, i) { return Array.isArray(arr) ? arr[i] : null; };
        var hourly = (Array.isArray(h.time) ? h.time : []).slice(0, 24).map(function (t, i) {
          var w = num(at(h.wind_speed_10m, i));
          return { time: str(t, 40), tempF: num(at(h.temperature_2m, i)), sky: wmoCodeText(at(h.weather_code, i)),
            pop: num(at(h.precipitation_probability, i)), wind: w === null ? '' : Math.round(w) + ' mph' };
        });
        var daily = (Array.isArray(d.time) ? d.time : []).slice(0, 7).map(function (t, i) {
          return { date: str(t, 10), name: i === 0 ? 'Today' : dayName(str(t, 10)), hiF: num(at(d.temperature_2m_max, i)),
            loF: num(at(d.temperature_2m_min, i)), sky: wmoCodeText(at(d.weather_code, i)), pop: num(at(d.precipitation_probability_max, i)) };
        });
        if (num(c.temperature_2m) === null && !hourly.length) throw new Error('empty');
        return {
          src: 'om', place: '', hourly: hourly, daily: daily, model: model, modelFilled: filled,
          now: { tempF: num(c.temperature_2m), feelsF: num(c.apparent_temperature), sky: c.weather_code !== undefined ? wmoCodeText(c.weather_code) : '',
            windMph: num(c.wind_speed_10m), windDeg: num(c.wind_direction_10m), gustMph: num(c.wind_gusts_10m),
            humidity: num(c.relative_humidity_2m), localTime: str(c.time, 20) },
          alerts: { us: false }
        };
      });
    }

    function fetchFor(pt, signal) {
      return nwsPoint(pt, signal).then(function (info) { return loadNws(pt, info, signal); }, function (e) {
        if (e && e.name === 'AbortError' && signal && signal.aborted) throw e;
        // 404 = outside the U.S.; any other points failure: Open-Meteo still gives a forecast.
        return loadOpenMeteo(pt, signal);
      });
    }

    // ----- formatting -----
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    function dayName(ymd) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
      return m ? DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : ymd;
    }
    /** Hour from the local part of an ISO time (local to the point): '2026-11-02T15:00-07:00' -> '3 PM'. */
    function hourLabel(iso) {
      var m = /T(\d{2}):(\d{2})/.exec(iso || '');
      if (!m) return '';
      var h = +m[1];
      return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM');
    }
    function tempBoth(f) {
      if (f === null || f === undefined) return '—';
      return Math.round(f) + '°F / ' + Math.round(fToC(f)) + '°C';
    }
    function tempShort(f) { return f === null || f === undefined ? '—' : Math.round(f) + '°F'; }
    function tempShortC(f) { return f === null || f === undefined ? '' : Math.round(fToC(f)) + '°C'; }
    function windText(n) {
      if (n.windText) return n.windText;
      if (n.windMph === null || n.windMph === undefined) return '—';
      var mph = Math.round(n.windMph);
      if (mph === 0) return 'Calm';
      var dir = degToCompass(n.windDeg);
      var s = mph + ' mph' + (dir ? ' from the ' + compassWords(dir) + ' (' + dir + ')' : '');
      if (n.gustMph !== null && n.gustMph !== undefined && Math.round(n.gustMph) > mph) s += ', gusts ' + Math.round(n.gustMph) + ' mph';
      return s;
    }
    function rainText(pop) { return pop === null || pop === undefined ? 'Rain —' : 'Rain ' + Math.round(pop) + '%'; }
    function sourceName(r) {
      return r.src === 'om' ? 'Open-Meteo' : r.src === 'mixed' ? 'National Weather Service and Open-Meteo' : 'National Weather Service';
    }

    // ----- rendering -----
    function status(text) { $('localwx-status').textContent = text || ''; }
    function setStatusText(text) { status(text); }

    function renderPlace(r) {
      var where = r.place || formatDecimal(r.lat, r.lon);
      $('localwx-place').textContent = r.kind + (r.center ? ' (map center)' : '') + ': ' + where;
    }

    function renderNow(r) {
      var box = $('localwx-now');
      clear(box);
      var n = r.now;
      if (!n) { box.appendChild(el('p', { className: 'hint', text: 'Current conditions are not available right now.' })); return; }
      box.appendChild(el('p', { className: 'lw-temp', text: tempBoth(n.tempF) }));
      if (n.sky) box.appendChild(el('p', { className: 'lw-sky', text: n.sky }));
      var dl = el('dl', { className: 'lw-facts' });
      [['Feels like', tempBoth(n.feelsF)], ['Wind', windText(n)],
        ['Humidity', n.humidity === null || n.humidity === undefined ? '—' : Math.round(n.humidity) + '%']].forEach(function (row) {
        dl.appendChild(el('dt', { text: row[0] }));
        dl.appendChild(el('dd', { text: row[1] }));
      });
      box.appendChild(dl);
      if (n.fromForecast) box.appendChild(el('p', { className: 'fine', text: 'No weather station reading right now. This is the forecast for this hour.' }));
      else if (n.obsTime && Date.now() - n.obsTime.getTime() > OBS_OLD_MS) {
        box.appendChild(el('p', { className: 'fine', text: 'This station reading is old (' + timeAgo(n.obsTime) + ').' }));
      }
    }

    function renderHourly(r) {
      var list = $('localwx-hourly');
      clear(list);
      if (!r.hourly.length) { list.appendChild(el('li', { className: 'lw-empty', text: 'Hourly forecast is not available right now.' })); return; }
      r.hourly.forEach(function (h, i) {
        list.appendChild(el('li', { className: 'hour' }, [
          el('span', { className: 'lw-h-time', text: i === 0 ? 'Now' : hourLabel(h.time) }),
          el('span', { className: 'lw-h-temp', text: tempShort(h.tempF) }),
          el('span', { className: 'lw-h-c', text: tempShortC(h.tempF) }),
          el('span', { className: 'lw-h-sky', text: h.sky || '—' }),
          el('span', { className: 'lw-h-rain', text: rainText(h.pop) }),
          el('span', { className: 'lw-h-wind', text: h.wind ? 'Wind ' + h.wind : '' })
        ]));
      });
    }

    function renderDaily(r) {
      var list = $('localwx-daily');
      clear(list);
      if (!r.daily.length) { list.appendChild(el('li', { className: 'lw-empty', text: 'The 7-day forecast is not available right now.' })); return; }
      r.daily.forEach(function (d) {
        var temps = [];
        if (d.hiF !== null && d.hiF !== undefined) temps.push('High ' + tempBoth(d.hiF));
        if (d.loF !== null && d.loF !== undefined) temps.push('Low ' + tempBoth(d.loF));
        list.appendChild(el('li', { className: 'day' }, [
          el('div', { className: 'lw-d-name', text: d.name }),
          el('div', { className: 'lw-d-temps', text: temps.join(' · ') || '—' }),
          el('div', { className: 'lw-d-sky', text: (d.sky || '—') + ' · ' + rainText(d.pop) })
        ]));
      });
    }

    function renderAlerts(r) {
      var box = $('localwx-alerts');
      clear(box);
      var a = r.alerts || {};
      if (a.us) {
        if (a.failed) { box.appendChild(el('p', { text: 'Could not check weather warnings right now. Tap Refresh to try again.' })); return; }
        if (!a.features.length) { box.appendChild(el('p', { text: 'No active weather warnings for this spot right now.' })); return; }
        box.appendChild(el('p', { text: a.features.length + ' active warning' + (a.features.length === 1 ? '' : 's') + ' for this spot:' }));
        var ul = el('ul', { className: 'alert-list' });
        a.features.forEach(function (f) {
          var p = f.properties;
          var li = el('li', null, [
            el('div', { className: 'alert-item-title', text: p.event || 'Weather alert' }),
            el('div', { className: 'alert-item-meta', text: (p.severity || 'Unknown') + (p.ends || p.expires ? ' · Ends ' + formatLocalTime(p.ends || p.expires) : '') }),
            el('button', { type: 'button', className: 'btn', text: 'Read more', 'aria-label': 'Read more about ' + (p.event || 'this alert'),
              on: { click: function (e) { Weather.openAlert(f, e.currentTarget); } } })
          ]);
          li.style.borderLeftColor = severityColor(p.severity);
          ul.appendChild(li);
        });
        box.appendChild(ul);
        return;
      }
      box.appendChild(el('p', { text: 'Official warnings: this country\'s weather warnings are not in this app. ' +
        'See World disaster alerts (GDACS) in the Weather sheet, and follow local officials.' }));
      var near = el('div', { className: 'lw-gdacs' }, [el('p', { className: 'hint', text: 'Checking world disaster alerts near this spot…' })]);
      box.appendChild(near);
      gdacsNear(r).then(function (list) {
        if (!document.contains(near)) return;
        clear(near);
        if (!list.length) { near.appendChild(el('p', { className: 'hint', text: 'No GDACS disaster alerts within 300 km (190 mi) right now.' })); return; }
        near.appendChild(el('p', { text: 'GDACS disaster alerts within 300 km (190 mi):' }));
        var ul = el('ul', { className: 'alert-list' });
        list.forEach(function (e) {
          var li = el('li', { className: 'gdacs-item' }, [
            el('div', { className: 'alert-item-title', text: e.type + ': ' + e.name }),
            el('div', { className: 'alert-item-meta', text: e.level + ' alert · ' + formatDistance(e.d) + ' away' +
              (e.modified ? ' · Updated ' + formatLocalTime(e.modified) : '') })
          ]);
          if (e.report) li.appendChild(el('a', { href: e.report, target: '_blank', rel: 'noopener noreferrer', text: 'GDACS report' }));
          li.style.borderLeftColor = e.level === 'Red' ? '#d32f2f' : e.level === 'Orange' ? '#f57c00' : '#2e7d32';
          ul.appendChild(li);
        });
        near.appendChild(ul);
      }, function () {
        if (!document.contains(near)) return;
        clear(near);
        near.appendChild(el('p', { className: 'hint', text: 'Could not check world disaster alerts right now.' }));
      });
    }

    /** GDACS events within 300 km. Reuses the World disaster alerts layer data when it is on. */
    function gdacsNear(r) {
      var have = Weather.state.gdacs.features;
      var listP;
      if (have && have.length) listP = Promise.resolve(have);
      else if (lw.gdacs && Date.now() - lw.gdacs.at < REFRESH_MS) listP = Promise.resolve(lw.gdacs.list);
      else if (!navigator.onLine) listP = Promise.reject(new Error('offline'));
      else {
        if (!lw.gdacsFlight) {
          lw.gdacsFlight = getJson(Weather.GDACS_API, 'application/json').then(function (j) {
            var list = (j && Array.isArray(j.features) ? j.features : []).map(Weather.gdacsEvent).filter(Boolean);
            lw.gdacs = { at: Date.now(), list: list };
            return list;
          }).finally(function () { lw.gdacsFlight = null; });
        }
        listP = lw.gdacsFlight;
      }
      return listP.then(function (list) {
        return list.map(function (e) { return { e: e, d: distanceMeters(r.lat, r.lon, e.lat, e.lon) }; })
          .filter(function (x) { return x.d <= GDACS_NEAR_M; })
          .sort(function (a, b) { return a.d - b.d; }).slice(0, 5)
          .map(function (x) { var o = Object.assign({}, x.e); o.d = x.d; return o; });
      });
    }

    function renderSource(r) {
      var box = $('localwx-source');
      clear(box);
      var parts = ['Source: ' + sourceName(r) + '.'];
      var n = r.now;
      if (n && n.station && !n.fromForecast) {
        parts.push('Now: weather station ' + n.station + (n.obsTime ? ', reading at ' + formatLocalTime(n.obsTime) : '') + '.');
      } else if (r.src === 'om' && n && n.localTime) {
        parts.push('Model data (not a weather station), for ' + hourLabel(n.localTime) + ' local time there.');
      }
      if (r.model) parts.push(modelText(r.model, r.modelFilled) + '.');
      else if (r.src === 'nws') parts.push('Model: NWS forecast grid (2.5 km).');
      box.appendChild(textNode(parts.join(' ') + ' '));
      if (r.src !== 'nws') {
        box.appendChild(el('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Weather data by Open-Meteo.com' }));
        box.appendChild(textNode(' (CC BY 4.0).'));
      } else {
        box.appendChild(el('a', { href: 'https://forecast.weather.gov/MapClick.php?lat=' + r.lat.toFixed(4) + '&lon=' + r.lon.toFixed(4),
          target: '_blank', rel: 'noopener noreferrer', text: 'Full forecast at weather.gov' }));
      }
    }

    function renderUpdated(r, saved) {
      var t = formatLocalTime(new Date(r.fetchedAt));
      $('localwx-updated').textContent = saved
        ? 'Updated ' + t + '. Saved from ' + t + ': this is the last weather we got, not new.'
        : 'Updated ' + t + '.';
    }

    function renderAll(r, saved) { render(r, saved); }
    function render(r, saved) {
      renderPlace(r);
      renderNow(r);
      renderHourly(r);
      renderDaily(r);
      renderAlerts(r);
      renderSource(r);
      renderUpdated(r, saved);
    }

    function showSavedOrSheet(msg, pt) { showSavedOr(msg, pt); }
    function showSavedOr(msg, pt) {
      var r = nearResult(pt || pickPoint()) || lw.last;
      if (r) { render(r, true); status(msg + ' Showing weather saved from ' + formatLocalTime(new Date(r.fetchedAt)) + '.'); }
      else {
        status(msg);
        $('localwx-updated').textContent = 'Updated: not yet.';
      }
    }

    /** Get weather for the current point. force = the user tapped Refresh.
     *  ptIn = a point from someone else (the header chip); the card is only redrawn when it is the card's point. */
    function load(force, ptIn) {
      var pt = ptIn || pickPoint();
      var sheetPt = pickPoint();
      var forSheet = !ptIn || distanceMeters(pt.lat, pt.lon, sheetPt.lat, sheetPt.lon) <= SAME_AREA_M;
      var status = forSheet ? setStatusText : function () {};
      var render = forSheet ? renderAll : function () {};
      var showSavedOr = forSheet ? showSavedOrSheet : function () {};
      // Offline: anything shown is saved, never "current".
      if (!navigator.onLine) { showSavedOr('Local weather needs internet. Try again when you have signal.', pt); return Promise.resolve(null); }
      var have = nearResult(pt);
      // A request for this same area is already on its way (for example the main-screen chip): wait for it.
      if (lw.flight && distanceMeters(lw.flight.lat, lw.flight.lon, pt.lat, pt.lon) <= SAME_AREA_M &&
          !(have && Date.now() - have.fetchedAt < MIN_GAP_MS)) {
        status('Getting the weather…');
        return lw.flight.promise;
      }
      if (have && Date.now() - have.fetchedAt < MIN_GAP_MS) {
        render(have, false);
        status(force ? 'Already up to date. New weather can be checked after ' +
          formatLocalTime(new Date(have.fetchedAt + MIN_GAP_MS)) + '.' : '');
        return Promise.resolve(have);
      }
      // The 5-minute gap also applies to attempts that failed (the one built-in retry is part of an attempt).
      var tried = nearAttempt(pt);
      if (tried && Date.now() - tried.at < MIN_GAP_MS) {
        showSavedOr('Could not get the weather a moment ago. You can try again after ' +
          formatLocalTime(new Date(tried.at + MIN_GAP_MS)) + '.', pt);
        return Promise.resolve(null);
      }
      // Never cancel the card's own request just for the chip; the chip tries again later.
      if (!forSheet && lw.busy) return Promise.resolve(null);
      var attemptKey = keyOf(pt);
      lw.attempts[attemptKey] = { lat: pt.lat, lon: pt.lon, at: Date.now() };
      var gen = ++lw.gen;
      if (lw.ctrl) lw.ctrl.abort();
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      lw.ctrl = ctrl;
      lw.busy = true;
      if (forSheet) $('localwx-refresh').disabled = true;
      status('Getting the weather…');
      if (forSheet && !have && !lw.last) $('localwx-place').textContent = pt.kind + ': ' + formatDecimal(pt.lat, pt.lon);
      var promise = fetchFor(pt, ctrl && ctrl.signal).then(function (r) {
        if (gen !== lw.gen) return null;
        r.lat = pt.lat; r.lon = pt.lon; r.kind = pt.kind; r.center = !!pt.center; r.fetchedAt = Date.now();
        lw.cache[keyOf(pt)] = r;
        lw.last = r;
        render(r, false);
        status('');
        notify(r);
        return r;
      }, function () {
        // A failure caused by losing signal does not count: try again as soon as we are back online.
        if (!navigator.onLine) delete lw.attempts[attemptKey];
        if (gen !== lw.gen) return null;
        showSavedOr(navigator.onLine ? 'Could not get the weather right now. Tap Refresh to try again.'
          : 'Local weather needs internet. Try again when you have signal.', pt);
        return null;
      }).finally(function () {
        if (lw.flight && lw.flight.gen === gen) lw.flight = null;
        if (gen === lw.gen) { lw.busy = false; $('localwx-refresh').disabled = false; }
      });
      lw.flight = { lat: pt.lat, lon: pt.lon, gen: gen, promise: promise };
      return promise;
    }

    function notify(r) {
      lw.listeners.forEach(function (fn) { try { fn(r); } catch (e) { /* a listener problem must not break the card */ } });
    }
    function onUpdate(fn) { lw.listeners.push(fn); }

    /** spot (optional) = {lat, lon, label}: show the card for that spot (This spot -> Full forecast). */
    function open(spot) {
      lw.opened = true;
      var opener = $('btn-weather');
      if (spot && isFinite(spot.lat) && isFinite(spot.lon)) {
        opener = $('btn-more');
        openSheet('sheet-localwx', opener);
        lw.forced = { lat: spot.lat, lon: spot.lon, kind: 'Map point' };
      } else {
        lw.forced = null;
        // The card replaces the Weather sheet; focus returns to the Weather button.
        openSheet('sheet-localwx', opener);
      }
      var r = nearResult(pickPoint());
      if (r && navigator.onLine && Date.now() - r.fetchedAt < REFRESH_MS) { render(r, false); status(''); }
      else load(false);
      schedule();
    }

    /** Auto-refresh: every 15 min (or after moving > 2 km) while GPS is on and the card was opened once. */
    function tick() {
      if (!lw.opened || state.watchId === null || document.hidden || lw.busy) return;
      var r = nearResult(pickPoint());
      if (!r || Date.now() - r.fetchedAt >= REFRESH_MS) load(false);
    }
    function schedule() {
      clearInterval(lw.timer);
      lw.timer = null;
      if (!lw.opened || document.hidden) return;
      lw.timer = setInterval(tick, TICK_MS);
    }

    function init() {
      $('btn-localwx').addEventListener('click', function () { open(); });
      sheetCloseHooks['sheet-localwx'] = function () { lw.forced = null; };
      $('localwx-refresh').addEventListener('click', function () { load(true); });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { clearInterval(lw.timer); lw.timer = null; return; }
        schedule();
        tick();
      });
      window.addEventListener('online', function () { if (lw.opened && !$('sheet-localwx').hidden) load(false); });
    }

    return { init: init, load: load, open: open, onUpdate: onUpdate, pickPoint: pickPoint, basePoint: basePoint, nearResult: nearResult,
      MIN_GAP_MS: MIN_GAP_MS, state: lw };
  })();
  ReadyMap.localWeather = { state: LocalWx.state };

  // ---------------------------------------------------------------------------
  // 14b. Main-screen weather chip (1.2.1): current temp + short sky text in the header.
  // Uses the Local weather card's point, fetch and cache (same 5-minute limit). Tap = open the card.
  // ---------------------------------------------------------------------------
  var WxChip = (function () {
    var SAVE_KEY = 'readymap.wxchip.v1';
    var MOVE_M = 5000;            // refetch when the weather point moves more than 5 km
    var TICK_MS = 60 * 1000;
    var SAVED_MAX_MS = 24 * 3600 * 1000;
    var wc = { pt: null, at: 0, shown: null, timer: null, moveTimer: null, listeners: [] };

    function nowOf(r) {
      var n = r && r.now;
      if (n && n.tempF !== null && n.tempF !== undefined) return { tempF: n.tempF, sky: n.sky || '' };
      var h = r && r.hourly && r.hourly[0];
      if (h && h.tempF !== null && h.tempF !== undefined) return { tempF: h.tempF, sky: h.sky || '' };
      return null;
    }
    /** Short sky text for a small chip: first part of the forecast phrase, max 22 characters. */
    function shortSky(s) {
      s = String(s || '').split(/\s+then\s+|;|,/i)[0].trim();
      return s.length > 22 ? s.slice(0, 21).trim() + '…' : s;
    }
    function loadSaved() {
      try {
        var v = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
        if (v && isFinite(v.tempF) && isFinite(v.at) && Date.now() - v.at < SAVED_MAX_MS) return v;
      } catch (e) { /* ignore */ }
      return null;
    }
    function save(v) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }

    function hide() { var b = $('wx-chip'); if (b) b.hidden = true; wc.shown = null; }

    /** v = { tempF, sky, at, lat, lon }; saved = true when it is not a fresh reading. */
    function show(v, saved) {
      var b = $('wx-chip');
      if (!b || !v) return;
      var t = Math.round(v.tempF) + '°F';
      var sky = shortSky(v.sky);
      $('wx-chip-temp').textContent = t;
      $('wx-chip-sep').hidden = !sky;
      $('wx-chip-sky').textContent = sky;
      $('wx-chip-saved').hidden = !saved;
      var srcEl = $('wx-chip-src');
      if (srcEl) { srcEl.textContent = v.src === 'station' ? 'station' : v.src === 'model' ? 'model' : ''; srcEl.hidden = !srcEl.textContent; }
      var label = 'Weather now: ' + t + (v.sky ? ', ' + v.sky : '') + (srcText(v) ? ', ' + srcText(v) : '') +
        (saved ? '. Saved from ' + formatLocalTime(new Date(v.at)) + ', not new' : '') + '. Open local weather.';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.classList.toggle('wx-chip-saved', !!saved);
      b.hidden = false;
      wc.shown = { v: v, saved: !!saved };
      wc.listeners.forEach(function (fn) { try { fn(wc.shown); } catch (e) { /* ignore */ } });
    }
    /** "from weather station KSLC" / "from forecast model NOAA HRRR (3 km)" */
    function srcText(v) {
      if (!v || !v.src) return '';
      if (v.src === 'station') return 'from weather station' + (v.srcName ? ' ' + v.srcName : '');
      return 'from forecast model' + (v.srcName ? ' ' + v.srcName : '');
    }

    function fromResult(r, saved) {
      var n = nowOf(r);
      if (!n) return null;
      var rn = r.now;
      var station = rn && rn.station && !rn.fromForecast && rn.tempF !== null && rn.tempF !== undefined;
      return { tempF: n.tempF, sky: n.sky, at: r.fetchedAt, lat: r.lat, lon: r.lon,
        src: station ? 'station' : 'model',
        srcName: station ? String(rn.station).split(' ')[0] : (r.model ? r.model.label : r.src === 'nws' ? 'NWS forecast grid (2.5 km)' : ''),
        obsTime: station && rn.obsTime ? rn.obsTime.getTime() : null };
    }

    function onResult(r) {
      var v = fromResult(r);
      if (!v) return;
      // Ignore results for another spot (e.g. This spot -> Full forecast while GPS is on).
      var bp = LocalWx.basePoint();
      if (distanceMeters(r.lat, r.lon, bp.lat, bp.lon) > 2000) return;
      wc.pt = { lat: r.lat, lon: r.lon };
      wc.at = r.fetchedAt;
      save(v);
      show(v, false);
    }

    function showSaved() {
      var last = LocalWx.state.last;
      var v = (last && fromResult(last)) || loadSaved();
      if (v) show(v, true); else hide();
    }

    /** Check whether the chip needs new weather; force = startup / GPS fix / back online. */
    function check(force) {
      if (!navigator.onLine) { showSaved(); return; }
      if (document.hidden && !force) return;
      var pt = LocalWx.basePoint();
      var have = LocalWx.nearResult(pt);
      if (have && Date.now() - have.fetchedAt < LocalWx.MIN_GAP_MS) { onResult(have); return; }
      var moved = !wc.pt || distanceMeters(wc.pt.lat, wc.pt.lon, pt.lat, pt.lon) > MOVE_M;
      var stale = Date.now() - wc.at >= LocalWx.MIN_GAP_MS;
      if (!force && !moved && !stale) return;
      LocalWx.load(false, pt).then(function (r) {
        if (r) return;
        if (!wc.shown || wc.shown.saved) showSaved();
      }, function () { if (!wc.shown) showSaved(); });
    }

    function init() {
      if (!$('wx-chip')) return;
      LocalWx.onUpdate(onResult);
      $('wx-chip').addEventListener('click', function () { LocalWx.open(); });
      var saved = loadSaved();
      if (saved) show(saved, true);
      if (state.map) {
        state.map.on('moveend', function () {
          clearTimeout(wc.moveTimer);
          wc.moveTimer = setTimeout(function () { check(false); }, 800);
        });
      }
      window.addEventListener('online', function () { check(true); });
      window.addEventListener('offline', showSaved);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) check(false); });
      wc.timer = setInterval(function () { check(false); }, TICK_MS);
      check(true);
    }

    function onShow(fn) { wc.listeners.push(fn); }
    return { init: init, check: check, state: wc, shortSky: shortSky, onShow: onShow, srcText: srcText };
  })();
  ReadyMap.wxChip = { state: WxChip.state, check: WxChip.check, shortSky: WxChip.shortSky };

  // ---------------------------------------------------------------------------
  // 14c. Weather for the selected spot (1.2.1): "This spot" panel + one line in the point card.
  // Open-Meteo forecast (worldwide, also over the ocean) + Open-Meteo Marine (sea temperature and
  // waves). Water is detected by the Marine API giving non-null values. Cached per spot (2 decimals)
  // for 5 minutes, in memory only.
  // ---------------------------------------------------------------------------
  var SpotWx = (function () {
    var FORECAST = 'https://api.open-meteo.com/v1/forecast';
    var MARINE = 'https://marine-api.open-meteo.com/v1/marine';
    var FRESH_MS = 5 * 60 * 1000;
    var sw = { cache: {}, gen: 0, ctrl: null, key: null, timer: null, shown: null };
    var SAME_SPOT_M = 2000;        // 1.3.0: this close to the top-bar chip's spot -> reuse its reading
    var CHIP_MAX_AGE_MS = 30 * 60 * 1000;

    function keyOf(lat, lon) { return lat.toFixed(2) + ',' + lon.toFixed(2); }
    function num(v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v); }
    function getJson(url, signal) {
      return fetchWithTimeout(url, { credentials: 'omit' }, FETCH_TIMEOUT_MS, signal).then(function (res) {
        if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
        return res.json();
      });
    }

    function forecastUrl(lat, lon) {
      return FORECAST + '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
        '&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
        '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto' +
        '&temperature_unit=fahrenheit&wind_speed_unit=mph';
    }
    function marineUrl(lat, lon) {
      return MARINE + '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
        '&current=sea_surface_temperature,wave_height,wave_direction,wave_period';
    }
    /** Pure parsers (exposed for tests). */
    function parseForecast(j) {
      var c = (j && j.current) || {};
      var d = (j && j.daily) || {};
      var first = function (a) { return Array.isArray(a) && a.length ? num(a[0]) : null; };
      var out = {
        tempF: num(c.temperature_2m),
        sky: c.weather_code !== undefined && c.weather_code !== null ? wmoCodeText(c.weather_code) : '',
        windMph: num(c.wind_speed_10m), windDeg: num(c.wind_direction_10m), gustMph: num(c.wind_gusts_10m),
        hiF: first(d.temperature_2m_max), loF: first(d.temperature_2m_min)
      };
      if (out.tempF === null && out.hiF === null) throw new Error('empty forecast');
      return out;
    }
    /** null = land (or no marine data): every value missing. */
    function parseMarine(j) {
      var c = (j && j.current) || {};
      var out = { sstC: num(c.sea_surface_temperature), waveM: num(c.wave_height), waveDeg: num(c.wave_direction), waveS: num(c.wave_period) };
      return out.sstC === null && out.waveM === null && out.waveS === null ? null : out;
    }

    // ----- text -----
    function tBoth(f) { return f === null || f === undefined ? '—' : Math.round(f) + '°F / ' + Math.round(fToC(f)) + '°C'; }
    function cBoth(c) { return c === null || c === undefined ? '—' : Math.round(cToF(c)) + '°F / ' + Math.round(c) + '°C'; }
    function windLine(w) {
      if (w.windMph === null) return '—';
      var mph = Math.round(w.windMph);
      if (mph === 0) return 'Calm';
      var dir = degToCompass(w.windDeg);
      var s = mph + ' mph' + (dir ? ' from the ' + compassWords(dir) + ' (' + dir + ')' : '');
      if (w.gustMph !== null && Math.round(w.gustMph) > mph) s += ', gusts ' + Math.round(w.gustMph) + ' mph';
      return s;
    }
    function hiLoLine(w) {
      var parts = [];
      if (w.hiF !== null) parts.push('High ' + tBoth(w.hiF));
      if (w.loF !== null) parts.push('Low ' + tBoth(w.loF));
      return parts.join(' · ') || '—';
    }
    function waveLine(m) {
      if (m.waveM === null) return '—';
      var s = (Math.round(m.waveM * 10) / 10) + ' m (' + (Math.round(m.waveM * 3.28084 * 10) / 10) + ' ft)';
      if (m.waveS !== null) s += ', every ' + Math.round(m.waveS) + ' s';
      var dir = degToCompass(m.waveDeg);
      if (dir) s += ', from the ' + compassWords(dir) + ' (' + dir + ')';
      return s;
    }

    // ----- render -----
    function row(dl, name, value, cls) {
      dl.appendChild(el('dt', { className: cls || '', text: name }));
      dl.appendChild(el('dd', { className: cls || '', text: value }));
    }
    function setStatus(text) { $('spotwx-status').textContent = text || ''; $('spotwx-status').hidden = !text; }
    /** The top-bar chip's reading, if it is fresh and for (nearly) the same spot. */
    function chipMatch(lat, lon) {
      var sh = WxChip.state.shown;
      if (!sh || sh.saved || !sh.v || !isFinite(sh.v.lat) || !isFinite(sh.v.lon)) return null;
      if (Date.now() - sh.v.at > CHIP_MAX_AGE_MS) return null;
      if (distanceMeters(lat, lon, sh.v.lat, sh.v.lon) > SAME_SPOT_M) return null;
      return sh.v;
    }
    function renderEntry(e, saved) {
      sw.shown = { e: e, saved: !!saved };
      var dl = $('spotwx-facts');
      clear(dl);
      var line = [];
      var chip = saved ? null : chipMatch(e.lat, e.lon);
      if (e.wx) {
        var airF = chip ? chip.tempF : e.wx.tempF;
        var sky = chip && chip.sky ? chip.sky : e.wx.sky;
        row(dl, 'Air', tBoth(airF));
        row(dl, 'Sky', sky || '—');
        row(dl, 'Wind', windLine(e.wx));
        row(dl, 'Today', hiLoLine(e.wx));
        var src;
        if (chip) {
          src = 'Same as the top bar: ' + (chip.src === 'station' ? 'weather station' + (chip.srcName ? ' ' + chip.srcName : '') +
            (chip.obsTime ? ', reading at ' + formatLocalTime(new Date(chip.obsTime)) : '') : 'forecast model' + (chip.srcName ? ' ' + chip.srcName : ''));
        } else {
          src = 'Forecast model: ' + (e.model ? e.model.label : OM_BEST.label) + (e.filled ? ' (later hours: best match)' : '');
        }
        row(dl, 'Source', src, 'spotwx-src');
        if (airF !== null) line.push(tBoth(airF));
        if (sky) line.push(sky);
      }
      if (e.marine) {
        row(dl, 'Sea temp', cBoth(e.marine.sstC), 'spotwx-marine');
        row(dl, 'Waves', waveLine(e.marine), 'spotwx-marine');
        if (e.marine.sstC !== null) line.push('Sea ' + Math.round(cToF(e.marine.sstC)) + '°F');
      }
      dl.hidden = !dl.firstChild;
      var t = formatLocalTime(new Date(e.at));
      $('spotwx-updated').textContent = e.wx || e.marine
        ? (saved ? 'Saved from ' + t + ': this is the last weather we got here, not new.' : 'Updated ' + t + '.') +
          (chip && chip.src === 'station' ? ' Air and sky: National Weather Service station.' : '') +
          ' Weather data by Open-Meteo.com (CC BY 4.0).'
        : '';
      var pw = $('point-wx');
      pw.textContent = line.length ? (saved ? 'Saved: ' : 'Weather: ') + line.join(' · ') : '';
      pw.hidden = !line.length;
      renderOfficial(e.lat, e.lon);
    }
    /** "Official weather service" link for the spot's country (1.3.0). */
    function renderOfficial(lat, lon) {
      var box = $('spotwx-official');
      if (!box) return;
      var cc = Country.known(lat, lon);
      var svc = officialService(cc, lat, lon);
      clear(box);
      if (!svc) { box.hidden = true; return; }
      var country = Country.nameOf(lat, lon);
      box.appendChild(textNode('Official weather service' + (country ? ' (' + country + ')' : '') + ': '));
      box.appendChild(el('a', { href: svc.url, target: '_blank', rel: 'noopener noreferrer', text: svc.name }));
      box.hidden = false;
    }
    function renderEmpty(msg) {
      sw.shown = null;
      if ($('spotwx-official')) { clear($('spotwx-official')); $('spotwx-official').hidden = true; }
      clear($('spotwx-facts'));
      $('spotwx-facts').hidden = true;
      $('spotwx-updated').textContent = '';
      $('point-wx').hidden = true;
      $('point-wx').textContent = '';
      setStatus(msg);
    }

    function fetchSpot(lat, lon, signal) {
      var settle = function (p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); };
      return Promise.all([
        settle(countryQuick(lat, lon).then(function (cc) {
          return omFetch(forecastUrl(lat, lon), lat, lon, cc, function (u) { return getJson(u, signal); });
        }).then(function (got) { return { wx: parseForecast(got.j), model: got.model, filled: got.filled }; })),
        settle(getJson(marineUrl(lat, lon), signal).then(parseMarine))
      ]).then(function (r) {
        if (!r[0].ok && !r[1].ok) throw r[0].e || new Error('failed');
        var wx = r[0].ok ? r[0].v.wx : null;
        return { wx: wx, model: r[0].ok ? r[0].v.model : null, filled: r[0].ok ? r[0].v.filled : false,
          marine: r[1].ok ? r[1].v : null, wxFailed: !r[0].ok, marineFailed: !r[1].ok, at: Date.now(),
          lat: lat, lon: lon };
      });
    }

    /** Show weather for the selected spot (called whenever the selection changes). */
    function update() {
      var p = state.selected;
      clearTimeout(sw.timer);
      if (!p) { sw.key = null; renderEmpty(''); return; }
      var key = keyOf(p.lat, p.lon);
      var have = sw.cache[key];
      if (key === sw.key && have && Date.now() - have.at < FRESH_MS && navigator.onLine) return; // same spot, fresh: nothing to do
      sw.key = key;
      // Offline: anything shown is saved, never "current".
      if (!navigator.onLine) {
        if (have) { renderEntry(have, true); setStatus('Weather needs internet. Showing what we saved earlier.'); }
        else renderEmpty('Weather for this spot needs internet. Try again when you have signal.');
        return;
      }
      if (have && Date.now() - have.at < FRESH_MS) { renderEntry(have, false); setStatus(have.wxFailed ? 'Could not get the air weather here right now.' : ''); return; }
      if (have) renderEntry(have, true); else renderEmpty('');
      setStatus('Getting the weather for this spot…');
      // Short wait so dragging around or GPS updates do not send a request for every move.
      sw.timer = setTimeout(function () { go(p.lat, p.lon, key); }, 350);
    }

    function go(lat, lon, key) {
      var gen = ++sw.gen;
      if (sw.ctrl) sw.ctrl.abort();
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      sw.ctrl = ctrl;
      Country.lookup(lat, lon).then(function () {
        if (sw.key === key && sw.shown && keyOf(sw.shown.e.lat, sw.shown.e.lon) === key) renderOfficial(lat, lon);
      });
      return fetchSpot(lat, lon, ctrl && ctrl.signal).then(function (e) {
        sw.cache[key] = e;
        if (gen !== sw.gen || sw.key !== key) return;
        renderEntry(e, false);
        setStatus(e.wxFailed ? 'Could not get the air weather here right now.' : '');
      }, function () {
        if (gen !== sw.gen || sw.key !== key) return;
        var have = sw.cache[key];
        var msg = navigator.onLine ? 'Could not get the weather for this spot right now. Try again in a few minutes.'
          : 'Weather for this spot needs internet. Try again when you have signal.';
        if (have) { renderEntry(have, true); setStatus(msg + ' Showing what we saved earlier.'); }
        else renderEmpty(msg);
      });
    }

    function init() {
      if (!$('spotwx')) return;
      $('btn-spotwx-full').addEventListener('click', function () {
        var p = state.selected;
        if (p) LocalWx.open({ lat: p.lat, lon: p.lon, label: p.label });
      });
      window.addEventListener('online', function () { sw.key = null; update(); });
      window.addEventListener('offline', function () { sw.key = null; update(); });
      // The chip got a new reading: re-show the spot so the two numbers stay the same.
      WxChip.onShow(function () {
        var cur = sw.shown;
        if (cur && !cur.saved && sw.key === keyOf(cur.e.lat, cur.e.lon)) renderEntry(cur.e, false);
      });
      update();
    }

    return { init: init, update: update, state: sw, parseForecast: parseForecast, parseMarine: parseMarine,
      forecastUrl: forecastUrl, marineUrl: marineUrl, waveLine: waveLine, chipMatch: chipMatch };
  })();
  ReadyMap.spotWeather = { state: SpotWx.state, update: SpotWx.update, parseForecast: SpotWx.parseForecast,
    parseMarine: SpotWx.parseMarine, forecastUrl: SpotWx.forecastUrl, marineUrl: SpotWx.marineUrl, waveLine: SpotWx.waveLine,
    chipMatch: SpotWx.chipMatch };

  // ---------------------------------------------------------------------------
  // 14d. Weather stations layer (1.3.0): live airport weather reports (METAR/ASOS/AWOS) worldwide.
  // aviationweather.gov has no CORS header, so a browser page cannot read it. The Iowa Environmental
  // Mesonet "currents" API carries the same reports and allows any origin. stations.json (shipped
  // with the app) lists ~5,000 reporting stations; at zoom 7+ we ask for up to 60 stations in view,
  // in one request, at most once every 20 seconds, and keep each reading for 10 minutes.
  // ---------------------------------------------------------------------------
  var Stations = (function () {
    var INDEX_URL = 'stations.json';
    var API = 'https://mesonet.agron.iastate.edu/api/1/currents.json';
    var MIN_ZOOM = 7, MAX_STATIONS = 60, FRESH_MS = 10 * 60 * 1000, MIN_GAP_MS = 20 * 1000, MOVE_WAIT_MS = 800;
    var OLD_MS = 2 * 3600 * 1000, DROP_MS = 12 * 3600 * 1000;
    var ATTRIBUTION = 'Stations: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a> (METAR)';
    var st = { on: false, index: null, indexFlight: null, layer: null, markers: new Map(), obs: new Map(), lastReq: 0,
      flight: null, timer: null, moveTimer: null, gen: 0, lastGood: null, shownIds: [], requests: 0 };

    function setToggle(on) { $('toggle-stations').setAttribute('aria-checked', on ? 'true' : 'false'); }
    function note(t) { $('stations-note').textContent = t || ''; }
    function opac() { return Number($('opacity-stations').value) / 100; }

    function loadIndex() {
      if (st.index) return Promise.resolve(st.index);
      if (st.indexFlight) return st.indexFlight;
      st.indexFlight = fetchWithTimeout(INDEX_URL, {}, FETCH_TIMEOUT_MS).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (j) {
        var list = (j && Array.isArray(j.stations) ? j.stations : []).filter(function (s) {
          return Array.isArray(s) && /^[A-Z0-9]{3,5}$/.test(s[0]) && isFinite(s[1]) && isFinite(s[2]);
        });
        if (!list.length) throw new Error('empty index');
        st.index = list;
        return list;
      }).finally(function () { st.indexFlight = null; });
      return st.indexFlight;
    }

    /** Stations in view (a little padding), thinned on a grid to at most MAX_STATIONS. */
    function visibleIds() {
      if (!st.index || !state.map) return [];
      var b = state.map.getBounds().pad(0.1);
      var s = b.getSouth(), n = b.getNorth(), w = wrapLon(b.getWest()), e = wrapLon(b.getEast());
      var wrap = w > e;
      var inView = st.index.filter(function (x) {
        if (x[1] < s || x[1] > n) return false;
        return wrap ? (x[2] >= w || x[2] <= e) : (x[2] >= w && x[2] <= e);
      });
      if (inView.length <= MAX_STATIONS) return inView.map(function (x) { return x[0]; });
      var cols = 8, rows = 10, cells = {}, out = [];
      var width = wrap ? (e + 360 - w) : (e - w);
      inView.forEach(function (x) {
        var dx = wrap && x[2] < w ? x[2] + 360 - w : x[2] - w;
        var c = Math.min(cols - 1, Math.floor(dx / (width || 1) * cols));
        var r = Math.min(rows - 1, Math.floor((x[1] - s) / ((n - s) || 1) * rows));
        var k = r + ':' + c;
        // Prefer 4-letter ICAO airports (the main reporting stations) in each cell.
        if (!cells[k] || (cells[k][0].length !== 4 && x[0].length === 4)) cells[k] = x;
      });
      Object.keys(cells).forEach(function (k) { out.push(cells[k][0]); });
      return out.slice(0, MAX_STATIONS);
    }

    function tempLabel(f) { return f === null || f === undefined ? '—' : Math.round(f) + '°'; }
    function obsAge(o) { var t = Date.parse(o.utc_valid); return isNaN(t) ? Infinity : Date.now() - t; }

    function popupFor(o) {
      var box = el('div', { className: 'stn-pop' });
      box.appendChild(el('p', { className: 'stn-name', text: (o.name || o.station) + ' (' + o.station + ')' }));
      var dl = el('dl', { className: 'lw-facts' });
      var add = function (k, v) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); };
      add('Temp', o.tmpf === null ? '—' : Math.round(o.tmpf) + '°F / ' + Math.round(fToC(o.tmpf)) + '°C');
      var wind = '—';
      if (o.sknt !== null) {
        var mph = Math.round(o.sknt * 1.150779);
        var dir = degToCompass(o.drct);
        wind = mph === 0 ? 'Calm' : mph + ' mph' + (dir ? ' from the ' + compassWords(dir) + ' (' + dir + ')' : '');
        if (o.gust !== null && Math.round(o.gust * 1.150779) > mph) wind += ', gusts ' + Math.round(o.gust * 1.150779) + ' mph';
      }
      add('Wind', wind);
      add('Visibility', o.vsby === null ? '—' : (o.vsby >= 9.9 ? '10+ miles (16+ km)' :
        (Math.round(o.vsby * 10) / 10) + ' miles (' + (Math.round(o.vsby * 1.609344 * 10) / 10) + ' km)'));
      var t = Date.parse(o.utc_valid);
      var ago = isNaN(t) ? '' : Math.max(0, Math.round((Date.now() - t) / 60000));
      add('Observed', isNaN(t) ? '—' : formatLocalTime(new Date(t)) + ' (' + (ago < 90 ? ago + ' min ago' : Math.round(ago / 60) + ' h ago') + ')');
      box.appendChild(dl);
      box.appendChild(el('p', { className: 'fine', text: 'Airport weather report (METAR) via Iowa Environmental Mesonet.' }));
      return box;
    }

    function markerFor(o) {
      var old = obsAge(o) > OLD_MS;
      var label = tempLabel(o.tmpf);
      var icon = L.divIcon({ className: 'stn-icon' + (old ? ' stn-old' : ''), html: '<span>' + label + '</span>', iconSize: [40, 22], iconAnchor: [20, 11] });
      var m = L.marker([o.lat, o.lon], { icon: icon, keyboard: true, opacity: opac(),
        title: (o.name || o.station) + ': ' + (o.tmpf === null ? 'no temperature' : Math.round(o.tmpf) + '°F') + (old ? ' (old reading)' : ''),
        alt: 'Weather station ' + o.station });
      m.bindPopup(function () { return popupFor(o); }, { maxWidth: 260 });
      m._stnKey = o.station + '|' + o.utc_valid + '|' + label;
      return m;
    }

    function draw(ids) {
      if (!st.layer) return;
      var want = {};
      ids.forEach(function (id) {
        var c = st.obs.get(id);
        if (c && c.o && obsAge(c.o) < DROP_MS && isFinite(c.o.lat) && isFinite(c.o.lon)) want[id] = c.o;
      });
      st.markers.forEach(function (m, id) {
        var o = want[id];
        if (!o || m._stnKey !== o.station + '|' + o.utc_valid + '|' + tempLabel(o.tmpf)) {
          if (m.isPopupOpen && m.isPopupOpen() && o) return; // keep an open popup until it closes
          st.layer.removeLayer(m);
          st.markers.delete(id);
        }
      });
      Object.keys(want).forEach(function (id) {
        if (st.markers.has(id)) return;
        var m = markerFor(want[id]);
        st.markers.set(id, m);
        st.layer.addLayer(m);
      });
      st.shownIds = Object.keys(want);
    }

    function timeText() {
      if (!st.lastGood) return 'Not loaded';
      var newest = 0;
      st.shownIds.forEach(function (id) { var c = st.obs.get(id); var t = c && c.o ? Date.parse(c.o.utc_valid) : NaN; if (!isNaN(t) && t > newest) newest = t; });
      return 'Updated ' + formatLocalTime(st.lastGood) + ' · ' + st.shownIds.length + ' station' + (st.shownIds.length === 1 ? '' : 's') +
        (newest ? ' · newest reading ' + formatLocalTime(new Date(newest)) : '');
    }

    function refresh() {
      if (!st.on || !state.map) return;
      clearTimeout(st.timer);
      var z = state.map.getZoom();
      if (z < MIN_ZOOM) {
        draw([]);
        note('Zoom in closer to see weather stations (zoom level 7 or closer; now ' + Math.round(z) + '). Tip: pinch out over a city.');
        $('time-stations').textContent = st.lastGood ? timeText() : 'Waiting for zoom';
        return;
      }
      var ids = visibleIds();
      draw(ids);
      if (!ids.length) { note('No airport weather stations in this view.'); $('time-stations').textContent = timeText(); return; }
      var now = Date.now();
      var need = ids.filter(function (id) { var c = st.obs.get(id); return !c || now - c.at >= FRESH_MS; });
      if (!need.length) { note(''); $('time-stations').textContent = timeText(); return; }
      if (!navigator.onLine) {
        note('Weather stations need internet.' + (st.shownIds.length ? ' Showing readings we got earlier.' : ''));
        $('time-stations').textContent = st.lastGood ? timeText() + ' (old)' : 'Not loaded';
        return;
      }
      if (st.flight) return; // the reply re-checks the view
      var wait = st.lastReq + MIN_GAP_MS - now;
      if (wait > 0) { st.timer = setTimeout(refresh, wait); return; }
      request(need);
    }

    function request(ids) {
      var gen = st.gen;
      st.lastReq = Date.now();
      st.requests++;
      if (!st.shownIds.length) $('time-stations').textContent = 'Loading…';
      var url = API + '?' + ids.map(function (id) { return 'station=' + encodeURIComponent(id); }).join('&');
      st.flight = fetchWithTimeout(url, { credentials: 'omit' }, FETCH_TIMEOUT_MS).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (j) {
        if (gen !== st.gen) return;
        var at = Date.now();
        var asked = {};
        ids.forEach(function (id) { asked[id] = true; st.obs.set(id, { o: null, at: at }); });
        (j && Array.isArray(j.data) ? j.data : []).forEach(function (r) {
          if (!r || !asked[r.station]) return;
          var num = function (v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v); };
          var o = { station: String(r.station), name: typeof r.name === 'string' ? r.name.slice(0, 80) : '',
            tmpf: num(r.tmpf), sknt: num(r.sknt), drct: num(r.drct), gust: num(r.gust), vsby: num(r.vsby),
            utc_valid: typeof r.utc_valid === 'string' ? r.utc_valid : '', lat: num(r.lat), lon: num(r.lon) };
          if (o.tmpf === null || o.lat === null || o.lon === null) return;
          st.obs.set(o.station, { o: o, at: at });
        });
        st.lastGood = new Date();
        note('');
      }).catch(function () {
        if (gen !== st.gen) return;
        note(navigator.onLine ? 'Weather stations could not load right now. We will try again when you move the map.' : 'Weather stations need internet.');
      }).finally(function () {
        st.flight = null;
        if (gen !== st.gen) return;
        // Draw what we have and fetch anything still missing (throttled).
        var ids2 = state.map.getZoom() >= MIN_ZOOM ? visibleIds() : [];
        draw(ids2);
        $('time-stations').textContent = timeText();
        if (ids2.some(function (id) { return !st.obs.has(id); })) {
          clearTimeout(st.timer);
          st.timer = setTimeout(refresh, Math.max(0, st.lastReq + MIN_GAP_MS - Date.now()));
        }
      });
    }

    function on() {
      st.on = true;
      st.gen++;
      setToggle(true);
      if (!st.layer) st.layer = L.layerGroup();
      st.layer.addTo(state.map);
      if (state.map.attributionControl) state.map.attributionControl.addAttribution(ATTRIBUTION);
      $('time-stations').textContent = 'Loading…';
      note('');
      loadIndex().then(function () { refresh(); }, function () {
        note('The station list could not load. Reload the page and try again.');
        $('time-stations').textContent = 'Not loaded';
      });
    }
    function off() {
      st.on = false;
      st.gen++;
      clearTimeout(st.timer);
      setToggle(false);
      if (st.layer) { st.layer.clearLayers(); state.map.removeLayer(st.layer); }
      st.markers.clear();
      st.shownIds = [];
      if (state.map.attributionControl) state.map.attributionControl.removeAttribution(ATTRIBUTION);
      $('time-stations').textContent = 'Off';
      note('');
    }

    function init() {
      if (!$('toggle-stations') || !state.map) return;
      $('toggle-stations').addEventListener('click', function () { if (st.on) off(); else on(); });
      var input = $('opacity-stations'), out = $('opacity-stations-val');
      var upd = function () {
        out.textContent = input.value + '%';
        input.setAttribute('aria-valuetext', input.value + '% visible');
        st.markers.forEach(function (m) { m.setOpacity(opac()); });
      };
      input.addEventListener('input', upd);
      upd();
      state.map.on('moveend', function () {
        if (!st.on) return;
        clearTimeout(st.moveTimer);
        st.moveTimer = setTimeout(refresh, MOVE_WAIT_MS);
      });
      window.addEventListener('online', function () { if (st.on) refresh(); });
      window.addEventListener('offline', function () { if (st.on) refresh(); });
      var prev = sheetCloseHooks['sheet-weather'];
      sheetCloseHooks['sheet-weather'] = function () {
        if (prev) prev();
        if (st.on) $('btn-weather').classList.add('is-on');
      };
    }

    return { init: init, on: on, off: off, refresh: refresh, visibleIds: visibleIds, state: st, API: API, MIN_ZOOM: MIN_ZOOM };
  })();
  ReadyMap.stations = Stations;

  // ---------------------------------------------------------------------------
  // 15. Startup
  // ---------------------------------------------------------------------------
  function bindUi() {
    $('btn-locate').addEventListener('click', function () {
      if (state.watchId !== null) stopWatch(false); else startWatch();
    });
    $('btn-follow').addEventListener('click', function () { setFollow(!state.follow, false); });
    $('btn-copy').addEventListener('click', onCopy);
    $('btn-share').addEventListener('click', onShare);
    $('btn-more').addEventListener('click', function (e) {
      if ($('sheet-more').hidden) openSheet('sheet-more', e.currentTarget); else closeSheet('sheet-more');
    });
    $('btn-share-location').addEventListener('click', onShareMyLocation);
    $('btn-copy-link').addEventListener('click', onCopyLink);
    $('form-save-place').addEventListener('submit', onSavePlace);

    $('btn-places').addEventListener('click', function (e) { renderPlacesList(); openSheet('sheet-places', e.currentTarget); });
    $('btn-gpx').addEventListener('click', downloadGpx);
    $('btn-confirm-delete').addEventListener('click', confirmDelete);
    sheetCloseHooks['sheet-confirm'] = function () { state.pendingDelete = null; };

    Array.prototype.forEach.call(document.querySelectorAll('[data-nearby]'), function (b) {
      b.addEventListener('click', function (e) { openNearby(b.getAttribute('data-nearby'), e.currentTarget); });
    });
    $('btn-nearby-show').addEventListener('click', showNearbyOnMap);

    $('btn-save-area').addEventListener('click', function (e) {
      $('save-status').textContent = '';
      prepareOffline();
      openSheet('sheet-save', e.currentTarget);
    });
    $('btn-save-clear').addEventListener('click', function () { clearSavedMap('save-status'); });
    $('btn-clear-map').addEventListener('click', function () { clearSavedMap('clear-status'); });

    $('btn-tools').addEventListener('click', function (e) {
      if ($('sheet-tools').hidden) openSheet('sheet-tools', e.currentTarget); else closeSheet('sheet-tools');
    });
    sheetCloseHooks['sheet-tools'] = function () { $('btn-tools').setAttribute('aria-expanded', 'false'); };

    $('btn-about').addEventListener('click', function (e) { $('clear-status').textContent = ''; openSheet('sheet-about', e.currentTarget); });
    // 1.4.3: Map names (readable vs local language), remembered on this device
    Array.prototype.forEach.call(document.querySelectorAll('input[name="map-names"]'), function (r) {
      r.addEventListener('change', function () { if (r.checked) setMapNames(r.value, true); });
    });

    $('btn-compass').addEventListener('click', function (e) { startCompass(e.currentTarget); });
    $('btn-compass-stop').addEventListener('click', function () { closeSheet('sheet-compass'); });
    sheetCloseHooks['sheet-compass'] = function () { stopCompass(); stopPointer(); };
    // 1.4.0: Point to this spot, Measure distance
    $('btn-point-spot').addEventListener('click', function (e) {
      var p = state.selected;
      if (!p) return;
      pointToSpot({ lat: p.lat, lon: p.lon, name: p.label || 'This spot' }, e.currentTarget);
    });
    $('btn-measure').addEventListener('click', startMeasure);
    $('btn-measure-undo').addEventListener('click', function () { measure.pts.pop(); renderMeasure(); });
    $('btn-measure-clear').addEventListener('click', function () { measure.pts = []; renderMeasure(); });
    $('btn-measure-me').addEventListener('click', measureFromMe);
    $('btn-measure-done').addEventListener('click', stopMeasure);

    $('btn-weather').addEventListener('click', function (e) {
      if ($('sheet-weather').hidden) openSheet('sheet-weather', e.currentTarget); else closeSheet('sheet-weather');
    });

    window.addEventListener('resize', updateLayoutVars);
  }

  // 1.4.1 Visitor counter (GoatCounter, loaded by a <script> tag at the end of index.html).
  // Anonymous only: the page path without the ?lat=..&lon=.. query, and a few fixed event names.
  // Never sends coordinates, tapped spots, labels or any other personal data. If the script is
  // blocked or the phone is offline, every call here quietly does nothing.
  var Analytics = (function () {
    var EVENTS = ['start-gps', 'weather-opened', 'compass-opened', 'measure-distance', 'share-used'];
    var sentView = false;
    function gc() {
      var g = window.goatcounter;
      return (g && typeof g.count === 'function' && typeof g.get_data === 'function') ? g : null;
    }
    // Wrap count.js data so no query string, referrer path or real title ever leaves the phone.
    function guard(g) {
      if (g._rmGuarded) return;
      var orig = g.get_data;
      g.get_data = function (vars) {
        vars = vars || {};
        var d = orig.call(g, vars);
        d.q = '';
        d.p = vars.event ? String(vars.path || '') : location.pathname;
        d.t = vars.event ? String(vars.path || '') : 'Ready Map';
        var r = '';
        try { if (d.r) r = new URL(d.r).origin; } catch (e) { r = ''; }
        if (r === location.origin) r = '';
        d.r = vars.event ? '' : r;
        return d;
      };
      g._rmGuarded = true;
    }
    function pageView() {
      try {
        var g = gc();
        if (!g || sentView) return;
        guard(g);
        sentView = true;
        g.count({ path: location.pathname });
      } catch (e) { /* counter blocked or broken: ignore */ }
    }
    function event(name) {
      try {
        if (EVENTS.indexOf(name) < 0) return;
        var g = gc();
        if (!g) return;
        guard(g);
        g.count({ path: name, event: true });
      } catch (e) { /* ignore */ }
    }
    function init() {
      try {
        pageView();
        var s = document.querySelector('script[data-goatcounter]');
        if (s) s.addEventListener('load', pageView);
      } catch (e) { /* ignore */ }
    }
    return { init: init, event: event, EVENTS: EVENTS };
  })();
  ReadyMap.analytics = Analytics;

  function bindAnalytics() {
    // Runs after the button's own click handler, so `when` sees the new state.
    function on(id, name, when) {
      var el = $(id);
      if (el) el.addEventListener('click', function () { if (!when || when()) Analytics.event(name); });
    }
    on('btn-locate', 'start-gps', function () { return state.watchId !== null; });
    on('btn-weather', 'weather-opened', function () { return !$('sheet-weather').hidden; });
    on('btn-compass', 'compass-opened');
    on('btn-measure', 'measure-distance');
    on('btn-share', 'share-used');
    on('btn-share-location', 'share-used');
  }

  function applyUrlParams() {
    var res = parseParams(location.search);
    if (!res.present) return;
    if (!res.ok) {
      setStatus('That map link has a problem: ' + res.error + ' Showing the normal map instead.', 'error');
      return;
    }
    state.map.setView([res.lat, res.lon], res.zoom, { animate: false });
    dropPin(res.lat, res.lon, res.label || 'Shared spot', 'url');
  }

  function start() {
    $('app-version').textContent = VERSION;
    bindUi();
    try { bindAnalytics(); Analytics.init(); } catch (e) { /* visitor counter is optional */ }
    initSheets();
    if (typeof L === 'undefined') {
      setStatus('The map could not load. Please reload the page.', 'error');
      return;
    }
    initMap();
    initFullMap();
    state.places = loadPlaces();
    drawPlaces();
    applyUrlParams();
    renderPoint();
    initNet();
    Weather.init();
    try { News.init(); } catch (e) { /* news panel is optional */ }
    try { LocalWx.init(); } catch (e) { /* local weather card is optional */ }
    try { WxChip.init(); } catch (e) { /* weather chip is optional */ }
    try { SpotWx.init(); } catch (e) { /* spot weather is optional */ }
    try { Stations.init(); } catch (e) { /* stations layer is optional */ }
    updateLayoutVars();
    $('about-example').textContent = buildSpotUrl(40.7608, -111.891, 'Meeting spot', 15);
    registerServiceWorker();
    if (window.isSecureContext === false) {
      // Tell users early; the map still works.
      $('btn-locate').setAttribute('aria-describedby', 'status-banner');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
