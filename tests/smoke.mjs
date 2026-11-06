// Dev-only smoke test (not part of the app). Needs Chrome and a server running the app.
// usage: node tests/smoke.mjs http://127.0.0.1:8000/
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://127.0.0.1:8000/";
const bin = ["/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/bin/chromium"].find(existsSync);
const port = 9900 + Math.floor(Math.random() * 90);
const prof = mkdtempSync(join(tmpdir(), "rm-smoke-"));
const chrome = spawn(bin, ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--window-size=390,844", "about:blank"], { stdio: "ignore", detached: true });
const done = (code) => { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} process.exit(code); };
setTimeout(() => { console.error("TIMEOUT"); done(3); }, 110000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {}
  await sleep(250);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else events.push(d); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const $click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const log = (...a) => console.log(...a);

await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: base + "index.html?lat=40.7608&lon=-111.891&zoom=8&label=Test" });
await sleep(3000);

// Toolbar fits at 390px (no horizontal scroll); More tools menu opens
log("chips overflow:", await ev("(()=>{const n=document.querySelector('.chips');return n.scrollWidth>n.clientWidth})()"));
await $click("#btn-tools");
log("tools open:", await ev("!document.getElementById('sheet-tools').hidden"));
// 1.4.3 Map names: default is easy-to-read (Esri); Local names (OSM) can be picked and is remembered
const baseInfo = () => ev("(()=>{const l=ReadyMap.mapNames.layer();return ReadyMap.mapNames.get()+' | '+l._url.split('/')[2]+' | esri credit:'+/Esri/.test(document.querySelector('.leaflet-control-attribution').innerHTML)+' | osm credit:'+/OpenStreetMap/.test(document.querySelector('.leaflet-control-attribution').innerHTML)+' | radio:'+document.querySelector('input[name=map-names]:checked').value})()");
log("map names default:", await baseInfo());
await $click("input[name=map-names][value=local]"); await sleep(500);
log("map names local:", await baseInfo(), "| saved:", await ev("localStorage.getItem('readyMap.mapNames.v1')"));
await $click("input[name=map-names][value=readable]"); await sleep(500);
log("map names readable:", await baseInfo(), "| saved:", await ev("localStorage.getItem('readyMap.mapNames.v1')"), "| base layers:", await ev("Object.values(ReadyMap.map._layers).filter(l=>l instanceof L.TileLayer && l.options.pane==='tilePane').length"));
// Offline map helper (no prefetch): shows viewed-tile count
await $click("#btn-save-area"); await sleep(1500);
log("tools closed:", await ev("document.getElementById('sheet-tools').hidden"), "| offline count:", await text("#save-count"));
await $click("#sheet-save .sheet-close");

// Save a place with HTML-ish name, list, delete confirm + Escape
await $click("#btn-more");
await ev(`document.getElementById('place-name').value = '<b>Home & "x"</b>'`);
await $click("#btn-save-place");
log("places storage:", await ev("localStorage.getItem('readyMap.places.v1')"));
await $click("#btn-places");
log("places list:", await ev("document.getElementById('places-list').innerText.replace(/\\n/g,' / ')"), "| <b> injected:", await ev("!!document.querySelector('#places-list b')"));
await $click("#places-list button[aria-label^=Delete]");
log("confirm open:", await ev("!document.getElementById('sheet-confirm').hidden"), await text("#confirm-name"));
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
log("confirm closed by Esc:", await ev("document.getElementById('sheet-confirm').hidden"), "| places still open:", await ev("!document.getElementById('sheet-places').hidden"));
await $click("#sheet-places .sheet-close");

// Nearby
await $click("#btn-more");
await $click("[data-nearby=hospital]");
log("nearby links:", await ev("document.getElementById('link-google-search').href + ' | ' + document.getElementById('link-apple-search').href"));
await $click("#btn-nearby-show"); await sleep(15000);
log("nearby:", await text("#nearby-status"), "| items:", await ev("document.querySelectorAll('#nearby-list li').length"));
await $click("#sheet-nearby .sheet-close");

// Weather: satellite + radar loop
await ev("ReadyMap.map.setZoom(6)");
await $click("#btn-weather");
await $click("#toggle-satellite");
await $click("#toggle-radar");
await sleep(6000);
log("satellite time:", await text("#time-satellite"), "|", await text("#satellite-note"));
await $click("#btn-radar-play"); await sleep(2500);
log("loop label:", await text("#radar-frame-time"), "| frames:", await ev("ReadyMap.weather.state.radar.frames.length"));
log("map loop button shown:", await ev("!document.querySelector('#btn-map-loop').hidden"));
await $click("#sheet-weather .sheet-close"); await sleep(1500);
log("loop still playing after close:", await ev("ReadyMap.weather.state.radar.playing"), "| map button:", await text("#map-loop-label"));
await $click("#btn-map-loop");
log("map button paused loop:", await ev("!ReadyMap.weather.state.radar.playing"), "| weather button:", await text("#btn-radar-play"));
await $click("#btn-map-loop");
log("map button played loop:", await ev("ReadyMap.weather.state.radar.playing"), "| weather button:", await text("#btn-radar-play"));

// Compass on a desktop browser (no sensor)
await $click("#btn-compass"); await sleep(4000);
log("compass:", await text("#compass-reading"), "|", await text("#status-banner"));

// Pure helpers
log("tiles world z0-2:", await ev("ReadyMap.tilesForBounds([[-85,-180],[85,180]],0,2).count"));
log("params:", await ev("JSON.stringify([ReadyMap.parseParams('?lat=91&lon=0'), ReadyMap.parseParams('?lat=1&lon=2&zoom=40'), ReadyMap.parseParams('?lat=0x10&lon=2')])"));
log("DMS rollover:", await ev("ReadyMap.toDMS(10.9999999, -0.00001)"));

// 1.4.3 Map names choice survives a reload
await ev("ReadyMap.mapNames.set('local')");
await send("Page.reload"); await sleep(3000);
log("map names after reload:", await ev("ReadyMap.mapNames.get() + ' | ' + ReadyMap.mapNames.layer()._url.split('/')[2]"));
await ev("ReadyMap.mapNames.set('readable')");

const errs = events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails?.exception?.description);
log("uncaught errors:", errs.length ? errs.join(" | ") : "none");
done(0);
