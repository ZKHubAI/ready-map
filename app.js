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
 *  10. Find nearby (links + Overpass)
 *  11. Offline save area
 *  12. Network status + service worker
 *  13. Compass
 *  14. Weather overlays (radar, satellite, warnings)
 *  15. Startup
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Constants
  // ---------------------------------------------------------------------------
  var VERSION = '1.1.0';
  // Base map tile provider. The OSM tile policy forbids bulk download / prefetch features
  // (https://operations.osmfoundation.org/policies/tiles/), so allowPrefetch is false: the app
  // only keeps tiles the user has actually looked at (the service worker caches them, max 500).
  // A provider that allows offline download could be configured here later; it would also need
  // its host added to sw.js (TILE_HOST) and to the CSP in index.html.
  var TILE_PROVIDER = {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    maxZoom: 19,
    allowPrefetch: false
  };
  var TILE_URL = TILE_PROVIDER.url;
  var OSM_ATTRIBUTION = TILE_PROVIDER.attribution;
  var NOAA_ATTRIBUTION = 'Weather: <a href="https://www.weather.gov/">NOAA / National Weather Service</a>';
  var RAINVIEWER_ATTRIBUTION = 'Radar fallback: <a href="https://www.rainviewer.com/">RainViewer</a>';
  // Must match names in sw.js. SAVED_CACHE is the old (1.0.0) prefetch cache; it is only
  // deleted now (sw.js removes it on activate, "Clear saved map" removes it too).
  var SAVED_CACHE = 'ready-map-saved-v1';
  var TILE_CACHE = 'ready-map-tiles-v1';
  var MAX_VIEWED_TILES = 500; // must match MAX_TILES in sw.js
  var PLACES_KEY = 'readyMap.places.v1';
  var DEFAULT_CENTER = [39.8283, -98.5795];
  var DEFAULT_ZOOM = 4;
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
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
  function googleSearchUrl(word, lat, lon) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(word) +
      '%20near%20' + coordStr(lat) + ',' + coordStr(lon);
  }
  function appleSearchUrl(word, lat, lon) {
    return 'https://maps.apple.com/?q=' + encodeURIComponent(word) + '&sll=' + coordStr(lat) + ',' + coordStr(lon);
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
  function parseWmsDimension(xmlText, layerName) {
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
                      String(kids[k].getAttribute('name')).toLowerCase() === 'time') { dim = kids[k]; break; }
                }
              }
            }
          }
          if (!dim) {
            var dims = doc.getElementsByTagName('Dimension');
            for (var j = 0; j < dims.length; j++) {
              if (String(dims[j].getAttribute('name')).toLowerCase() === 'time') { dim = dims[j]; break; }
            }
          }
          if (dim) { timeText = dim.textContent; def = dim.getAttribute('default'); }
        }
      } catch (e) { /* fall through to regex */ }
    }
    if (timeText === null) {
      var m = /<Dimension[^>]*name="time"[^>]*>([^<]*)<\/Dimension>/i.exec(String(xmlText));
      if (m) {
        timeText = m[1];
        var dm = /default="([^"]+)"/i.exec(m[0]);
        def = dm ? dm[1] : null;
      }
    }
    var list = expandTimeText(timeText || '');
    var defIso = null;
    if (def && !isNaN(Date.parse(def))) {
      defIso = new Date(Date.parse(def)).toISOString();
      list.push(defIso);
    }
    var uniq = Array.from(new Set(list)).sort();
    return { times: uniq, def: defIso };
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
    buildSpotUrl: buildSpotUrl,
    tilesForBounds: tilesForBounds,
    distanceMeters: distanceMeters,
    cardinal: cardinal,
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
   * action: optional { label, href } link shown after the text.
   */
  function setStatus(msg, kind, action) {
    var banner = $('status-banner');
    if (!banner) return;
    clearTimeout(statusTimer);
    clear(banner);
    if (!msg) { banner.hidden = true; return; }
    banner.appendChild(el('span', { text: msg }));
    if (action && action.href) {
      banner.appendChild(document.createTextNode(' '));
      banner.appendChild(el('a', { href: action.href, text: action.label, className: 'banner-action' }));
    }
    banner.classList.toggle('is-error', kind === 'error');
    banner.hidden = false;
    if (kind === 'ok') statusTimer = setTimeout(function () { banner.hidden = true; clear(banner); }, 6000);
    updateLayoutVars();
    if (state.map) setTimeout(function () { state.map.invalidateSize(); }, 0);
  }

  function updateLayoutVars() {
    var footer = document.querySelector('.emergency');
    if (footer) document.documentElement.style.setProperty('--footer-h', footer.offsetHeight + 'px');
  }

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

    layers.base = L.tileLayer(TILE_URL, {
      maxZoom: TILE_PROVIDER.maxZoom,
      attribution: OSM_ATTRIBUTION,
      updateWhenIdle: true,
      keepBuffer: 1,
      // CORS tiles (OSM sends Access-Control-Allow-Origin: *) so the service worker gets
      // readable responses instead of opaque ones (opaque ones waste storage quota).
      crossOrigin: 'anonymous'
    }).addTo(map);

    // Weather overlays sit above base tiles (200) and below vector overlays (400) / markers (600).
    var wxPane = map.createPane('weather');
    wxPane.style.zIndex = 350;
    wxPane.style.pointerEvents = 'none';
    var alertsPane = map.createPane('alerts');
    alertsPane.style.zIndex = 380;

    makeIcons();
    layers.places = L.layerGroup().addTo(map);
    layers.nearby = L.layerGroup().addTo(map);

    map.on('click', function (e) {
      var ll = e.latlng.wrap();
      dropPin(ll.lat, ll.lng, 'Dropped pin', 'pin');
    });
    map.on('dragstart', function () {
      if (state.follow) setFollow(false, true);
    });
    // Keyboard: Enter on the focused map drops a pin at the center.
    map.getContainer().addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target === map.getContainer()) {
        var c = map.getCenter().wrap();
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
    ['btn-copy', 'btn-share', 'btn-more'].forEach(function (id) { $(id).disabled = !has; });
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
    1: 'Location is blocked. To use GPS, allow location for this site in your browser or phone settings. Then tap Show my location again.',
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
    state.userFix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, timestamp: pos.timestamp || Date.now() };
    drawUser();
    var wasFirstFix = !layers._hadFix;
    layers._hadFix = true;
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

  function copyFailedMessage(text) {
    setStatus('Could not copy. Press and hold to copy it yourself: ' + text, 'error');
  }

  function smsHref(body) {
    // "sms:?&body=" works on both iOS and Android.
    return 'sms:?&body=' + encodeURIComponent(body);
  }

  /** Share text via the share sheet, or copy + offer a text-message link. */
  function shareText(title, text, url) {
    var full = url ? text + ' ' + url : text;
    if (navigator.share) {
      return navigator.share(url ? { title: title, text: text, url: url } : { title: title, text: text })
        .then(function () { setStatus('Shared.', 'ok'); })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return; // user closed the share sheet
          return fallbackShare(full);
        });
    }
    return fallbackShare(full);
  }

  function fallbackShare(full) {
    return copyText(full).then(function (ok) {
      setStatus(ok ? 'Copied. You can paste it in a message, or' : 'Sharing is not available here. You can', ok ? 'info' : 'error',
        { label: 'send it as a text message', href: smsHref(full) });
    });
  }

  function onCopy() {
    var p = state.selected;
    if (!p) return;
    var text = selectedText(p);
    copyText(text).then(function (ok) {
      if (ok) setStatus('Copied: ' + text, 'ok');
      else copyFailedMessage(text);
    });
  }

  function onShare() {
    var p = state.selected;
    if (!p) return;
    var label = p.label && p.label !== 'Dropped pin' ? p.label + ': ' : '';
    var text = label + selectedText(p) + '. Map: ' + googlePointUrl(p.lat, p.lon);
    shareText('Location', text);
  }

  function emergencyMessage(f) {
    return 'I need help. My location: ' + formatDecimal(f.lat, f.lon) + ' (' + toDMS(f.lat, f.lon) + '). Map: ' +
      googlePointUrl(f.lat, f.lon);
  }

  function onShareMyLocation() {
    var btn = $('btn-share-location');
    var fresh = state.userFix && Date.now() - state.userFix.timestamp < 120000;
    if (!fresh) setStatus('Getting your location to share… Please wait.', 'info');
    btn.disabled = true;
    getFixOnce().then(function (f) {
      btn.disabled = false;
      var msg = emergencyMessage(f);
      if (!fresh) {
        // The tap "permission" to open the share sheet may have expired while waiting for GPS.
        // Offer a one-tap link instead of failing.
        setStatus('Location ready.', 'info', { label: 'Tap here to text it', href: smsHref(msg) });
      }
      return shareText('I need help', msg);
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
  function around(lat, lon) { return '(around:5000,' + lat.toFixed(5) + ',' + lon.toFixed(5) + ')'; }
  var NEARBY = {
    hospital: { label: 'Hospital', word: 'hospital', letter: 'H', color: '#9F1239',
      q: function (a) { return 'nwr["amenity"="hospital"]' + a + ';'; } },
    shelter: { label: 'Shelter', word: 'emergency shelter', letter: 'S', color: '#1D4ED8',
      q: function (a) {
        return 'nwr["social_facility"="shelter"]' + a + ';' +
          'nwr["amenity"="shelter"]["emergency"~"^(yes|designated)$"]' + a + ';' +
          'nwr["emergency"="shelter"]' + a + ';';
      } },
    police: { label: 'Police', word: 'police station', letter: 'P', color: '#1E3A8A',
      q: function (a) { return 'nwr["amenity"="police"]' + a + ';'; } },
    fire: { label: 'Fire station', word: 'fire station', letter: 'F', color: '#C2410C',
      q: function (a) { return 'nwr["amenity"="fire_station"]' + a + ';'; } },
    gas: { label: 'Gas', word: 'gas station', letter: 'G', color: '#3F6212',
      q: function (a) { return 'nwr["amenity"="fuel"]' + a + ';'; } }
  };

  function openNearby(key, opener) {
    var cat = NEARBY[key];
    var p = state.selected;
    if (!cat || !p) return;
    state.nearbyCategory = key;
    $('nearby-title').textContent = cat.label + ' nearby';
    $('link-google-search').href = googleSearchUrl(cat.word, p.lat, p.lon);
    $('link-apple-search').href = appleSearchUrl(cat.word, p.lat, p.lon);
    $('nearby-status').textContent = '';
    clear($('nearby-list'));
    var cached = state.nearbyCache.get(nearbyKey(key, p));
    if (cached) renderNearby(cat, p, cached);
    openSheet('sheet-nearby', opener);
  }

  function nearbyKey(key, p) { return key + ':' + p.lat.toFixed(3) + ',' + p.lon.toFixed(3); }

  var lastOverpassAt = 0;
  function showNearbyOnMap() {
    var key = state.nearbyCategory;
    var cat = NEARBY[key];
    var p = state.selected;
    if (!cat || !p) return;
    var status = $('nearby-status');
    var ck = nearbyKey(key, p);
    if (state.nearbyCache.has(ck)) { renderNearby(cat, p, state.nearbyCache.get(ck)); return; }
    if (state.nearbyFlight) { status.textContent = 'Still looking… please wait.'; return; }
    if (!navigator.onLine) {
      status.textContent = 'You are offline, so we cannot search the map. When you have signal, use the Google Maps or Apple Maps buttons above.';
      return;
    }
    // Be polite to the shared Overpass server: at most one request every 3 seconds.
    var wait = Math.max(0, 3000 - (Date.now() - lastOverpassAt));
    var btn = $('btn-nearby-show');
    btn.disabled = true;
    status.textContent = 'Looking for ' + cat.label.toLowerCase() + ' places within 3 miles…';
    var ctrl = new AbortController();
    state.nearbyFlight = ctrl;
    setTimeout(function () {
      lastOverpassAt = Date.now();
      var query = '[out:json][timeout:15];(' + cat.q(around(p.lat, p.lon)) + ');out center 20;';
      fetchWithTimeout(OVERPASS_URL, {
        method: 'POST',
        // Simple form POST: no CORS preflight.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        credentials: 'omit'
      }, 20000, ctrl.signal).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        var items = (json.elements || []).map(function (e) {
          var lat = e.lat != null ? e.lat : e.center && e.center.lat;
          var lon = e.lon != null ? e.lon : e.center && e.center.lon;
          if (!isFinite(lat) || !isFinite(lon)) return null;
          var tags = e.tags || {};
          var addr = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' ');
          return {
            name: String(tags.name || tags.operator || ('Unnamed ' + cat.label.toLowerCase())).slice(0, 100),
            addr: addr.slice(0, 120), phone: String(tags.phone || tags['contact:phone'] || '').slice(0, 40),
            lat: lat, lon: lon, dist: distanceMeters(p.lat, p.lon, lat, lon)
          };
        }).filter(Boolean).sort(function (a, b) { return a.dist - b.dist; });
        state.nearbyCache.set(ck, items);
        if (state.nearbyCache.size > 30) state.nearbyCache.delete(state.nearbyCache.keys().next().value);
        if (state.nearbyCategory === key) renderNearby(cat, p, items);
      }).catch(function () {
        status.textContent = 'Could not load places on this map right now. Please use the Google Maps or Apple Maps buttons above.';
      }).finally(function () {
        state.nearbyFlight = null;
        btn.disabled = false;
      });
    }, wait);
  }

  function renderNearby(cat, p, items) {
    var list = $('nearby-list');
    var status = $('nearby-status');
    clear(list);
    layers.nearby.clearLayers();
    if (!items.length) {
      status.textContent = 'No ' + cat.label.toLowerCase() + ' places found within 3 miles on OpenStreetMap. Try the Google Maps or Apple Maps buttons.';
      return;
    }
    status.textContent = 'Found ' + items.length + '. Closest first. They are now on the map.';
    var group = [];
    items.forEach(function (it) {
      var icon = L.divIcon({
        className: 'nearby-icon',
        html: '<span aria-hidden="true">' + cat.letter + '</span>',
        iconSize: [30, 30], iconAnchor: [15, 15]
      });
      var marker = L.marker([it.lat, it.lon], { icon: icon, title: it.name, alt: cat.label + ': ' + it.name, keyboard: true });
      marker.on('add', function () { var n = marker.getElement(); if (n) n.style.background = cat.color; });
      marker.bindTooltip(textNode(it.name + ' (' + formatDistance(it.dist) + ')'), { direction: 'top', offset: [0, -14] });
      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        marker.openTooltip();
      });
      layers.nearby.addLayer(marker);
      group.push([it.lat, it.lon]);
      var li = el('li', null, [
        el('div', { className: 'result-name', text: it.name }),
        el('div', { className: 'result-meta', text: formatDistance(it.dist) + ' away' + (it.addr ? ' · ' + it.addr : '') }),
        it.phone ? el('a', { href: 'tel:' + it.phone.replace(/[^0-9+]/g, ''), text: 'Call ' + it.phone, className: 'btn' }) : null,
        el('div', { className: 'btn-row' }, [
          el('button', {
            type: 'button', className: 'btn', text: 'Show on map', 'aria-label': 'Show ' + it.name + ' on map',
            on: { click: function () { closeSheet('sheet-nearby', true); moveTo(it.lat, it.lon, Math.max(state.map.getZoom(), 16)); marker.openTooltip(); } }
          }),
          el('a', {
            className: 'btn', href: googleDirUrl(it.lat, it.lon), target: '_blank', rel: 'noopener noreferrer',
            text: 'Directions', 'aria-label': 'Directions to ' + it.name + ' in Google Maps'
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

  function startCompass(opener) {
    if (!('DeviceOrientationEvent' in window)) {
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
        else setStatus('Compass permission was not given. To use it, allow Motion & Orientation access in Safari settings.', 'error');
      }).catch(function () {
        setStatus('Could not turn on the compass. Please try again.', 'error');
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

    var capsCache = {}; // url -> {text, at}
    var zoneCache = new Map(); // zone url -> geometry|null

    // fallbackGen: the radar generation that already started the RainViewer fallback (one per
    // generation); fallbackFlight: the in-flight RainViewer request, if any.
    var radar = { on: false, mode: 'noaa', layer: null, frames: [], frameLayers: [], idx: 0, timer: null,
      playing: false, lastGood: null, gen: 0, errors: 0, loads: 0, fallbackGen: -1, fallbackFlight: null };
    var sat = { on: false, kind: 'goes_longwave_imagery', layer: null, lastGood: null, gen: 0 };
    var alerts = { on: false, layer: null, renderer: null, timer: null, lastGood: null, lastFetch: 0, gen: 0,
      ctrl: null, features: [], featuresKey: null, stateCode: null, stateKey: null, wholeState: false };

    function opacity(id) { return Number($(id).value) / 100; }

    function setToggle(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

    function lastUpdatedText(t) { return t ? ' Last updated ' + formatLocalTime(t) + '.' : ''; }

    function getCaps(url) {
      var c = capsCache[url];
      if (c && Date.now() - c.at < CAPS_MAX_AGE) return Promise.resolve(c.text);
      var capsUrl = url + '?service=WMS&version=1.3.0&request=GetCapabilities';
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
      return wmsLayer(RADAR_WMS, RADAR_LAYER, frame.time, opac, NOAA_ATTRIBUTION);
    }

    function radarOn() {
      radar.on = true;
      setToggle('toggle-radar', true);
      var gen = ++radar.gen;
      $('radar-note').textContent = '';
      if (!navigator.onLine) { radarOffline(); return; }
      $('time-radar').textContent = 'Loading…';
      showLegend('legend-radar', legendUrl(RADAR_WMS, RADAR_LAYER));
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
      var isNoaa = radar.mode === 'noaa';
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
      $('time-radar').textContent = formatLocalTime(latest.date);
      $('radar-frame-time').textContent = '';
      $('btn-radar-play').disabled = frames.length < 2;
      if (radar.mode === 'rainviewer') $('radar-note').textContent = 'Using backup radar (RainViewer).';
      else $('radar-note').textContent = 'Radar covers the U.S. and its territories.';
    }

    /** Switch to RainViewer. Guarded: at most one API request per radar generation. */
    function useRainViewer(gen) {
      if (gen !== radar.gen || !radar.on) return Promise.resolve();
      if (radar.fallbackFlight) return radar.fallbackFlight;
      if (radar.fallbackGen === gen) return Promise.resolve();
      if (!navigator.onLine) { radarOffline(); return Promise.resolve(); }
      radar.fallbackGen = gen;
      $('radar-note').textContent = 'NOAA radar is not loading. Trying backup radar…';
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
      radar.gen++;
      radar.fallbackFlight = null; // a late reply is ignored by its gen check
      removeRadarLayers();
      setToggle('toggle-radar', false);
      $('time-radar').textContent = 'Off';
      $('radar-note').textContent = '';
      $('radar-frame-time').textContent = '';
      $('btn-radar-play').disabled = true;
    }

    function showFrame(i) {
      var op = radarOpacity();
      radar.idx = i;
      radar.frameLayers.forEach(function (l, j) { if (l) l.setOpacity(j === i ? op : 0); });
      var f = radar.frames[i];
      $('radar-frame-time').textContent = 'Frame ' + (i + 1) + ' of ' + radar.frames.length + ': ' + formatLocalTime(f.date);
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
    }

    // ----- Satellite -----
    function satOn() {
      sat.on = true;
      setToggle('toggle-satellite', true);
      var gen = ++sat.gen;
      $('satellite-note').textContent = '';
      if (!navigator.onLine) { satProblem(); return; }
      $('time-satellite').textContent = 'Loading…';
      showLegend('legend-satellite', legendUrl(SAT_WMS, 'goes_longwave_imagery'));
      getCaps(SAT_WMS).then(function (xml) {
        if (gen !== sat.gen) return;
        var dim = parseWmsDimension(xml, sat.kind);
        var latest = dim.def || dim.times[dim.times.length - 1];
        if (!latest) throw new Error('no time');
        if (sat.layer) state.map.removeLayer(sat.layer);
        var errors = 0, loads = 0;
        sat.layer = wmsLayer(SAT_WMS, sat.kind, latest, opacity('opacity-satellite'), NOAA_ATTRIBUTION);
        sat.layer.on('tileload', function () { loads++; });
        sat.layer.on('tileerror', function () {
          errors++;
          if (errors === 3 && loads === 0 && gen === sat.gen) {
            $('satellite-note').textContent = 'Cloud pictures are not loading right now. Try again later.';
          }
        });
        sat.layer.addTo(state.map);
        sat.lastGood = new Date(latest);
        $('time-satellite').textContent = formatLocalTime(sat.lastGood);
        if (sat.kind === 'goes_visible_imagery') {
          $('satellite-note').textContent = 'Daytime pictures are dark at night. Use "Night and day" after sunset.';
        }
      }).catch(function () {
        if (gen !== sat.gen) return;
        satProblem();
      });
    }

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
          var features = (json && Array.isArray(json.features) ? json.features : []).filter(function (f) {
            return f && f.properties;
          });
          features.sort(function (a, b) { return severityRank(b.properties.severity) - severityRank(a.properties.severity); });
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
          note.textContent = 'Weather warnings are only for the United States. Move the map or your location to a U.S. spot.';
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
      // The detail sheet covers the weather sheet: stop the radar loop like closing weather does.
      stopLoop();
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
      $('btn-radar-play').addEventListener('click', function () { if (radar.playing) stopLoop(); else startLoop(); });
      $('btn-alert-more').addEventListener('click', function () {
        var d = $('alert-description');
        d.hidden = !d.hidden;
        this.textContent = d.hidden ? 'More' : 'Less';
        this.setAttribute('aria-expanded', d.hidden ? 'false' : 'true');
      });
      Array.prototype.forEach.call(document.querySelectorAll('input[name="sat-kind"]'), function (r) {
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

      sheetCloseHooks['sheet-weather'] = function () { stopLoop(); $('btn-weather').classList.toggle('is-on', radar.on || sat.on || alerts.on); };
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          stopLoop();
          clearInterval(alerts.timer);
          alerts.timer = null;
        } else if (alerts.on) {
          if (Date.now() - alerts.lastFetch > ALERT_REFRESH_MS) fetchAlerts();
          scheduleAlerts();
        }
      });
    }

    function onOnline() {
      if (radar.on && !radar.layer) radarOn();
      if (sat.on && !sat.layer) satOn();
      if (alerts.on) fetchAlerts();
    }

    return {
      init: init,
      onOnline: onOnline,
      state: { radar: radar, sat: sat, alerts: alerts }
    };
  })();

  ReadyMap.weather.state = Weather.state;

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

    $('btn-compass').addEventListener('click', function (e) { startCompass(e.currentTarget); });
    $('btn-compass-stop').addEventListener('click', function () { closeSheet('sheet-compass'); });
    sheetCloseHooks['sheet-compass'] = stopCompass;

    $('btn-weather').addEventListener('click', function (e) {
      if ($('sheet-weather').hidden) openSheet('sheet-weather', e.currentTarget); else closeSheet('sheet-weather');
    });

    window.addEventListener('resize', updateLayoutVars);
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
    initSheets();
    if (typeof L === 'undefined') {
      setStatus('The map could not load. Please reload the page.', 'error');
      return;
    }
    initMap();
    state.places = loadPlaces();
    drawPlaces();
    applyUrlParams();
    renderPoint();
    initNet();
    Weather.init();
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
