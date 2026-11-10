// Dev-only browser check for 1.5.4 readable-map fallback and its note (not part of the app). Needs Chrome and network.
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
setTimeout(() => { console.error("TIMEOUT"); done(3); }, 300000);
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

// Lose the readable map's WebGL canvas the way iOS Safari does under memory pressure (no restore).
const lose = "(()=>{const c=ReadyMap.mapNames.layer().getMaplibreMap().getCanvas();const g=c.getContext('webgl2')||c.getContext('webgl');const x=g&&g.getExtension('WEBGL_lose_context');if(x)x.loseContext();return !!x})()";
const note = "(()=>{const n=document.getElementById('map-names-notice');return n.hidden?'hidden':getComputedStyle(n).opacity})()";
const statusText = "document.getElementById('status-banner').hidden?'':document.getElementById('status-banner').textContent";
const overlaps = "(()=>{const n=document.getElementById('map-names-notice').getBoundingClientRect();const ids=['.leaflet-control-zoom','#btn-full-map','#btn-maps'];return ids.map(q=>document.querySelector(q)).filter(Boolean).some(e=>{const r=e.getBoundingClientRect();return r.width>0&&!(n.right<=r.left||n.left>=r.right||n.bottom<=r.top||n.top>=r.bottom)})})()";
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send("Page.navigate", { url: base + "index.html?lat=68&lon=-5&zoom=4" });
  await waitFor("typeof ReadyMap==='object' && !!ReadyMap.mapNames && !!ReadyMap.mapNames.layer()", 30000);
  assert(await ev("ReadyMap.version==='1.5.4' && document.getElementById('app-version').textContent==='1.5.4'"), `${w}px version 1.5.4`);
  await ev("localStorage.removeItem('readyMap.mapType.v1'); ReadyMap.mapType.set('streets'); ReadyMap.mapNames.set('readable')");
  assert(await waitFor("!!ReadyMap.mapNames.layer().getMaplibreMap && ReadyMap.mapNames.layer().getMaplibreMap().loaded()", 30000), `${w}px readable map loaded`);
  // Norway chart in Full map over the Norwegian Sea, as on the phone report.
  await ev("ReadyMap.mapType.set('norway'); ReadyMap.fullMap.set(true)"); await sleep(1500);
  assert(await ev(lose), `${w}px canvas lost (no restore)`);
  await sleep(5500);
  assert(await ev("ReadyMap.mapNames.get()==='readable' && !ReadyMap.mapNames.layer()._rmFallback && !!ReadyMap.mapNames.layer().getMaplibreMap"), `${w}px first lost canvas rebuilds the readable map instead of falling back`);
  assert(await ev(`${note}==='hidden' && !(${statusText}).includes('Readable map unavailable')`), `${w}px no note after a rebuild`);
  await waitFor("ReadyMap.mapNames.layer().getMaplibreMap().loaded()", 30000);
  assert(await ev(lose), `${w}px canvas lost again`);
  await sleep(5500);
  assert(await ev("!!ReadyMap.mapNames.layer()._rmFallback"), `${w}px second loss falls back to the original map`);
  assert(await ev(`${note}==='hidden' && !(${statusText}).includes('Readable map unavailable')`), `${w}px no banner or note while the Norway chart is showing`);
  assert(await waitFor(`[...document.querySelectorAll('.leaflet-charts-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0&&i.src.includes('cache.kartverket.no')).length>0`, 30000), `${w}px Norway chart tiles still showing`);
  await shot(`ready-map-v154-${tag}-${w}-chart-after-fallback.png`);
  for (const k of ['topo', 'imagery', 'worlddepth']) {
    await ev(`ReadyMap.mapType.set('${k}')`); await sleep(400);
    assert(await ev(`${note}==='hidden'`), `${w}px no note over ${k}`);
  }
  // Back to the street map: the note shows once, small, clear of the map buttons, then fades.
  await ev("ReadyMap.mapType.set('streets')"); await sleep(600);
  assert(await ev(`${note}==='1'`), `${w}px note shows on the street map`);

  assert(await ev(`(()=>{const r=document.getElementById('map-names-notice').getBoundingClientRect();return r.height<=60&&r.width<=360})()`), `${w}px note is small`);
  assert(await ev(`!${overlaps}`), `${w}px note does not cover zoom, Full map or Maps buttons`);
  await shot(`ready-map-v154-${tag}-${w}-note.png`);
  assert(await waitFor(`${note}==='hidden'`, 8000), `${w}px note fades out on its own`);
  // Exit and re-enter Full map, chart on, the note stays away; dismiss button works when shown.
  await ev("ReadyMap.mapType.set('norway')"); await sleep(400);
  assert(await ev(`${note}==='hidden'`), `${w}px note stays hidden over chart later`);
  await ev("ReadyMap.mapType.set('streets'); ReadyMap.mapNames.set('local'); ReadyMap.mapNames.set('readable')"); await sleep(300);
  await ev("ReadyMap.fullMap.set(false)"); await sleep(300);
  // Force a note on the street map and dismiss it.
  await ev("(()=>{const n=document.getElementById('map-names-notice');n.hidden=false;n.classList.add('is-showing')})()");
  await ev("document.getElementById('map-names-notice-close').click()"); await sleep(600);
  assert(await ev(`${note}==='hidden'`), `${w}px dismiss button hides the note`);
}
// Slow phone connection: the readable map's first full render takes longer than 30 s, but its style
// arrived, so it must keep loading instead of switching maps and showing a note.
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send("Network.setBypassServiceWorker", { bypass: true });
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: base + "index.html?lat=-41.3&lon=174.8&zoom=6" });
await waitFor("typeof ReadyMap==='object' && !!ReadyMap.mapNames && !!ReadyMap.mapNames.layer()", 30000);
await ev("ReadyMap.mapNames.set('local')"); await sleep(500);
await ev("caches.keys().then(k=>Promise.all(k.filter(x=>!x.includes('shell')).map(x=>caches.delete(x)))).then(()=>true)");
await send("Network.emulateNetworkConditions", { offline: false, latency: 600, downloadThroughput: 6000, uploadThroughput: 10000 });
await ev("ReadyMap.mapType.set('norway'); ReadyMap.fullMap.set(true); ReadyMap.mapNames.set('readable'); window.__gl=ReadyMap.mapNames.layer().getMaplibreMap(); window.__loadedAt=0; __gl.once('load',()=>{__loadedAt=performance.now()}); window.__t0=performance.now()");
await sleep(40000);
await waitFor('false', 1);
const slow = await ev("JSON.stringify({fb:!!ReadyMap.mapNames.layer()._rmFallback, loadedAfter: __loadedAt? Math.round((__loadedAt-__t0)/1000):null, style: !!__gl.getStyle && !!__gl.style && !!__gl.style._loaded})");
console.log('slow link:', slow);
assert(JSON.parse(slow).fb === false, 'slow link: readable map keeps loading after 40 s, no fallback');
assert(await ev(`${note}==='hidden' && !(${statusText}).includes('Readable map unavailable')`), 'slow link: no note or banner');
await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
console.log("ALL PASS"); done(0);
