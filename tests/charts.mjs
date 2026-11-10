// Dev-only browser check for 1.5.3 and 1.5.4 map types (not part of the app). Needs Chrome and network.
// usage: node tests/charts.mjs http://127.0.0.1:8000/   (screenshots go to READY_MAP_SHOT_DIR or /workspace)
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://127.0.0.1:8000/";
const shotDir = process.env.READY_MAP_SHOT_DIR || "/workspace";
const tag = process.env.READY_MAP_SHOT_TAG || "local";
const bin = ["/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/bin/chromium"].find(existsSync);
const port = 9900 + Math.floor(Math.random() * 90);
const prof = mkdtempSync(join(tmpdir(), "rm-charts-"));
const chrome = spawn(bin, ["--headless", "--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--window-size=1280,800", "about:blank"], { stdio: "ignore", detached: true });
const done = (code) => { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} process.exit(code); };
setTimeout(() => { console.error("TIMEOUT"); done(3); }, 240000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {}
  await sleep(250);
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const assert = (ok, message) => { if (ok !== true) { console.error('FAIL:', message, ok); done(1); } console.log('PASS', message); };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64')); };
const waitFor = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(300); } return ev(expr); };

const KINDS = { topo: 'USGS The National Map', opentopo: 'OpenTopoMap', nautical: 'NOAA Office of Coast Survey', worlddepth: 'GEBCO_2026', imagery: 'Orthoimagery' };
await send("Runtime.enable"); await send("Page.enable");
for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send("Page.navigate", { url: base + "index.html?lat=47.6&lon=-122.4&zoom=12&label=Chart%20check" });
  await sleep(3500);
  assert(await ev("ReadyMap.version==='1.5.4' && document.getElementById('app-version').textContent==='1.5.4'"), `${w}px version 1.5.4`);
  assert(await ev("ReadyMap.mapType.get()==='streets' && !ReadyMap.mapType.layer() && !!ReadyMap.mapNames.layer()"), `${w}px defaults to street map`);
  assert(await ev("(()=>{const r=document.getElementById('btn-maps').getBoundingClientRect();return r.width>=44&&r.height>=44&&r.right<=innerWidth})()"), `${w}px Maps button visible and tappable`);
  for (const [kind, credit] of Object.entries(KINDS)) {
    await ev("document.getElementById('btn-maps').click()"); await sleep(300);
    assert(await ev("!document.getElementById('sheet-maps').hidden"), `${w}px map type panel opens`);
    await ev(`document.querySelector('input[name=map-type][value=${kind}]').click()`);
    await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
    assert(await ev(`ReadyMap.mapType.get()==='${kind}' && ReadyMap.map.hasLayer(ReadyMap.mapType.layer()) && ReadyMap.map.hasLayer(ReadyMap.mapNames.layer())`), `${w}px ${kind} on, street map kept underneath`);
    assert(await waitFor(`[...document.querySelectorAll('.leaflet-charts-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0).length>0`), `${w}px ${kind} tiles loaded`);
    assert(await ev(`document.querySelector('.leaflet-control-attribution').textContent.includes(${JSON.stringify(credit)})`), `${w}px ${kind} attribution shows`);
    assert(await ev("!document.getElementById('status-banner').textContent.includes('Readable map unavailable') && document.getElementById('map-names-notice').hidden"), `${w}px no readable-map banner over ${kind}`);
    await sleep(1200); await shot(`ready-map-v154-${tag}-${w}-${kind}.png`);
  }
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.getElementById('seamarks-toggle').click()");
  await ev("document.querySelector('input[name=map-type][value=streets]').click()");
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  assert(await ev("ReadyMap.mapType.get()==='streets' && !ReadyMap.mapType.layer() && ReadyMap.mapType.seamarks.get() && ReadyMap.map.hasLayer(ReadyMap.mapType.seamarks.layer())"), `${w}px back to streets with seamarks`);
  assert(await waitFor(`[...document.querySelectorAll('.leaflet-seamarks-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0).length>0`), `${w}px seamark tiles loaded`);
  assert(await ev("document.querySelector('.leaflet-control-attribution').textContent.includes('OpenSeaMap') && !document.querySelector('.leaflet-control-attribution').textContent.includes('Coast Survey')"), `${w}px seamark attribution shows, chart credit removed`);
  assert(await ev("localStorage.getItem('readyMap.mapType.v1')==='streets' && localStorage.getItem('readyMap.seamarks.v1')==='true'"), `${w}px choices saved`);
  await shot(`ready-map-v154-${tag}-${w}-seamarks.png`);
  // 1.5.3 World depth with Seamarks on top, away from U.S. chart coverage (English Channel).
  await ev("ReadyMap.map.setView([50.1,-1.5],8,{animate:false})"); await sleep(500);
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.querySelector('input[name=map-type][value=worlddepth]').click()");
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  assert(await ev("ReadyMap.mapType.get()==='worlddepth' && ReadyMap.map.hasLayer(ReadyMap.mapType.layer()) && ReadyMap.mapType.seamarks.get() && ReadyMap.map.hasLayer(ReadyMap.mapType.seamarks.layer())"), `${w}px world depth with seamarks on top`);
  assert(await waitFor(`[...document.querySelectorAll('.leaflet-charts-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0&&i.src.includes('wms.gebco.net')).length>0 && [...document.querySelectorAll('.leaflet-seamarks-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0).length>0`, 30000), `${w}px world depth and seamark tiles loaded worldwide`);
  assert(await ev("(()=>{const t=document.querySelector('.leaflet-control-attribution').textContent;return t.includes('Imagery reproduced from the GEBCO_2026 Grid')&&t.includes('OpenSeaMap')&&t.includes('Not for navigation')})()"), `${w}px GEBCO and seamark attribution show`);
  assert(await ev("document.getElementById('btn-maps-label').textContent==='Depth'"), `${w}px Maps button says Depth`);
  await sleep(1500); await shot(`ready-map-v154-${tag}-${w}-worlddepth-seamarks.png`);
  // 1.5.3 Norway chart (Kartverket) at the Oslofjord.
  await ev("ReadyMap.map.setView([59.0,10.6],11,{animate:false})"); await sleep(400);
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.querySelector('input[name=map-type][value=norway]').click()");
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  assert(await ev("ReadyMap.mapType.get()==='norway' && ReadyMap.map.hasLayer(ReadyMap.mapType.layer())"), `${w}px Norway chart on`);
  assert(await waitFor(`[...document.querySelectorAll('.leaflet-charts-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0&&i.src.includes('cache.kartverket.no')).length>0`), `${w}px Norway chart tiles loaded`);
  assert(await ev("document.querySelector('.leaflet-control-attribution').textContent.includes('Kartverket')"), `${w}px Kartverket attribution shows`);
  await sleep(1000); await shot(`ready-map-v154-${tag}-${w}-norway.png`);
  // 1.5.3 Europe depth (EMODnet) and Australia depth (AusSeabed).
  for (const [kind, lat, lon, z, host, credit] of [['europe', 50.1, -1.5, 9, 'ows.emodnet-bathymetry.eu', 'EMODnet Bathymetry Consortium'], ['australia', -33.85, 151.6, 8, 'warehouse.ausseabed.gov.au', 'Geoscience Australia']]) {
    await ev(`ReadyMap.map.setView([${lat},${lon}],${z},{animate:false})`); await sleep(300);
    await ev("document.getElementById('btn-maps').click()"); await sleep(300);
    await ev(`document.querySelector('input[name=map-type][value=${kind}]').click()`);
    await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
    assert(await ev(`ReadyMap.mapType.get()==='${kind}' && ReadyMap.map.hasLayer(ReadyMap.mapType.layer()) && document.getElementById('btn-maps-label').textContent==='Depth'`), `${w}px ${kind} depth on`);
    assert(await waitFor(`[...document.querySelectorAll('.leaflet-charts-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0&&i.src.includes('${host}')).length>0`, 30000), `${w}px ${kind} tiles loaded`);
    assert(await ev(`(()=>{const t=document.querySelector('.leaflet-control-attribution').textContent;return t.includes(${JSON.stringify(credit)})&&t.includes('CC BY 4.0')&&t.includes('not for navigation')})()`), `${w}px ${kind} attribution shows`);
    await sleep(1200); await shot(`ready-map-v154-${tag}-${w}-${kind}.png`);
  }
  // 1.5.3 Close-up depth lines (OpenSeaMap GEBCO 2021): hint when zoomed out, tiles at zoom 12.
  await ev("ReadyMap.mapType.set('streets'); ReadyMap.map.setView([43.65,7.3],9,{animate:false})"); await sleep(300);
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.getElementById('closeup-toggle').click()"); await sleep(300);
  assert(await ev("ReadyMap.mapType.closeup.get() && !document.getElementById('closeup-hint').hidden && localStorage.getItem('readyMap.closeupContours.v1')==='true'"), `${w}px close-up lines on, zoom-in hint at zoom 9`);
  assert(await ev("[...document.querySelectorAll('#sheet-maps fieldset.map-group legend')].filter(l=>l.getBoundingClientRect().width>0).map(l=>l.textContent.trim().split(/\\s/)[0]).join(',')").then(v=>/Map,Charts,Depth,Overlays/.test(v)), `${w}px Maps panel grouped (Map type, Charts, Depth, Overlays)`);
  assert(await ev("document.documentElement.scrollWidth<=window.innerWidth+1"), `${w}px Maps panel has no sideways scroll`);
  await shot(`ready-map-v154-${tag}-${w}-panel.png`);
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  await ev("ReadyMap.map.setView([43.65,7.3],12,{animate:false})");
  assert(await waitFor(`[...document.querySelectorAll('.leaflet-contours-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0&&i.src.includes('geoserver.openseamap.org')).length>0`, 30000), `${w}px close-up depth line tiles loaded at zoom 12`);
  assert(await ev("(()=>{const t=document.querySelector('.leaflet-control-attribution').textContent;return t.includes('GEBCO 2021')&&t.includes('ODbL')&&t.includes('OpenStreetMap contributors')})() && document.getElementById('closeup-hint').hidden"), `${w}px close-up attribution shows, hint hidden`);
  await sleep(1500); await shot(`ready-map-v154-${tag}-${w}-closeup.png`);
  await ev("ReadyMap.mapType.closeup.set(false)");
  assert(await ev("!ReadyMap.mapType.closeup.layer() && !document.querySelector('.leaflet-control-attribution').textContent.includes('GEBCO 2021')"), `${w}px close-up lines off`);
  // 1.5.2 Depth lines over two map types, overview zoom and detail zoom.
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.getElementById('seamarks-toggle').checked && document.getElementById('seamarks-toggle').click()");
  await ev("document.getElementById('contours-toggle').click()");
  await ev("document.querySelector('input[name=map-type][value=streets]').click()");
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  assert(await ev("ReadyMap.mapType.contours.get() && ReadyMap.map.hasLayer(ReadyMap.mapType.contours.layer()) && localStorage.getItem('readyMap.contours.v1')==='true'"), `${w}px depth lines on and saved`);
  const linesDrawn = `[...document.querySelectorAll('.leaflet-contours-pane canvas')].filter(c=>Number(c.dataset.lines)>0).length>0 && !document.querySelector('.leaflet-contours-pane canvas[data-error]')`;
  for (const [lat, lon, z, kind] of [[47.6, -122.45, 11, 'streets'], [36, -40, 5, 'worlddepth'], [-36.8, 175.1, 9, 'opentopo']]) {
    await ev(`ReadyMap.mapType.set('${kind}'); ReadyMap.map.setView([${lat},${lon}],${z},{animate:false})`);
    assert(await waitFor(linesDrawn, 30000), `${w}px depth lines drawn at zoom ${z} over ${kind}`);
    assert(await ev("(()=>{const t=document.querySelector('.leaflet-control-attribution').textContent;return t.includes('Depth lines')&&t.includes('GEBCO_2026 Grid')})()"), `${w}px depth line attribution at zoom ${z}`);
    await sleep(800); await shot(`ready-map-v154-${tag}-${w}-contours-z${z}-${kind}.png`);
  }
  // 1.5.3 Tap for depth on different map types (open ocean, a sound with no marine model, land below sea level).
  for (const [lat, lon, kind, want] of [[36, -40, 'nautical', true], [47.6, -122.4, 'topo', true], [36.25, -116.82, 'streets', false]]) {
    await ev(`ReadyMap.mapType.set('${kind}'); ReadyMap.map.setView([${lat},${lon}],9,{animate:false}); ReadyMap.map.fire('click',{latlng:L.latLng(${lat},${lon})})`);
    if (want) {
      assert(await waitFor("document.getElementById('point-wx').textContent.includes('approximate depth from GEBCO (about 450 m grid), not for navigation')", 30000), `${w}px tap depth from GEBCO at ${lat},${lon} on ${kind}`);
    } else {
      assert(await waitFor("(()=>{const t=document.getElementById('point-wx').textContent;return /°F/.test(t)&&!t.includes('depth from')&&!t.includes('Sea ')})()", 30000), `${w}px weather for land spot below sea level loads (${lat},${lon})`);
      await sleep(6000);
      assert(await ev("!document.getElementById('point-wx').textContent.includes('depth from')"), `${w}px no depth on land below sea level (${lat},${lon})`);
    }
  }
  await shot(`ready-map-v154-${tag}-${w}-tapdepth.png`);
  await ev("ReadyMap.mapType.contours.set(false); ReadyMap.mapType.set('streets')");
  // Full map keeps the Maps button usable.
  await ev("document.getElementById('btn-full-map').click()"); await sleep(600);
  assert(await ev("ReadyMap.fullMap.get() && (()=>{const r=document.getElementById('btn-maps').getBoundingClientRect();return r.width>0&&r.bottom<innerHeight})()"), `${w}px Maps button shown in Full map`);
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.querySelector('input[name=map-type][value=nautical]').click()");
  assert(await ev("ReadyMap.mapType.get()==='nautical' && !document.getElementById('charts-note').hidden && document.getElementById('charts-note').textContent.includes('marine chart plotter')"), `${w}px nautical in Full map with reference note`);
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  await ev("document.getElementById('btn-full-map').click()"); await sleep(400);
  await ev("ReadyMap.mapType.set('streets'); ReadyMap.mapType.seamarks.set(false); localStorage.removeItem('readyMap.fullMap.v1')");
}
console.log('ALL PASS');
done(0);
