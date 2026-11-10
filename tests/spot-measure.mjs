// Exercise the real marine/measure controllers without browser or live network.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const nodes = new Map();
const node = () => ({textContent:'', hidden:false, children:[], appendChild(c){this.children.push(c);}, get firstChild(){return this.children[0];}, get lastChild(){return this.children.at(-1);}});
let timers=[];
const ctx = {ReadyMap:{}, state:{selected:null}, navigator:{onLine:true}, Date, Number, Math, isFinite,
  $: id => {if(!nodes.has(id)) nodes.set(id,node()); return nodes.get(id);},
  clear:n=>{n.children=[];}, el:(_,props)=>({...props}),
  WxChip:{state:{shown:null}}, distanceMeters:()=>1000,
  fToC:f=>(f-32)*5/9, cToF:c=>c*9/5+32, formatLocalTime:()=>'',
  Country:{known:()=>'',nameOf:()=>'',lookup:()=>Promise.resolve()}, officialService:()=>null,
  clearTimeout:()=>{timers=[];}, setTimeout:fn=>{timers.push(fn);},
  formatMeasure:d=>d+' m', wrapLon:n=>n, select:p=>{ctx.state.selected=p;ctx.SpotWx.update();}
};
vm.createContext(ctx);
vm.runInContext(source.match(/  var CARDINALS =[^;]+;/)[0],ctx);
vm.runInContext(source.slice(source.indexOf('  var COMPASS16 ='), source.indexOf('  /** fetch with timeout')),ctx);
for(const name of ['cardinal','degToCompass','compassWords','bearingDeg']) {
  const start=source.indexOf('  function '+name+'(');
  const end=source.indexOf('\n  }',start)+4;
  vm.runInContext(source.slice(start,end),ctx);
}
vm.runInContext(source.slice(source.indexOf('  var SpotWx ='),source.indexOf('\n  // ---------------------------------------------------------------------------\n  // 14d.')),ctx);
vm.runInContext(source.slice(source.indexOf('  var measure ='),source.indexOf('\n  // ---------------------------------------------------------------------------\n  // 13z.')),ctx);
const wx=ctx.ReadyMap.spotWeather;
const marine=wx.parseMarine({current:{sea_surface_temperature:29.6,wave_height:1.8,wave_period:10,wave_direction:224,ocean_current_velocity:1.5,ocean_current_direction:60}});
assert.equal(marine.currentKmh,1.5);assert.equal(marine.currentDeg,60);
assert.equal(wx.parseMarine({current:{}}),null);
assert(wx.marineUrl(6.8853,-87.4406).includes('ocean_current_velocity,ocean_current_direction'));
assert.equal(wx.currentLine(marine),'0.9 mph (1.5 km/h) to the east-northeast (60°)');
assert.equal(wx.parseDepth('-3187'),3187);
for(const v of [null,'',0,1,100,'NaN','-99999 missing']) assert.equal(wx.parseDepth(v),null);
assert.equal(wx.depthLine(3187),'About 3,190 m (10,460 ft), approximate depth from GEBCO (about 450 m grid), not for navigation');
assert.equal(wx.depthLine(3187,'gmrt'),'About 3,190 m (10,460 ft), approximate depth from GMRT (built on GEBCO), not for navigation');
assert.equal(wx.parseDapValue('elevation.elevation[1][1]\n[0], -60\n','elevation'),-60);
assert.equal(wx.parseDapValue('tid.tid[1][1]\n[0], 17\n','tid'),17);
assert.equal(wx.parseDapValue('Error {','elevation'),null);
assert.equal(wx.gebcoUrl('elevation',50.1,-1.5),'https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2026/ice_surface_elevation/netcdf/GEBCO_2026.nc.ascii?elevation%5B33624%5D%5B42840%5D');
assert(wx.gebcoUrl('tid',-90,180).endsWith('gebco_2026_tid.nc.ascii?tid%5B0%5D%5B0%5D'));
assert.equal(wx.depthLine(null),'');
const entry={lat:6.8853,lon:-87.4406,marine,depthM:3187,wx:null,at:Date.now()};
wx.state.cache['6.89,-87.44']=entry;
ctx.state.selected={lat:entry.lat,lon:entry.lon};wx.update();
const summary=ctx.$('point-wx').textContent;
assert.match(summary,/Sea 85°F \/ 30°C/);assert.match(summary,/Current 0.9 mph/);assert.match(summary,/Depth About 3,190 m/);
assert.equal(ctx.$('measure-spot').textContent,summary);
assert.deepEqual(ctx.$('spotwx-facts').children.filter((_,i)=>i%2===0).map(n=>n.text),['Sea temp','Waves','Current','Depth']);
ctx.ReadyMap.measure.add(6.8853,-87.4406);
ctx.ReadyMap.measure.add(7.8853,-86.4406);
assert.match(ctx.$('measure-legs').children[0].text,/northeast 45°/);
ctx.ReadyMap.measure.add(8.8853,-86.4406);
assert.equal(ctx.$('measure-legs').children.length,2);
assert.match(ctx.$('measure-legs').children[0].text,/northeast 45°/);
assert.match(ctx.$('measure-legs').children[1].text,/north 0°/);
assert.match(ctx.$('measure-spot').textContent,/Previous spot \(6.8853, -87.4406\)/);
assert.match(ctx.$('measure-spot').textContent,/Current 0.9 mph/);
assert.equal(ctx.state.selected.lat,8.8853);
// Land has no marine/depth rows; stale summaries are replaced once a result arrives.
wx.state.cache['10.00,10.00']={lat:10,lon:10,marine:null,depthM:null,wx:null,at:Date.now()};
ctx.state.selected={lat:10,lon:10};wx.update();
assert.equal(ctx.$('spotwx-facts').children.length,0);assert(ctx.$('point-wx').hidden);
for(const file of ['app.js','index.html','sw.js','README.md']) assert(readFileSync(new URL('../'+file,import.meta.url),'utf8').includes('1.5.4'));
assert.match(readFileSync(new URL('../styles.css',import.meta.url),'utf8'),/\.point-wx[^}]*white-space: normal/);
// A failed optional depth service must not discard air or marine weather.
ctx.OM_BEST={label:'best match'};
ctx.countryQuick=()=>Promise.resolve('');
ctx.omFetch=async()=>({j:{current:{temperature_2m:81,weather_code:61}},model:null});
ctx.wmoCodeText=()=> 'Rain';
ctx.FETCH_TIMEOUT_MS=100;
ctx.fetchWithTimeout=async url=>{
  if(url.includes('gmrt.org')||url.includes('dap.ceda.ac.uk')) throw Error('depth unavailable');
  return {ok:true,json:async()=>({current:{sea_surface_temperature:29.6,ocean_current_velocity:0,ocean_current_direction:0}})};
};
ctx.state.selected={lat:6,lon:-88};wx.update();
timers.at(-1)();
await new Promise(resolve=>setImmediate(resolve));
assert.match(ctx.$('point-wx').textContent,/81°F/);
assert.match(ctx.$('point-wx').textContent,/Current 0.0 mph.*north \(0°\)/);
assert(!ctx.$('point-wx').textContent.includes('Depth'));
assert.equal(wx.state.cache['6.00,-88.00'].depthM,null);
console.log('PASS marine parsing, current direction, depth, compact summaries, retained headings, land omissions and version 1.5.4');
