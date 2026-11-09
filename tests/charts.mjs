// Dev-only browser check for 1.5.0 map types (not part of the app). Needs Chrome and network.
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

const KINDS = { topo: 'USGS The National Map', opentopo: 'OpenTopoMap', nautical: 'NOAA Office of Coast Survey', imagery: 'Orthoimagery' };
await send("Runtime.enable"); await send("Page.enable");
for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send("Page.navigate", { url: base + "index.html?lat=47.6&lon=-122.4&zoom=12&label=Chart%20check" });
  await sleep(3500);
  assert(await ev("ReadyMap.version==='1.5.0' && document.getElementById('app-version').textContent==='1.5.0'"), `${w}px version 1.5.0`);
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
    await sleep(1200); await shot(`ready-map-v150-${tag}-${w}-${kind}.png`);
  }
  await ev("document.getElementById('btn-maps').click()"); await sleep(300);
  await ev("document.getElementById('seamarks-toggle').click()");
  await ev("document.querySelector('input[name=map-type][value=streets]').click()");
  await ev("document.querySelector('#sheet-maps .sheet-close').click()"); await sleep(300);
  assert(await ev("ReadyMap.mapType.get()==='streets' && !ReadyMap.mapType.layer() && ReadyMap.mapType.seamarks.get() && ReadyMap.map.hasLayer(ReadyMap.mapType.seamarks.layer())"), `${w}px back to streets with seamarks`);
  assert(await waitFor(`[...document.querySelectorAll('.leaflet-seamarks-pane img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0).length>0`), `${w}px seamark tiles loaded`);
  assert(await ev("document.querySelector('.leaflet-control-attribution').textContent.includes('OpenSeaMap') && !document.querySelector('.leaflet-control-attribution').textContent.includes('Coast Survey')"), `${w}px seamark attribution shows, chart credit removed`);
  assert(await ev("localStorage.getItem('readyMap.mapType.v1')==='streets' && localStorage.getItem('readyMap.seamarks.v1')==='true'"), `${w}px choices saved`);
  await shot(`ready-map-v150-${tag}-${w}-seamarks.png`);
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
