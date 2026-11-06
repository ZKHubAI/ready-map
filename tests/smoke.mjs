// Dev-only smoke test (not part of the app). Needs Chrome and a server running the app.
// usage: node tests/smoke.mjs http://127.0.0.1:8000/
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://127.0.0.1:8000/";
const bin = ["/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/bin/chromium"].find(existsSync);
const port = 9900 + Math.floor(Math.random() * 90);
const prof = mkdtempSync(join(tmpdir(), "rm-smoke-"));
const chrome = spawn(bin, ["--headless", "--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", `--remote-debugging-port=${port}`,
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
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if(d.method === 'Fetch.requestPaused') {
  const now=Math.floor(Date.now()/600000)*600;
  const body=JSON.stringify({host:'https://tilecache.rainviewer.com',radar:{past:Array.from({length:6},(_,i)=>({time:now-(5-i)*600,path:'/smoke/'+i}))}});
  send('Fetch.fulfillRequest',{requestId:d.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'}],body:Buffer.from(body).toString('base64')});
} else events.push(d); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const $click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const log = (...a) => console.log(...a);
const assert = (ok, message) => { if (ok !== true) { console.error('FAIL:', message); done(1); } };

// Only radar metadata is fixture-backed, so loop controls do not depend on a provider outage.
await send('Fetch.enable',{patterns:[{urlPattern:'https://api.rainviewer.com/public/weather-maps.json',requestStage:'Request'}]});
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true});
await send("Page.navigate", { url: base + "index.html?lat=39.7456&lon=-97.0892&zoom=8&label=Test" });
await sleep(3000);

// 1.4.5 Full map at a 390px mobile viewport. Never activate emergency actions.
assert(await ev("ReadyMap.version==='1.4.7'"), 'app reports 1.4.7');
assert(await ev("!ReadyMap.fullMap.get() && !document.body.classList.contains('full-map')"), 'full map defaults off');
const shot = async (path) => {
  const result = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
  assert(typeof result.result?.data === 'string', 'screenshot captured');
  writeFileSync(path, Buffer.from(result.result.data, 'base64'));
};
await shot(process.env.READY_MAP_CHROME_SHOT || '/workspace/ready-map-v145-chrome.png');
const mapBefore = await ev("ReadyMap.map.getSize().y");
await $click('#btn-full-map'); await sleep(500);
assert(await ev("ReadyMap.fullMap.get() && localStorage.getItem('readyMap.fullMap.v1')==='true'"), 'full map enabled and saved');
assert(await ev("ReadyMap.version==='1.4.7' && ReadyMap.mapNames.get()==='readable' && !ReadyMap.mapNames.layer()._rmFallback && !!ReadyMap.mapNames.layer().getMaplibreMap"), 'full map keeps the readable map');
assert(await ev("['.app-header','.chips','.point-card'].every(s=>getComputedStyle(document.querySelector(s)).display==='none')"), 'chrome hidden');
assert(await ev("(()=>{const r=document.querySelector('#map').getBoundingClientRect();return r.top===0 && r.left===0 && r.width===innerWidth && Math.abs(r.height-innerHeight)<2 && ReadyMap.map.getSize().y===Math.round(r.height)})()"), 'map and Leaflet fill viewport');
assert(await ev(`ReadyMap.map.getSize().y > ${mapBefore}`), 'map grows');
assert(await ev("(()=>{const b=document.querySelector('#btn-full-map');return b.textContent==='Restore controls' && b.getAttribute('aria-pressed')==='true' && b.getBoundingClientRect().width>0})()"), 'floating restore available');
assert(await ev("(()=>{const call=document.querySelector('#btn-call'),share=document.querySelector('#btn-share-location');return call.getAttribute('href')==='tel:911' && [call,share].every(b=>{const r=b.getBoundingClientRect();return r.width>0 && r.height>=44 && r.height<56 && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})})()"), 'compact emergency actions remain in viewport');
assert(await ev("getComputedStyle(document.querySelector('#btn-call')).backgroundColor===getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || getComputedStyle(document.querySelector('#btn-call')).backgroundColor==='rgb(159, 18, 57)'"), 'call remains red');
assert(await ev("getComputedStyle(document.querySelector('#btn-share-location')).backgroundColor==='rgb(232, 106, 23)'"), 'share remains orange');
await shot(process.env.READY_MAP_FULL_SHOT || '/workspace/ready-map-v145-fullmap.png');
await send('Page.reload'); await sleep(3000);
assert(await ev("ReadyMap.fullMap.get() && document.querySelector('#map').getBoundingClientRect().top===0"), 'full map survives reload');
await $click('#btn-full-map'); await sleep(500);
assert(await ev("!ReadyMap.fullMap.get() && localStorage.getItem('readyMap.fullMap.v1')==='false' && document.querySelector('.app-header').getBoundingClientRect().height>0"), 'restore returns chrome and saves off');
await send('Page.reload'); await sleep(3000);
assert(await ev("!ReadyMap.fullMap.get()"), 'off survives reload');

// Toolbar fits at 390px (no horizontal scroll); More tools menu opens
log("chips overflow:", await ev("(()=>{const n=document.querySelector('.chips');return n.scrollWidth>n.clientWidth})()"));
await $click("#btn-tools");
log("tools open:", await ev("!document.getElementById('sheet-tools').hidden"));
// 1.4.4 Map names: default is easy-to-read (OpenFreeMap Bright); Local names (OSM) can be picked and is remembered
const baseInfo = () => ev("(()=>{const l=ReadyMap.mapNames.layer();return ReadyMap.mapNames.get()+' | '+(l.options.style || l._url).split('/')[2]+' | openfreemap credit:'+/OpenFreeMap/.test(document.querySelector('.leaflet-control-attribution').innerHTML)+' | osm credit:'+/OpenStreetMap/.test(document.querySelector('.leaflet-control-attribution').innerHTML)+' | radio:'+document.querySelector('input[name=map-names]:checked').value})()");
log("map names default:", await baseInfo());
assert(await ev("ReadyMap.mapNames.get()==='readable' && !!ReadyMap.mapNames.layer().getMaplibreMap && ReadyMap.mapNames.layer().options.style.endsWith('/bright')"), 'default uses detailed OpenFreeMap Bright');
await $click("input[name=map-names][value=local]"); await sleep(500);
log("map names local:", await baseInfo(), "| saved:", await ev("localStorage.getItem('readyMap.mapNames.v1')"));
assert(await ev("ReadyMap.mapNames.layer()._url.includes('tile.openstreetmap.org') && localStorage.getItem('readyMap.mapNames.v1')==='local'"), 'original OSM selected and saved');
await $click("input[name=map-names][value=readable]"); await sleep(500);
log("map names readable:", await baseInfo(), "| saved:", await ev("localStorage.getItem('readyMap.mapNames.v1')"), "| base layers:", await ev("Object.values(ReadyMap.map._layers).filter(l=>l._rmKind && l.options.pane==='tilePane').length"));
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
await $click("input[name=radar-area][value=world]");
await $click("#toggle-radar");
await sleep(6000);
log("satellite time:", await text("#time-satellite"), "|", await text("#satellite-note"));
await $click("#btn-radar-play"); await sleep(2500);
log("loop label:", await text("#radar-frame-time"), "| frames:", await ev("ReadyMap.weather.state.radar.frames.length"));
assert(await ev("ReadyMap.weather.state.radar.frames.length > 1 && ReadyMap.weather.state.radar.playing"), "radar loop starts");
log("map loop button shown:", await ev("!document.querySelector('#btn-map-loop').hidden"));
await $click("#sheet-weather .sheet-close"); await sleep(1500);
log("loop still playing after close:", await ev("ReadyMap.weather.state.radar.playing"), "| map button:", await text("#map-loop-label"));
assert(await ev("ReadyMap.weather.state.radar.playing"), "closing Weather keeps loop playing");
await $click("#btn-map-loop");
assert(await ev("!ReadyMap.weather.state.radar.playing"), "map loop button pauses");
log("map button paused loop:", await ev("!ReadyMap.weather.state.radar.playing"), "| weather button:", await text("#btn-radar-play"));
await $click("#btn-map-loop");
assert(await ev("ReadyMap.weather.state.radar.playing"), "map loop button resumes");
log("map button played loop:", await ev("ReadyMap.weather.state.radar.playing"), "| weather button:", await text("#btn-radar-play"));

// Full map must not stop or replace the existing radar loop.
await $click('#btn-full-map'); await sleep(500);
assert(await ev("ReadyMap.weather.state.radar.playing"), 'full map preserves playing radar');
assert(await ev("(()=>{const a=document.querySelector('#btn-full-map').getBoundingClientRect(),b=document.querySelector('#btn-map-loop').getBoundingClientRect();return a.bottom<=b.top})()"), 'restore and radar controls do not overlap');
await $click('#btn-map-loop');
assert(await ev("!ReadyMap.weather.state.radar.playing"), 'radar pauses in full map');
await $click('#btn-map-loop');
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await sleep(500);
assert(await ev("!ReadyMap.fullMap.get() && ReadyMap.weather.state.radar.playing"), 'Escape restores chrome without stopping radar');

// Compass on a desktop browser (no sensor)
await $click("#btn-compass"); await sleep(4000);
log("compass:", await text("#compass-reading"), "|", await text("#status-banner"));

// Pure helpers
log("tiles world z0-2:", await ev("ReadyMap.tilesForBounds([[-85,-180],[85,180]],0,2).count"));
log("params:", await ev("JSON.stringify([ReadyMap.parseParams('?lat=91&lon=0'), ReadyMap.parseParams('?lat=1&lon=2&zoom=40'), ReadyMap.parseParams('?lat=0x10&lon=2')])"));
log("DMS rollover:", await ev("ReadyMap.toDMS(10.9999999, -0.00001)"));

// 1.4.4 Map names choice survives a reload
await ev("ReadyMap.mapNames.set('local')");
await send("Page.reload"); await sleep(3000);
log("map names after reload:", await ev("ReadyMap.mapNames.get() + ' | ' + (ReadyMap.mapNames.layer().options.style || ReadyMap.mapNames.layer()._url).split('/')[2]"));
assert(await ev("ReadyMap.mapNames.get()==='local' && ReadyMap.mapNames.layer()._url.includes('tile.openstreetmap.org')"), 'choice persists after reload');
await ev("ReadyMap.mapNames.set('readable')");

const errs = events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails?.exception?.description);
log("uncaught errors:", errs.length ? errs.join(" | ") : "none");
assert(errs.length === 0, "no uncaught errors");
done(0);
