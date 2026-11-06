// No browser required: exercise the actual full-map controller with a minimal DOM.
// Run: node tests/full-map.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('  // 1.4.5 Full map:');
const end = source.indexOf('  // ---------------------------------------------------------------------------\n  // State', start);
assert(start > 0 && end > start);
const controller = source.slice(start, end);
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS', name); }
function setup(saved = null, unavailable = false) {
  const classes = new Set(), attrs = {}, listeners = {}, writes = [], frames = [];
  let resize = 0, layout = 0, focused = 0, modal = null;
  const button = {textContent:'Full map', setAttribute:(k,v)=>attrs[k]=v,
    addEventListener:(k,v)=>listeners['button:'+k]=v, focus:()=>focused++};
  const storage = new Map(saved === null ? [] : [['readyMap.fullMap.v1', saved]]);
  const context = {
    document:{body:{classList:{toggle:(key,on)=>on ? classes.add(key) : classes.delete(key)}},
      activeElement:null, addEventListener:(k,v)=>listeners[k]=v},
    $:id=>{ assert.equal(id,'btn-full-map'); return button; },
    localStorage:{getItem:key=>{if(unavailable) throw Error('denied'); return storage.get(key) ?? null;},
      setItem:(key,val)=>{if(unavailable) throw Error('denied'); storage.set(key,val);writes.push([key,val]);}},
    requestAnimationFrame:fn=>frames.push(fn),
    state:{map:{invalidateSize:opts=>{assert.equal(opts.pan,false);resize++;}}},
    updateLayoutVars:()=>layout++, topSheet:()=>modal, ReadyMap:{}
  };
  vm.createContext(context); vm.runInContext(controller, context); context.initFullMap();
  return {context, button, attrs, classes, listeners, storage, writes,
    flush:()=>{while(frames.length) frames.shift()();},
    metrics:()=>({resize,layout,focused}), modal:value=>modal=value};
}
check('default off without writing a preference',()=>{
  const h=setup(); assert.equal(h.context.ReadyMap.fullMap.get(),false);
  assert(!h.classes.has('full-map')); assert.equal(h.button.textContent,'Full map');
  assert.equal(h.attrs['aria-pressed'],'false'); assert.equal(h.writes.length,0);
});
check('toggle on, restore, persist and resize without recentering',()=>{
  const h=setup(); h.listeners['button:click'](); h.flush();
  assert(h.classes.has('full-map')); assert.equal(h.button.textContent,'Restore controls');
  assert.equal(h.attrs['aria-pressed'],'true'); assert.equal(h.storage.get('readyMap.fullMap.v1'),'true');
  h.listeners['button:click'](); h.flush(); assert(!h.classes.has('full-map'));
  assert.equal(h.storage.get('readyMap.fullMap.v1'),'false');
  assert.equal(h.metrics().resize,3); assert.equal(h.metrics().layout,3);
});
check('saved on survives initialization',()=>assert.equal(setup('true').context.ReadyMap.fullMap.get(),true));
check('saved off survives initialization',()=>assert.equal(setup('false').context.ReadyMap.fullMap.get(),false));
check('malformed preference defaults off',()=>assert.equal(setup('invalid').context.ReadyMap.fullMap.get(),false));
check('blocked storage still allows on and off',()=>{
  const h=setup(null,true); h.listeners['button:click'](); assert(h.context.ReadyMap.fullMap.get());
  h.listeners['button:click'](); assert(!h.context.ReadyMap.fullMap.get());
});
check('Escape restores controls and focus',()=>{
  const h=setup('true'); h.listeners.keydown({key:'Escape'});
  assert(!h.context.ReadyMap.fullMap.get()); assert.equal(h.metrics().focused,1);
});
check('Escape leaves an open dialog to its own handler',()=>{
  const h=setup('true'); h.modal({id:'sheet-alert'}); h.listeners.keydown({key:'Escape'});
  assert(h.context.ReadyMap.fullMap.get());
});
check('hiding focused chrome moves focus to restore',()=>{
  const h=setup(); h.context.document.activeElement={closest:()=>true};
  h.context.ReadyMap.fullMap.set(true); assert.equal(h.metrics().focused,1);
});
check('test hook accepts only explicit true',()=>{
  const h=setup(); h.context.ReadyMap.fullMap.set('true'); assert(!h.context.ReadyMap.fullMap.get());
});
console.log(`${passed} full-map controller checks passed`);
