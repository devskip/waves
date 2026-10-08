// ---------- Costanti ----------
const ACTIVE_FROM = 2, DAY_START = 7, DAY_END = 19, TZ = 'Europe/Rome';
const CHART_HOURS = ['08','11','14','17'];
const SINIS = [39.97, 8.42];
const WINDY_URL = 'https://embed.windy.com/embed2.html?lat=39.97&lon=8.2&detailLat=40.03&detailLon=8.35&width=650&height=450&zoom=9&level=surface&overlay=waves&product=ecmwfWaves&menu=&message=true&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1';
const ICON = {
 back:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
 chev:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--muted);flex-shrink:0"><path d="M9 18l6-6-6-6"/></svg>',
 star:(on)=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="${on?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>`,
 bell:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>'
};

// ---------- Stato ----------
// ================= Dati: unico punto di lettura e scrittura =================
// Tutto passa da qui: salva sul telefono (IndexedDB, con localStorage come riserva)
// e, con l'account, avvisa Cloud che sincronizza con Supabase.
//  - Data.prefs: impostazioni e piccoli dati (preferito, ordine, soglia, correzioni…)
//  - Data.sessions: sessioni registrate
//  - Data.spots: spot personali
//  - le cache pesanti (catalogo spot, statistiche, previsioni) stanno solo in IndexedDB
const Data = (() => {
 const DBNAME = 'sinis-waves', VERSION = 1;
 const HEAVY = k => /^surf\.(catalog|catalogEU|osm|cache)$/.test(k) || k.startsWith('surf.stats.');
 const mem = new Map();
 let db = null;
 // subito, in modo sincrono, quello che c'è già in localStorage: l'app parte con i dati di sempre
 try{ for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k.startsWith('surf.')) mem.set(k, JSON.parse(localStorage.getItem(k))); } }catch(e){}
 const idb = (store, mode, fn) => new Promise((ok, ko) => {
  if (!db) return ok(null);
  const tx = db.transaction(store, mode), st = tx.objectStore(store); let out;
  const r = fn(st); if (r) r.onsuccess = () => { out = r.result; };
  tx.oncomplete = () => ok(out); tx.onerror = tx.onabort = () => ko(tx.error);
 });
 const persist = (k, v) => {
  const table = k === 'surf.sessions' ? 'sessions' : k === 'surf.customSpots' ? 'spots' : 'kv';
  if (table === 'kv') idb('kv', 'readwrite', st => v === undefined || v === null ? st.delete(k) : st.put(v, k)).catch(()=>{});
  else idb(table, 'readwrite', st => { st.clear(); (v || []).forEach(x => st.put(x)); }).catch(()=>{});
  // copia di riserva in localStorage per i dati piccoli
  if (!HEAVY(k)) try{ v === undefined || v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); }catch(e){}
 };
 const api = {
  ready: false,
  get(k, d){ return mem.has(k) ? mem.get(k) : d; },
  set(k, v){ mem.set(k, v); persist(k, v); window.__cloudTouch?.(k); },
  async init(){
   if (!('indexedDB' in window)) return;
   try{
    db = await new Promise((ok, ko) => {
     const r = indexedDB.open(DBNAME, VERSION);
     r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('sessions')){ const s = d.createObjectStore('sessions', {keyPath:'id'}); s.createIndex('spot_id', 'spot_id'); s.createIndex('data', 'data'); }
      if (!d.objectStoreNames.contains('spots')) d.createObjectStore('spots', {keyPath:'id'});
     };
     r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
    });
    const migrated = await idb('kv', 'readonly', st => st.get('surf._migrated'));
    if (!migrated){
     // primo avvio con IndexedDB: copio tutto quello che c'era in localStorage
     for (const [k, v] of mem){ if (k === 'surf.sessions') mem.set(k, v.map(x => x.id ? x : {...x, id: newId()})); persist(k, mem.get(k)); }
     await idb('kv', 'readwrite', st => st.put(new Date().toISOString(), 'surf._migrated'));
     for (const k of [...mem.keys()]) if (HEAVY(k)) try{ localStorage.removeItem(k); }catch(e){}   // libero spazio: le cache ora stanno solo nel database
    } else {
     // IndexedDB è la fonte principale: ricarico da lì
     const keys = await idb('kv', 'readonly', st => st.getAllKeys()) || [], vals = await idb('kv', 'readonly', st => st.getAll()) || [];
     const local = new Map(mem);   // quello che c'era in localStorage
     keys.forEach((k, i) => { if (k !== 'surf._migrated') mem.set(k, vals[i]); });
     // dati presenti solo nella copia di riserva (per esempio scritti prima dell'aggiornamento): li porto nel database
     for (const [k, v] of local) if (!keys.includes(k) && k !== 'surf.sessions' && k !== 'surf.customSpots') persist(k, v);
     const key = x => x.id || `${x.spot_id}|${x.data}|${x.ora}`;
     const merge = (a, b) => { const m = new Map(); [...a, ...b].forEach(x => { const r = x.id ? x : {...x, id: newId()}; if (!m.has(key(x))) m.set(key(x), r); }); return [...m.values()]; };
     const ses = merge((await idb('sessions', 'readonly', st => st.getAll())) || [], local.get('surf.sessions') || []);
     const sps = merge((await idb('spots', 'readonly', st => st.getAll())) || [], local.get('surf.customSpots') || []);
     mem.set('surf.sessions', ses); mem.set('surf.customSpots', sps);
     persist('surf.sessions', ses); persist('surf.customSpots', sps);
    }
    if (navigator.storage?.persist) navigator.storage.persist().catch(()=>{});  // chiede a Safari di non cancellare i dati
   }catch(e){ console.warn('IndexedDB non disponibile, uso localStorage', e); db = null; }
   api.ready = true;
  },
  sessions: {
   all: () => api.get('surf.sessions', []),
   bySpot: id => api.get('surf.sessions', []).filter(x => x.spot_id === id),
   add(row){ const r = {id: newId(), created: new Date().toISOString(), ...row}; api.set('surf.sessions', [...api.sessions.all(), r]); return r; }
  },
  spots: {
   all: () => api.get('surf.customSpots', []),
   save(sp){ sp.updated = new Date().toISOString(); const l = api.spots.all(), i = l.findIndex(x => x.id === sp.id); api.set('surf.customSpots', i < 0 ? [...l, sp] : l.map(x => x.id === sp.id ? sp : x)); },
   remove(id){ api.set('surf.customSpots', api.spots.all().filter(x => x.id !== id)); window.__cloudRemoveSpot?.(id); }
  },
  boards: {
   all: () => api.get('surf.boards', []),
   save(b){ b.updated = new Date().toISOString(); const l = api.boards.all(), i = l.findIndex(x => x.id === b.id); api.set('surf.boards', i < 0 ? [...l, b] : l.map(x => x.id === b.id ? b : x)); },
   remove(id){ api.set('surf.boards', api.boards.all().filter(x => x.id !== id)); window.__cloudRemoveBoard?.(id); }
  },
  // copia completa dei dati, per il backup
  exportAll(){ const o = {}; for (const [k, v] of mem) if (!HEAVY(k)) o[k] = v; return {app:'sinis-waves', exported:new Date().toISOString(), data:o}; }
 };
 function newId(){ return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
 return api;
})();
const store = {get: (k, d) => Data.get(k, d), set: (k, v) => Data.set(k, v)};
let baseSpots = [], spots = [], data = {}, userPos = null, lastTab = 'spot';
let threshold = store.get('surf.threshold', 3);
let followed = store.get('surf.followed', null);
let favorite = store.get('surf.favorite', null);
let mapDay = 'now', mapSel = null, leaf = null, leafPins = {}, curDetail = null;

// ---------- Calcoli (stessa logica di alert_telegram.py) ----------
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const angDiff = (a,b)=>{ let d = Math.abs(a-b)%360; return d>180 ? 360-d : d; };
const DIR16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];
const DIR16_LONG = ['nord','nord-nord-est','nord-est','est-nord-est','est','est-sud-est','sud-est','sud-sud-est','sud','sud-sud-ovest','sud-ovest','ovest-sud-ovest','ovest','ovest-nord-ovest','nord-ovest','nord-nord-ovest'];
const dirIndex = d => Math.round((((d%360)+360)%360)/22.5)%16;
const cardinal = d => DIR16[dirIndex(d)];

function evaluate(spot, s, i){
 let hs = s.hs[i], dir = s.dir[i], T = s.per[i];
 if (hs == null || dir == null || T == null) return null;
 if (s.sh[i] != null && s.sh[i] >= 0.5*hs && s.sd[i] != null && s.sp[i] != null){ dir = s.sd[i]; T = Math.max(T, s.sp[i]); }
 const d = angDiff(dir, spot.facing);
 const dirF = d <= spot.window ? 1 : d >= spot.window+35 ? 0 : 1-(d-spot.window)/35;
 const face = hs * dirF * clamp(0.75+(T-6)*0.06, 0.6, 1.3) * (spot.gain ?? 1);
 let hScore;
 if (face < spot.min) hScore = 0.3*face/spot.min;
 else if (face <= spot.max) hScore = 0.6 + 0.4*Math.min(1,(face-spot.min)/((spot.max-spot.min)*0.6));
 else hScore = Math.max(0, 1-(face-spot.max)/spot.max);
 const periodF = T >= spot.minPeriod ? 1 : clamp((T-3)/(spot.minPeriod-3), 0.2, 1);
 const ws = s.ws[i] ?? 0, wd = s.wd[i] ?? 0;
 const dw = angDiff(wd, spot.offshore);
 const windType = ws < 8 ? 'debole' : dw <= 45 ? 'offshore' : dw <= 110 ? 'laterale' : 'onshore';
 let windF = 1;
 if (windType === 'offshore') windF = ws <= 35 ? 1 : 0.7;
 else if (windType === 'laterale') windF = clamp(1-(ws-8)/35, 0.35, 1);
 else if (windType === 'onshore') windF = clamp(1-(ws-8)/22, 0.1, 1);
 const score = Math.min(5, Math.round(5*hScore*periodF*windF*2)/2);
 return {score, face, hs, dir, T, ws, wd, windType, windF, periodF};
}

function tone(sc){
 if (sc == null || sc < 1.5) return ['var(--s0)','#D5D8D4'];
 if (sc < 2.5) return ['var(--s1)','#171717'];
 if (sc < 3.5) return ['var(--s2)','#171717'];
 if (sc < 4.5) return ['var(--s3)','#171717'];
 return ['var(--s4)','#171717'];
}
const LEVELS = [
 {c:'var(--s0)', t:'Non surfabile', r:'0–1'},
 {c:'var(--s1)', t:'Scarso', r:'1.5–2'},
 {c:'var(--s2)', t:'Discreto', r:'2.5–3'},
 {c:'var(--s3)', t:'Buono', r:'3.5–4'},
 {c:'var(--s4)', t:'Ottimo', r:'4.5–5'},
];
const legendHtml = (extra='') => `<div class="legend">${LEVELS.map(l=>`<span><i style="--c:${l.c}"></i><b>${l.t}<em>${l.r}</em></b></span>`).join('')}${extra}</div>`;
const THR = {
 2.5:{t:'Anche giornate al limite', d:"Onda nel range dello spot ma penalizzata: vento laterale o onshore, periodo corto, oppure mare un po' troppo grosso.", f:'Molti avvisi, qualcuno a vuoto.'},
 3:{t:'Giornate surfabili', d:'Onda almeno al minimo del range dello spot, con periodo e vento che non la rovinano.', f:'Il giusto equilibrio: è la soglia consigliata.'},
 3.5:{t:'Giornate buone', d:'Onda ben formata dentro il range, non solo al minimo, con vento debole o offshore.', f:'Meno avvisi, più affidabili.'},
 4:{t:'Solo giornate belle', d:'Onda comoda nel range, periodo sopra il minimo dello spot e vento debole o offshore.', f:'Pochi avvisi, quasi sempre da non perdere.'}
};
function favWave(face){
 const W = 400, H = 78;
 const flat = face == null || face < 0.3;
 const layer = (base, amp, period, cls, fill) => {
  if (flat) return `<rect x="0" y="${base}" width="${W}" height="${H-base}" fill="${fill}"/>`;
  let d = `M0 ${base} Q${period/4} ${base-2*amp} ${period/2} ${base}`;
  for (let x = period; x <= W*2; x += period/2) d += ` T${x} ${base}`;
  return `<path class="${cls}" d="${d} L${W*2} ${H} L0 ${H}Z" fill="${fill}"/>`;
 };
 const a = flat ? 0 : 3 + 7*Math.min(face, 2.5)/2.5;
 const speed = flat ? '' : ` style="--d1:${(16 - Math.min(face,2.5)*2.4).toFixed(1)}s;--d2:${(11 - Math.min(face,2.5)*1.6).toFixed(1)}s"`;
 return `<svg class="favwave" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"${speed}>
  ${layer(40, a, 200, 'w1', 'rgba(156,192,211,.10)')}${layer(56, a*.7, 160, 'w2', 'rgba(156,192,211,.09)')}</svg>`;
}
const FAV_WAVE = '<svg class="favwave" viewBox="0 0 400 78" preserveAspectRatio="none" aria-hidden="true"><path d="M0 38 C50 18 100 58 150 38 S250 18 300 38 S370 54 400 32 V78 H0Z" fill="rgba(156,192,211,.10)"/><path d="M0 54 C60 40 110 68 170 54 S280 38 330 54 S385 62 400 50 V78 H0Z" fill="rgba(156,192,211,.09)"/></svg>';
const GRIP = '<svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1.7"/><circle cx="10" cy="4" r="1.7"/><circle cx="4" cy="10" r="1.7"/><circle cx="10" cy="10" r="1.7"/><circle cx="4" cy="16" r="1.7"/><circle cx="10" cy="16" r="1.7"/></svg>';
const scoreLabel = sc => sc == null ? 'Nessun dato' : sc < 1.5 ? 'Non surfabile' : sc < 2.5 ? 'Scarso' : sc < 3.5 ? 'Discreto' : sc < 4.5 ? 'Buono' : 'Ottimo';

function nowKey(){
 const p = new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).format(new Date());
 return p.replace(' ','T').slice(0,13)+':00';
}
const todayIso = () => nowKey().slice(0,10);
const currentIndex = s => Math.max(0, s.time.indexOf(nowKey()));
function distanceKm(a,b){
 const R=6371, r=Math.PI/180, dLat=(b.lat-a.lat)*r, dLon=(b.lon-a.lon)*r;
 const x=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;
 return 2*R*Math.asin(Math.sqrt(x));
}
const beach = sp => sp.beachLat ? {lat:sp.beachLat, lon:sp.beachLon} : sp;
const isFollowed = sp => followed ? followed.includes(sp.id) : !!sp.alert;
const nowEval = sp => { const s = data[sp.id]; return s ? evaluate(sp, s, currentIndex(s)) : null; };

// ---------- Testi ----------
const esc = t => String(t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wdFmt = new Intl.DateTimeFormat('it-IT',{weekday:'long', timeZone:'UTC'});
const weekday = iso => { const t = wdFmt.format(new Date(iso+'T12:00:00Z')); return t.charAt(0).toUpperCase()+t.slice(1); };
const dayLabel = iso => iso === todayIso() ? 'Oggi' : weekday(iso);
const dayShort = iso => iso === todayIso() ? 'Oggi' : weekday(iso).slice(0,3);
const dayChip = iso => iso === todayIso() ? 'Oggi' : `${weekday(iso).slice(0,3)} ${+iso.slice(8,10)}`;

// ---------- Dati ----------
async function getJson(url, opts={}, tries=2, ms=20000){
 for (let k = 1; ; k++){
  const ctrl = new AbortController(), timer = setTimeout(()=>ctrl.abort(), ms);
  try{
   const r = await fetch(url, {...opts, signal:ctrl.signal});
   if (!r.ok) throw new Error(`${new URL(url, location.href).hostname} ha risposto ${r.status}`);
   return await r.json();
  }catch(e){
   if (k >= tries) throw e.name === 'AbortError' ? new Error(`${new URL(url, location.href).hostname} non risponde`) : e;
  }finally{ clearTimeout(timer); }
 }
}
// spot ufficiali: dal database (visibili a tutti, anche senza account); spots.json resta come riserva
// e per gli spot che non fossero ancora stati portati nel database
const dbSpot = r => ({id: r.id, name: r.name, area: r.area || '', lat: +r.lat, lon: +r.lon,
 beachLat: r.beach_lat ?? undefined, beachLon: r.beach_lon ?? undefined, facing: +r.facing, window: +r.window, offshore: +r.offshore,
 min: +r.min, max: +r.max, minPeriod: +r.min_period, gain: +r.gain || 1, alert: !!r.alert_default, cams: r.cams || [],
 kind: r.kind || null, access: r.access || null, bigOnly: !!r.big_only});
let spotsFresh = false;
async function loadSpots(){
 let fromDb = [], fromFile = [];
 try{
  const rows = await getJson(`${SUPA_URL}/rest/v1/spots?select=*&visibility=eq.public&order=created_at`, {headers:{apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`}}, 1, 15000);
  fromDb = rows.map(dbSpot);
  if (fromDb.length) store.set('surf.officialSpots', fromDb);
 }catch(e){ fromDb = store.get('surf.officialSpots', []); console.warn('Spot dal database non disponibili', e); }
 try{ fromFile = (await getJson('spots.json', {cache:'no-cache'}, 1)).spots; }catch(e){}
 const ids = new Set(fromDb.map(s => s.id));
 baseSpots = [...fromDb, ...fromFile.filter(s => !ids.has(s.id))];
 if (!baseSpots.length) throw new Error('elenco spot non disponibile');
 const official = new Set(baseSpots.map(s => s.id));
 const mine = Data.spots.all().filter(s => !official.has(s.id));   // uno spot personale diventato ufficiale non si ripete
 spots = [...baseSpots, ...mine];
 applyGains();
 spotsFresh = true;
 store.set('surf.baseSpots', baseSpots);   // serve a mostrare la Home subito, alla prossima apertura
}
// correzioni personali dalla taratura: valgono sopra a quella dello spot
function applyGains(){
 const g = store.get('surf.gain', {});
 spots.forEach(sp => { if (g[sp.id] != null) sp.gain = g[sp.id]; });
}

async function fetchForecast(){
 const lat = spots.map(s=>s.lat).join(','), lon = spots.map(s=>s.lon).join(',');
 const q = `latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(TZ)}&forecast_days=7&past_days=3`;
 let [m, w] = await Promise.all([
  getJson(`https://marine-api.open-meteo.com/v1/marine?${q}&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`),
  getJson(`https://api.open-meteo.com/v1/forecast?${q}&hourly=wind_speed_10m,wind_direction_10m`)
 ]);
 if (!Array.isArray(m)) m = [m];
 if (!Array.isArray(w)) w = [w];
 const out = {};
 spots.forEach((sp,k)=>{
  const mh = m[k].hourly, wh = w[k].hourly;
  const wi = new Map(wh.time.map((t,i)=>[t,i]));
  const pick = (arr,t)=>{ const i = wi.get(t); return i == null ? null : arr[i]; };
  out[sp.id] = {time:mh.time, hs:mh.wave_height, dir:mh.wave_direction, per:mh.wave_period,
   sh:mh.swell_wave_height, sd:mh.swell_wave_direction, sp:mh.swell_wave_period,
   ws:mh.time.map(t=>pick(wh.wind_speed_10m,t)), wd:mh.time.map(t=>pick(wh.wind_direction_10m,t))};
 });
 return out;
}

// migliore situazione di ogni giorno, nelle ore di luce, da adesso in poi
function forecastDays(sp){
 const s = data[sp.id]; if (!s) return [];
 const days = {};
 for (let i = currentIndex(s); i < s.time.length; i++){
  const h = +s.time[i].slice(11,13); if (h < DAY_START || h > DAY_END) continue;
  const ev = evaluate(sp, s, i); if (!ev) continue;
  const day = s.time[i].slice(0,10);
  const d = days[day] ||= {day, best:null, bestHour:null, firstHit:null, minFace:Infinity, maxFace:0};
  if (!d.best || ev.score > d.best.score){ d.best = ev; d.bestHour = h; }
  if (ev.score >= threshold && d.firstHit == null) d.firstHit = h;
  d.minFace = Math.min(d.minFace, ev.face); d.maxFace = Math.max(d.maxFace, ev.face);
 }
 return Object.values(days);
}
function upcomingAlerts(){
 const hits = [];
 spots.filter(isFollowed).forEach(sp => forecastDays(sp).forEach(d => { if (d.firstHit != null) hits.push({sp, d}); }));
 return hits.sort((a,b)=> a.d.day.localeCompare(b.d.day) || b.d.best.score - a.d.best.score);
}
function allDays(){
 const s = Object.values(data)[0]; if (!s) return [];
 return [...new Set(s.time.map(t=>t.slice(0,10)))].filter(d=>d >= todayIso()).slice(0,7);
}

// ---------- Componenti ----------
function badge(sc, size=''){
 const [bg,fg] = tone(sc);
 return `<span class="badge ${size}" style="--c:${bg};--fg:${fg}" aria-label="Punteggio ${sc ?? 'non disponibile'} su 5">${sc ?? '–'}</span>`;
}
function pt(c,r,deg){ const a=deg*Math.PI/180; return [+(c+r*Math.sin(a)).toFixed(1), +(c-r*Math.cos(a)).toFixed(1)]; }
function dial(sp, ev, px=56){
 const big = px >= 100, a0 = sp.facing-sp.window, a1 = sp.facing+sp.window;
 const [x0,y0]=pt(28,22,a0), [x1,y1]=pt(28,22,a1);
 let arrows = '';
 if (ev){
  const pxy = (cx,cy,r,deg)=>{ const a=deg*Math.PI/180; return [+(cx+r*Math.sin(a)).toFixed(1), +(cy-r*Math.cos(a)).toFixed(1)]; };
  const [sx,sy]=pt(28,22,ev.dir), [ex,ey]=pt(28,5.5,ev.dir);
  const [h1x,hy1]=pxy(ex,ey,6,ev.dir+35), [h2x,hy2]=pxy(ex,ey,6,ev.dir-35);
  arrows += `<path class="sw" stroke-width="${big?1.8:3}" d="M${sx},${sy} L${ex},${ey}"/><path class="swh" d="M${ex},${ey} L${h1x},${hy1} L${h2x},${hy2}Z"/>`;
  if (ev.ws >= 3){ const [wx,wy]=pt(28,20,ev.wd), [wx2,wy2]=pt(28,10,ev.wd); arrows += `<path class="wd" stroke-width="${big?1.2:2}" stroke-dasharray="${big?'2 2':'3 3'}" d="M${wx},${wy} L${wx2},${wy2}"/>`; }
 }
 const label = ev ? `Swell da ${cardinal(ev.dir)}, vento da ${cardinal(ev.wd)}, finestra utile da ${cardinal(a0)} a ${cardinal(a1)}` : 'Nessun dato';
 return `<svg class="dial" width="${px}" height="${px}" viewBox="0 0 56 56" role="img" aria-label="${label}">
  <circle class="ring" cx="28" cy="28" r="22" stroke-width="${big?0.8:1.5}"/>
  <path class="win" stroke-width="${big?4:6}" d="M${x0},${y0} A22,22 0 ${sp.window*2>180?1:0} 1 ${x1},${y1}"/>
  ${big?'<text x="28" y="5" text-anchor="middle">N</text>':''}${arrows}</svg>`;
}

// ---------- Home ----------
function renderSpot(){
 // preferito
 const fav = spots.find(s=>s.id===favorite), favEl = document.getElementById('fav');
 if (fav && data[fav.id]){
  const ev = nowEval(fav), days = forecastDays(fav).slice(0,5);
  const inWin = ev && angDiff(ev.dir, fav.facing) <= fav.window;
  favEl.innerHTML = `<button class="fav" data-open="${fav.id}">
   <div class="top"><div class="grow">
    <p class="k">${ICON.star(true)}Il tuo spot</p>
    <p class="name">${esc(fav.name)}</p>
    <p class="area">${esc(metaLine(fav))}</p></div>
    <div class="fside">${gaugeWithScore(fav, ev, 128)}</div></div>
   ${ev ? `<p class="meas">${ev.face.toFixed(1)}m a riva · ${Math.round(ev.T)}s</p>
   <p class="fk"><i style="background:${GC.light.swell}"></i>swell da ${cardinal(ev.dir)}, ${Math.round(ev.dir)}°</p>
   <p class="fk"><i style="background:${GC.light.wind}"></i>${ev.ws < 3 ? 'vento quasi assente' : `${Math.round(ev.ws)}km/h da ${cardinal(ev.wd)}`}</p>` : '<p class="meas">Nessun dato</p>'}
   <div class="days">${days.map(d=>`<div><span>${dayShort(d.day)}</span>${badge(d.best.score,'xs')}<span>${d.maxFace.toFixed(1)}m</span></div>`).join('')}</div>
  </button>`;
 } else {
  favEl.innerHTML = `<div class="favhint">${ICON.star(false)}<span>Apri uno spot e tocca "Preferito" per averlo sempre qui in cima.</span></div>`;
 }

 const rows = spots.map(sp=>({sp, ev:nowEval(sp), dist:userPos ? distanceKm(userPos, beach(sp)) : null}));
 const order = store.get('surf.order', null);
 const pos = id => { const i = order ? order.indexOf(id) : -1; return i < 0 ? Infinity : i; };
 const byScore = (a,b)=>(b.ev?.score ?? -1)-(a.ev?.score ?? -1);
 rows.sort((a,b)=> order ? ((pos(a.sp.id)-pos(b.sp.id)) || byScore(a,b)) : byScore(a,b));
 const km = d => d == null ? '' : d < 1 ? `${Math.round(d*1000/50)*50}m` : `${d < 10 ? d.toFixed(1) : Math.round(d)}km`;
 const gripHtml = sp => `<span class="grip" role="button" tabindex="0" aria-label="Sposta ${esc(sp.name)}: frecce su e giù">${GRIP}</span>`;
 const fullRow = (r, g) => `<div class="item" data-id="${r.sp.id}">${g ? gripHtml(r.sp) : ''}<button class="row" data-open="${r.sp.id}"><span class="dtile">${comboGauge(r.sp, r.ev, 46)}</span>
   <div class="grow"><p class="name">${esc(r.sp.name)}</p>
    <p class="xs muted" style="margin-top:2px">${esc(metaLine(r.sp))}${r.dist!=null?`, ${km(r.dist)}`:''}</p>
    <p class="xs muted">Vento ${r.ev.windType} ${Math.round(r.ev.ws)}km/h</p></div>
   <div class="num"><p class="h">${r.ev.face.toFixed(1)}<span>m</span></p><p class="xs muted" style="margin-top:2px">${Math.round(r.ev.T)}s, ${cardinal(r.ev.dir)}</p></div>
   ${badge(r.ev.score)}</button></div>`;
 const miniRow = (r, g) => `<div class="item" data-id="${r.sp.id}">${g ? gripHtml(r.sp) : ''}<button class="mini" data-open="${r.sp.id}"><span class="grow"><b>${esc(r.sp.name)}</b><small>${r.ev ? offReason(r.sp, r.ev) : 'Nessun dato'}${r.dist!=null?`, ${km(r.dist)}`:''}</small></span>${badge(r.ev?.score,'sm')}</button></div>`;
 const isOn = r => (r.ev?.score ?? 0) >= ACTIVE_FROM;

 // vicino a te: spot entro il raggio scelto, dal più vicino
 const nearKm = store.get('surf.nearKm', 5), box = document.getElementById('nearBox');
 const near = userPos ? rows.filter(r=>r.dist <= nearKm).sort((a,b)=>a.dist-b.dist) : [];
 const nearIds = new Set(near.map(r=>r.sp.id));
 box.hidden = !userPos;
 if (userPos){
  document.getElementById('kmChips').innerHTML = [5,15,30].map(k=>`<button data-km="${k}" aria-pressed="${k===nearKm}">${k}km</button>`).join('');
  const closest = [...rows].sort((a,b)=>a.dist-b.dist)[0];
  document.getElementById('nearList').innerHTML = near.length
   ? near.map(r => isOn(r) ? fullRow(r, false) : miniRow(r, false)).join('')
   : `<p class="empty">Nessuno spot entro ${nearKm}km da te.${closest ? ` Il più vicino è ${esc(closest.sp.name)}, a ${km(closest.dist)}.` : ''}</p>`;
 }
 renderOsm();
 document.getElementById('activeTitle').textContent = userPos ? 'Gli altri spot attivi' : 'Attivi ora';
 document.getElementById('offTitle').textContent = userPos ? 'Gli altri spot non attivi ora' : 'I miei spot non attivi ora';

 const rest = rows.filter(r=>!nearIds.has(r.sp.id));
 const on = rest.filter(isOn), off = rest.filter(r=>!isOn(r));
 document.getElementById('activeList').innerHTML = on.length ? on.map(r=>fullRow(r, true)).join('')
  : `<p class="muted small">Nessuno spot attivo adesso.</p>`;
 document.getElementById('offList').innerHTML = off.map(r=>miniRow(r, true)).join('');
 document.getElementById('offAcc').hidden = !off.length; document.getElementById('offCnt').textContent = off.length;
 updateOrderUi();

 // onde in arrivo: le prime giornate in condizione tra gli spot che segui, in schede che scorrono di lato
 const hits = upcomingAlerts().slice(0, 6), b = document.getElementById('banner');
 if (hits.length){
  const WTC = {offshore:['#2F5F1A','#E3EEDB'], debole:['#2F5F1A','#E3EEDB'], laterale:['#8A5A24','#FBEFD9'], onshore:['#8A3A2A','#F7DDD6']};
  const card = h => { const e = h.d.best, [bg,fg] = tone(e.score), [tf,tb] = WTC[e.windType] || WTC.laterale;
   const wind = e.ws < 3 ? 'quasi assente' : `${Math.round(e.ws)}km/h da ${cardinal(e.wd)}`;
   return `<button class="bcrd" data-open="${h.sp.id}"><span class="bt"><span><b class="bd">${dayLabel(h.d.day)}</b><i>dalle ${h.d.firstHit}</i></span><span class="bsc" style="--c:${bg};--fg:${fg}" aria-label="Punteggio ${e.score} su 5">${e.score}</span></span>
    <b class="bn">${esc(h.sp.name)}</b><span class="bh">${h.d.maxFace.toFixed(1)}m<small> · ${Math.round(e.T)}s</small></span>
    <span class="bl"><i style="background:var(--blue)"></i><span>swell da ${cardinal(e.dir)}</span><i style="background:#EC8D2C"></i><span>${wind} <em style="color:${tf};background:${tb}">${e.windType}</em></span></span></button>`; };
  b.hidden = false;
  b.innerHTML = `<div class="lhead"><h2>Onde in arrivo</h2><button class="linkbtn" data-tab="alert">Vedi tutti →</button></div><div class="bsl" id="bsl">${hits.map(card).join('')}</div>${hits.length > 1 ? `<div class="bdots" id="bdots">${hits.map((_,i)=>`<i${i ? '' : ' class="on"'}></i>`).join('')}</div>` : ''}`;
  const sl = document.getElementById('bsl');
  if (sl && hits.length > 1) sl.addEventListener('scroll', () => { const w = sl.firstElementChild.offsetWidth + 10, end = sl.scrollLeft + sl.clientWidth >= sl.scrollWidth - 4, i = end ? hits.length-1 : Math.min(hits.length-1, Math.round(sl.scrollLeft / w)); document.querySelectorAll('#bdots i').forEach((d,k) => d.classList.toggle('on', k === i)); }, {passive:true});
 } else b.hidden = true;
}
// ---------- Spot pubblici da OpenStreetMap ----------
let osm = {key:null, state:'idle', list:[]};
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function loadOsm(){
 if (!userPos) return;
 const km = store.get('surf.nearKm', 5);
 const key = `${userPos.lat.toFixed(2)},${userPos.lon.toFixed(2)},${km}`;
 if (osm.key === key && osm.state !== 'error') return;
 const cached = store.get('surf.osm', {})[key];
 if (cached && Date.now() - cached.at < 24*3600*1000){ osm = {key, state:'ok', list:cached.list}; renderSpot(); return; }
 osm = {key, state:'loading', list:[]}; renderSpot();
 const q = `[out:json][timeout:25];nwr["sport"~"(^|;)surfing(;|$)"][!"shop"][!"amenity"][!"building"](around:${km*1000},${userPos.lat.toFixed(5)},${userPos.lon.toFixed(5)});out center tags 80;`;
 let res = null, lastErr = null;
 for (const url of OVERPASS){
  try{ res = await getJson(`${url}?data=${encodeURIComponent(q)}`, {}, 1); break; }catch(e){ lastErr = e; }
 }
 if (osm.key !== key) return;
 if (!res){ osm = {key, state:'error', list:[], msg:lastErr?.message}; renderSpot(); return; }
 const list = res.elements.map(el=>{
  const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  return {osmId:`${el.type}/${el.id}`, lat:+lat.toFixed(5), lon:+lon.toFixed(5), name: t.name || t.loc_name || t['name:it'] || t['name:en'] || null,
   kind: t.natural === 'reef' || /reef|point/i.test(t.surfing || '') ? 'reef' : t.natural === 'beach' ? 'beach' : null};
 }).filter(Boolean)
  // niente doppioni con gli spot che hai già (entro 400m)
  .filter(o => !spots.some(sp => distanceKm(o, beach(sp)) < 0.4))
  .map(o => ({...o, dist: distanceKm(userPos, o)}))
  .sort((a,b)=>a.dist-b.dist);
 const uniq = list.filter((o,i)=> !list.slice(0,i).some(x=>distanceKm(x,o) < 0.15)).slice(0,15);
 const all = store.get('surf.osm', {}); all[key] = {at:Date.now(), list:uniq};
 const keys = Object.keys(all); if (keys.length > 20) delete all[keys[0]];
 store.set('surf.osm', all);
 osm = {key, state:'ok', list:uniq}; renderSpot();
}
function renderOsm(){
 const box = document.getElementById('osmBox'); if (!box || !userPos) return;
 const km = store.get('surf.nearKm', 5), attr = '<p class="attr">Dati © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. Se conosci uno spot che manca, puoi aggiungerlo tu su OpenStreetMap.</p>';
 const kindLabel = k => k === 'reef' ? 'Reef o punta' : k === 'beach' ? 'Spiaggia' : 'Spot';
 const dist = d => d < 1 ? `${Math.round(d*1000/50)*50}m` : `${d < 10 ? d.toFixed(1) : Math.round(d)}km`;
 let body;
 if (osm.state === 'loading') body = '<p class="small muted">Cerco spot pubblici nella zona…</p>';
 else if (osm.state === 'error') body = `<p class="small muted">Elenco pubblico non raggiungibile adesso${osm.msg ? ` (${esc(osm.msg)})` : ''}.</p><button class="pillbtn" data-osmretry style="margin-top:6px">Riprova</button>`;
 else if (!osm.list.length) body = `<p class="small muted">Nessun altro spot segnato entro ${km}km.${km < 30 ? ' Prova ad allargare il raggio.' : ''}</p>`;
 else body = osm.list.map((o,i)=>`<div class="osmrow"><div class="grow"><b>${esc(o.name || 'Spot senza nome')}</b><span class="xs muted">${kindLabel(o.kind)}, ${dist(o.dist)}</span></div>
   <button class="pillbtn" data-osmadd="${i}" aria-label="Aggiungi ${esc(o.name || 'questo spot')} ai tuoi spot">Aggiungi</button></div>`).join('');
 box.innerHTML = `<p class="k">Altri spot nella zona, dall'elenco pubblico</p>${body}${attr}`;
}
// ---------- Spot noti sulla mappa (OpenStreetMap), aggiungibili con + ----------
let myLayer = null, catLayer = null, catSel = null;
const catPins = {}, catData = {};
// Spot sardi ben noti, con posizione indicativa: completano OpenStreetMap dove è scarno
const SEED = [
 ['Is Arutas',39.955,8.392,'beach'],['Mari Ermi',39.967,8.394,'beach'],['Maimoni',39.924,8.408,'beach'],['Is Benas',40.067,8.448,'beach'],
 ["S'Archittu",40.085,8.494,'reef'],['Santa Caterina di Pittinuri',40.101,8.492,'reef'],['Bosa Marina',40.288,8.473,'beach'],['La Speranza (Poglina)',40.505,8.316,'beach'],
 ['Alghero, Le Bombarde',40.585,8.240,'beach'],['Alghero, Lazzaretto',40.590,8.249,'reef'],['Porto Ferro',40.680,8.197,'beach'],['Argentiera',40.738,8.140,'reef'],
 ['Platamona',40.822,8.470,'beach'],['Marina di Sorso',40.842,8.563,'beach'],['Valledoria, La Ciaccia',40.931,8.800,'beach'],['Isola Rossa',41.010,8.870,'beach'],
 ['Rena Majore',41.130,9.058,'beach'],['Santa Teresa, Rena Bianca',41.244,9.188,'beach'],['Capo Testa',41.240,9.150,'reef'],
 ['San Teodoro, La Cinta',40.800,9.683,'beach'],['Budoni',40.702,9.720,'beach'],['Cala Liberotto',40.431,9.785,'beach'],['Cala Ginepro',40.445,9.793,'beach'],
 ['Arbatax, Porto Frailis',39.930,9.710,'beach'],['Bari Sardo, Torre di Bari',39.843,9.681,'beach'],['Marina di Cardedu',39.790,9.660,'beach'],
 ['Poetto',39.205,9.165,'beach'],['Chia',38.892,8.873,'beach'],['Porto Pino',38.968,8.600,'beach'],
 ['Porto Paglia',39.270,8.420,'beach'],['Plagemesu',39.293,8.428,'beach'],['Funtanamare',39.283,8.425,'beach'],
 ['Buggerru',39.400,8.398,'beach'],['Portixeddu',39.440,8.410,'beach'],['Capo Pecora',39.450,8.385,'reef'],['Scivu',39.495,8.395,'beach'],['Piscinas',39.540,8.448,'beach']
].map(([name,lat,lon,kind],i)=>({id:'seed/'+i, name, lat, lon, kind, approx:true}));

// Tutti gli spot di surf segnati su OpenStreetMap in Europa, Canarie e Marocco: scaricati una volta al mese
let europeState = 'idle';
async function loadEurope(){
 const c = store.get('surf.catalogEU', null);
 if (c && Date.now() - c.at < 30*86400000){ europeState = 'ok'; addCatPins(c.list); return; }
 europeState = 'loading';
 const hint = document.getElementById('mapHint');
 hint.hidden = false; hint.textContent = 'Carico gli spot noti…';
 // prima il catalogo preparato da GitHub Actions (stesso sito, veloce e affidabile)
 try{
  const cat = await getJson('catalog.json', {cache:'no-cache'}, 1, 30000);
  if (Array.isArray(cat.spots) && cat.spots.length){
   store.set('surf.catalogEU', {at:Date.now(), list:cat.spots});
   europeState = 'ok'; hint.hidden = true; addCatPins(cat.spots); return;
  }
 }catch(e){}
 const q = '[out:json][timeout:120];nwr["sport"~"(^|;)surfing(;|$)"][!"shop"][!"amenity"][!"building"](27,-26,71,45);out center tags;';
 let res = null;
 for (const url of OVERPASS){ try{ res = await getJson(`${url}?data=${encodeURIComponent(q)}`, {}, 1, 130000); break; }catch(e){} }
 hint.hidden = true;
 if (!res){ europeState = 'error'; loadCatalog(); return; }
 const list = res.elements.map(el=>{
  const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  return {id:`${el.type}/${el.id}`, lat:+lat.toFixed(4), lon:+lon.toFixed(4), name: t.name || t.loc_name || t['name:it'] || t['name:en'] || null,
   kind: t.natural === 'reef' || /reef|point/i.test(t.surfing || '') ? 'reef' : t.natural === 'beach' ? 'beach' : null};
 }).filter(Boolean);
 store.set('surf.catalogEU', {at:Date.now(), list});
 europeState = 'ok';
 addCatPins(list);
}

async function loadCatalog(){
 if (europeState === 'ok' || europeState === 'loading') return;
 const hint = document.getElementById('mapHint');
 if (!leaf || !catLayer || !leaf.hasLayer(catLayer)){ hint.hidden = true; return; }
 if (leaf.getZoom() < 8){ hint.hidden = false; hint.textContent = 'Avvicinati per vedere gli spot noti della zona'; return; }
 hint.hidden = true;
 const bb = leaf.getBounds(), cells = [];
 for (let la = Math.floor(bb.getSouth()); la <= Math.floor(bb.getNorth()); la++)
  for (let lo = Math.floor(bb.getWest()); lo <= Math.floor(bb.getEast()); lo++) cells.push([la, lo]);
 if (cells.length > 12) return;
 const cache = store.get('surf.catalog', {});
 for (const [la, lo] of cells){
  const key = `${la},${lo}`;
  if (catData[key]) continue;
  const c = cache[key];
  if (c && Date.now() - c.at < 7*86400000){ catData[key] = c.list; addCatPins(c.list); continue; }
  catData[key] = 'loading';
  hint.hidden = false; hint.textContent = 'Cerco gli spot noti…';
  const q = `[out:json][timeout:25];nwr["sport"~"(^|;)surfing(;|$)"][!"shop"][!"amenity"][!"building"](${la},${lo},${la+1},${lo+1});out center tags 300;`;
  let res = null, err = null;
  for (const url of OVERPASS){ try{ res = await getJson(`${url}?data=${encodeURIComponent(q)}`, {}, 1); break; }catch(e){ err = e; } }
  hint.hidden = true;
  if (!res){ delete catData[key]; hint.hidden = false; hint.textContent = `Spot noti non raggiungibili ora (${err?.message || 'errore'})`; setTimeout(()=>hint.hidden = true, 4000); break; }
  const list = res.elements.map(el=>{
   const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
   if (lat == null) return null;
   return {id:`${el.type}/${el.id}`, lat:+lat.toFixed(5), lon:+lon.toFixed(5), name: t.name || t.loc_name || t['name:it'] || t['name:en'] || null,
    kind: t.natural === 'reef' || /reef|point/i.test(t.surfing || '') ? 'reef' : t.natural === 'beach' ? 'beach' : null};
  }).filter(Boolean);
  catData[key] = list; cache[key] = {at:Date.now(), list};
  const keys = Object.keys(cache); if (keys.length > 40) delete cache[keys[0]];
  store.set('surf.catalog', cache);
  addCatPins(list);
 }
}
// griglia di celle da ~2km per trovare i doppioni senza confrontare tutti con tutti
const catGrid = {};
const cellKey = (la, lo) => `${Math.floor(la*50)},${Math.floor(lo*50)}`;
function nearbyPins(o){
 const r = Math.floor(o.lat*50), c = Math.floor(o.lon*50), out = [];
 for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) (catGrid[`${r+i},${c+j}`] || []).forEach(m => out.push(m));
 return out;
}
function addCatPins(list){
 const fresh = [];
 list.forEach(o=>{
  if (catPins[o.id]) return;
  if (spots.some(sp => distanceKm(o, beach(sp)) < 0.4)) return;
  const dup = nearbyPins(o).find(m => catPins[m.spot.id] && !(o.approx && m.spot.approx) && distanceKm(o, m.spot) < (o.approx || m.spot.approx ? 1.5 : 0.15));
  if (dup){ if (!dup.spot.approx || o.approx) return; catLayer.removeLayer(dup); delete catPins[dup.spot.id]; }
  const m = L.marker([o.lat, o.lon], {title:o.name || 'Spot', keyboard:true,
   icon:catIcon(o, null)});
  m.on('click', ev=>{ L.DomEvent.stopPropagation(ev); catSel = o; mapSel = null; renderMap(); });
  m.spot = o; catPins[o.id] = m;
  (catGrid[cellKey(o.lat, o.lon)] ||= []).push(m);
  fresh.push(m);
 });
 if (catLayer.addLayers) catLayer.addLayers(fresh); else fresh.forEach(m => catLayer.addLayer(m));
}
// ---------- Potenziale degli spot noti ----------
// Degli spot noti non conosciamo l'orientamento: stimiamo un "potenziale" da onda al largo, periodo e forza del vento,
// come se lo spot prendesse lo swell in pieno. Serve a capire dove guardare, non sostituisce il punteggio vero.
const catFc = {};
function catIcon(o, e){
 const sc = e?.score, [bg,fg] = sc == null ? ['#fff','var(--accent)'] : tone(sc);
 return L.divIcon({className:'', iconSize:[28,28], iconAnchor:[14,14],
  html:`<div class="cpin${sc == null ? ' plus' : ''}${catSel === o ? ' sel' : ''}" style="--c:${bg};--fg:${fg}" aria-label="${esc(o.name || 'Spot senza nome')}${sc == null ? '' : ', potenziale ' + sc + ' su 5'}">${sc == null ? '+' : sc}</div>`});
}
function genericEval(s, i){
 const hs = s.hs[i], T = s.per[i]; if (hs == null || T == null) return null;
 const face = hs * clamp(0.75+(T-6)*0.06, 0.6, 1.3), min = .6, max = 3;
 let h = face < min ? .3*face/min : face <= max ? .6 + .4*Math.min(1,(face-min)/((max-min)*.6)) : Math.max(0, 1-(face-max)/max);
 const pf = T >= 7 ? 1 : clamp((T-3)/4, .2, 1), ws = s.ws[i] ?? 0;
 const wf = clamp(1 - (ws-12)/30, .35, 1);
 return {score: Math.min(5, Math.round(5*h*pf*wf*2)/2), face, hs, T, ws, dir:s.dir[i], wd:s.wd[i] ?? 0};
}
function catEval(o){
 const s = catFc[o.id]?.s; if (!s) return null;
 if (mapDay === 'now'){ const i = Math.max(0, s.time.indexOf(nowKey())); return genericEval(s, i); }
 let best = null;
 s.time.forEach((t,i)=>{ if (!t.startsWith(mapDay)) return; const h = +t.slice(11,13); if (h < DAY_START || h > DAY_END) return;
  const e = genericEval(s, i); if (e && (!best || e.score > best.score)) best = e; });
 return best;
}
function refreshCatIcons(){
 if (!catLayer) return;
 Object.values(catPins).forEach(m => { if (!catFc[m.spot.id] && catSel !== m.spot) return; const e = catEval(m.spot); m.options.score = e?.score; m.setIcon(catIcon(m.spot, e)); });
 if (catLayer.refreshClusters && leaf && leaf.hasLayer(catLayer)) try{ catLayer.refreshClusters(); }catch(e){ console.warn(e); }
}
let catBusy = false;
async function loadCatScores(){
 if (catBusy || !leaf || !catLayer || !leaf.hasLayer(catLayer) || leaf.getZoom() < 6) return;
 const bb = leaf.getBounds(), c = leaf.getCenter();
 const want = Object.values(catPins).map(m=>m.spot)
  .filter(o => bb.contains([o.lat, o.lon]) && !(catFc[o.id] && Date.now() - catFc[o.id].at < 3600000))
  .sort((a,b)=> distanceKm(a,{lat:c.lat,lon:c.lng}) - distanceKm(b,{lat:c.lat,lon:c.lng})).slice(0, 50);
 if (!want.length) return;
 catBusy = true;
 try{
  const q = `latitude=${want.map(o=>o.lat).join(',')}&longitude=${want.map(o=>o.lon).join(',')}&timezone=${encodeURIComponent(TZ)}&forecast_days=7`;
  let [m, w] = await Promise.all([
   getJson(`https://marine-api.open-meteo.com/v1/marine?${q}&cell_selection=sea&hourly=wave_height,wave_direction,wave_period`),
   getJson(`https://api.open-meteo.com/v1/forecast?${q}&hourly=wind_speed_10m,wind_direction_10m`)
  ]);
  if (!Array.isArray(m)) m = [m]; if (!Array.isArray(w)) w = [w];
  want.forEach((o,k)=>{
   const mh = m[k]?.hourly, wh = w[k]?.hourly; if (!mh || !wh) return;
   const wi = new Map(wh.time.map((t,i)=>[t,i])), pick = (a,t)=>{ const i = wi.get(t); return i == null ? null : a[i]; };
   catFc[o.id] = {at:Date.now(), s:{time:mh.time, hs:mh.wave_height, dir:mh.wave_direction, per:mh.wave_period,
    ws:mh.time.map(t=>pick(wh.wind_speed_10m,t)), wd:mh.time.map(t=>pick(wh.wind_direction_10m,t))}};
  });
  refreshCatIcons(); renderCatCard();
 }catch(e){}
 catBusy = false;
 if (want.length === 50) setTimeout(loadCatScores, 400);
}

function renderCatCard(){
 const el = document.getElementById('catCard');
 if (!catSel || !document.getElementById('windy').hidden){ el.hidden = true; return; }
 const o = catSel, near = camsNear(o).length;
 const kind = o.kind === 'reef' ? 'Reef o punta' : o.kind === 'beach' ? 'Spiaggia' : 'Spot di surf';
 el.hidden = false;
 el.innerHTML = `<div style="flex:1;min-width:0"><p class="cond" style="font-weight:600;font-size:21px;line-height:1.1">${esc(o.name || 'Spot senza nome')}</p>
  <p class="small muted">${(()=>{ const e = catEval(o); return e ? `Potenziale ${e.score}/5: ${e.face.toFixed(1)}m, ${Math.round(e.T)}s, vento ${Math.round(e.ws)}km/h. ` : ''; })()}${kind}${o.approx ? ', posizione indicativa' : ''}${near ? `, ${near} webcam in zona` : ''}</p>
  <p class="xs muted" style="margin-top:2px">Aggiungilo per il punteggio vero, calcolato sul suo orientamento.</p></div>
  <button class="pillbtn primary" id="catAdd">+ Aggiungi</button>`;
 document.getElementById('catAdd').onclick = ()=>{ const x = catSel; catSel = null; addFromOsm(x); };
}
document.getElementById('catBtn').onclick = e=>{
 const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
 e.currentTarget.setAttribute('aria-pressed', on);
 store.set('surf.showCat', on);
 if (!leaf || !catLayer) return;
 if (on){ catLayer.addTo(leaf); loadCatalog(); } else { leaf.removeLayer(catLayer); catSel = null; document.getElementById('mapHint').hidden = true; renderMap(); }
};
document.getElementById('catBtn').setAttribute('aria-pressed', store.get('surf.showCat', true));

function addFromOsm(o){
 openAdd();
 if (add.map) setPos(o.lat, o.lon, 15);
 else add.pos = [o.lat, o.lon];
 if (o.kind) add.kind = o.kind;
 document.getElementById('addName').value = o.name || '';
 drawAdd();
}

function updateOrderUi(){
 const custom = !!store.get('surf.order', null);
 document.getElementById('resetOrder').hidden = !custom;
 document.getElementById('orderHint').textContent = custom ? '' : 'Trascina la maniglia a sinistra per mettere gli spot nell\'ordine che vuoi.';
 document.getElementById('orderHint').hidden = !document.getElementById('orderHint').textContent;
}
function saveOrder(){
 const shown = [...document.querySelectorAll('#activeList .item, #offList .item')].map(x=>x.dataset.id);
 const set = new Set(shown), old = store.get('surf.order', null) || [];
 const full = [...old.filter(id=>spots.some(s=>s.id===id)), ...[...document.querySelectorAll('#nearList .item')].map(x=>x.dataset.id).filter(id=>!old.includes(id)), ...shown.filter(id=>!old.includes(id))];
 let k = 0;
 store.set('surf.order', full.map(id => set.has(id) ? shown[k++] : id).concat(shown.slice(k)));
 updateOrderUi();
}
function initDrag(list){
 list.addEventListener('pointerdown', e=>{
  const g = e.target.closest('.grip'); if (!g) return;
  e.preventDefault();
  const item = g.closest('.item'), grab = e.clientY - item.getBoundingClientRect().top;
  item.classList.add('dragging'); document.body.classList.add('sorting');
  if (navigator.vibrate) navigator.vibrate(10);
  const pid = e.pointerId;
  const move = ev=>{
   if (ev.pointerId !== pid) return;
   const y = ev.clientY;
   item.style.transform = '';
   let before = null;
   for (const sib of list.querySelectorAll('.item')){
    if (sib === item) continue;
    const r = sib.getBoundingClientRect();
    if (y < r.top + r.height/2){ before = sib; break; }
   }
   if (before ? item.nextElementSibling !== before : list.lastElementChild !== item){
    list.insertBefore(item, before);
    if (navigator.vibrate) navigator.vibrate(5);
   }
   item.style.transform = `translateY(${Math.round(y - grab - item.getBoundingClientRect().top)}px)`;
   if (y < 70) window.scrollBy(0, -12); else if (y > window.innerHeight - 150) window.scrollBy(0, 12);
  };
  const up = ev=>{
   if (ev.pointerId !== pid) return;
   window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
   item.style.transform = ''; item.classList.remove('dragging'); document.body.classList.remove('sorting');
   saveOrder();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
 });
 list.addEventListener('keydown', e=>{
  const g = e.target.closest('.grip'); if (!g) return;
  const item = g.closest('.item');
  if (e.key === 'ArrowUp' && item.previousElementSibling){ e.preventDefault(); list.insertBefore(item, item.previousElementSibling); }
  else if (e.key === 'ArrowDown' && item.nextElementSibling){ e.preventDefault(); list.insertBefore(item.nextElementSibling, item); }
  else return;
  g.focus(); saveOrder();
 });
}
initDrag(document.getElementById('activeList'));
initDrag(document.getElementById('offList'));
document.getElementById('resetOrder').onclick = ()=>{ store.set('surf.order', null); renderSpot(); };

// ---------- Carta d'identità dello spot: fondale e accesso ----------
const svgI = (d, w=22) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const KINDS = [
 {id:'beach', t:'Beach break', d:'Fondale di sabbia', icon:svgI('<path d="M2 10c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0 3.5-1.5 5-1"/><path d="M3 19c3-3 15-3 18 0"/><path d="M7 17.2h.01M12 16.4h.01M17 17.2h.01"/>')},
 {id:'reef', t:'Reef', d:'Fondale di roccia', icon:svgI('<path d="M2 8c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0 3.5-1.5 5-1"/><path d="M3 20l3.5-5 2.5 2 4-6 3 4 1.5-1.5L21 20z"/>')},
 {id:'point', t:'Point break', d:'Onda lungo una punta', icon:svgI('<path d="M3 20h8l10-12"/><path d="M4 12c2-2.5 5-3 8-1.5"/><path d="M5 16c2-1.5 4-1.8 6-1"/>')}
];
const ICON_LOCALS = svgI('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');
const ICON_OPEN = svgI('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M15.5 14.3c3 .2 5.5 2.3 5.5 5.7"/>');
const ACCESS = [
 {id:'open', t:'Tutti', d:'Spot aperto', icon:ICON_OPEN},
 {id:'locals', t:'Only locals', d:'Serve rispetto', icon:ICON_LOCALS},
 {id:'unknown', t:'Non so', d:'Da scoprire', icon:svgI('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6"/><path d="M12 17h.01"/>')}
];
const metaLine = sp => [sp.area, KINDS.find(k => k.id === sp.kind)?.t, sp.access === 'locals' ? 'Only locals' : null].filter(Boolean).join(' · ');
function idStrip(sp, custom){
 const k = KINDS.find(x => x.id === sp.kind), chips = [];
 if (k) chips.push(`<span class="idchip">${k.icon}<span>${k.t}<small>${k.d}${sp.bigOnly ? ', solo con mareggiate' : ''}</small></span></span>`);
 if (sp.access === 'locals') chips.push(`<span class="idchip locals">${ICON_LOCALS}<span>Only locals<small>Entra in punta di piedi</small></span></span>`);
 else if (sp.access === 'open') chips.push(`<span class="idchip">${ICON_OPEN}<span>Aperto a tutti<small>Rispetta le precedenze</small></span></span>`);
 if (custom && (!k || !sp.access)) chips.push(`<button class="idchip add" id="idEdit">+ ${!k && !sp.access ? 'Fondale e accesso' : !k ? 'Fondale' : 'Accesso'}</button>`);
 return chips.length ? `<div class="idstrip">${chips.join('')}</div>` : '';
}
// perché il punteggio è quello: onda, periodo e vento, ognuno con il suo stato
function factorsHtml(sp, ev){
 const wave = ev.face < sp.min ? (ev.face >= .7*sp.min ? ['mid','Onda al limite'] : ['ko','Onda troppo piccola'])
  : ev.face > sp.max ? (ev.face <= 1.3*sp.max ? ['mid','Onda grossa'] : ['ko','Onda troppo grossa']) : ['ok','Onda giusta'];
 const per = ev.periodF >= 1 ? ['ok', `Periodo ${Math.round(ev.T)}s`] : ev.periodF >= .6 ? ['mid','Periodo corto'] : ['ko','Periodo troppo corto'];
 const wind = ev.windF >= .9 ? ['ok', ev.windType === 'offshore' ? 'Vento offshore' : 'Vento debole'] : ev.windF >= .6 ? ['mid', `Vento ${ev.windType}`] : ['ko', `Vento ${ev.windType} forte`];
 const g = {ok:'✓', mid:'!', ko:'✕'};
 return `<div class="hfac" role="list" aria-label="Cosa determina il punteggio">${[wave, per, wind].map(([c,t]) => `<span class="${c}" role="listitem"><i aria-hidden="true">${g[c]}</i>${t}</span>`).join('')}</div>`;
}

// ---------- Tavola giusta: profilo surfista, quiver e consiglio ----------
// Sono regole pratiche, non una legge fisica: partono da altezza e potenza dell'onda (altezza x periodo),
// dal fondale, dal vento e dal livello di chi surfa, e si possono affinare con l'esperienza.
const SURF_LEVELS = [
 {id:'principiante', t:'Principiante', d:'Sto imparando: onde piccole, anche solo sulla schiuma'},
 {id:'intermedio', t:'Intermedio', d:'Parto sull\'onda prima che si rompa e faccio le prime virate'},
 {id:'avanzato', t:'Avanzato', d:'Surfo con sicurezza onde medie, anche su reef'},
 {id:'esperto', t:'Esperto', d:'Onde grosse e impegnative'}
];
const BOARD_TYPES = [
 {id:'foam', t:'Soft-top / foamie', s:'Soft-top', d:'Morbida e con tanto volume: la più facile per imparare'},
 {id:'longboard', t:'Longboard', s:'Longboard', d:'Da 8 piedi in su: onde piccole e lente, molto scorrevole'},
 {id:'midlength', t:'Mid-length / egg', s:'Mid-length', d:'Tra 6\'6" e 7\'8": scorre bene e resta maneggevole'},
 {id:'fish', t:'Fish / twin', s:'Fish', d:'Corta, larga e veloce: onde piccole e poco potenti'},
 {id:'hybrid', t:'Hybrid / groveler', s:'Hybrid', d:'Corta con molto volume: fa surfare anche il mare debole'},
 {id:'shortboard', t:'Shortboard', s:'Shortboard', d:'La tavola da onda "vera": reattiva, vuole onda con spinta'},
 {id:'stepup', t:'Step-up / semi-gun', s:'Step-up', d:'Un po\' più lunga e sottile: onde grosse e potenti'},
 {id:'gun', t:'Gun', s:'Gun', d:'Lunga e stretta: solo per mareggiate importanti'}
];
const boardType = id => BOARD_TYPES.find(t => t.id === id);
const surfProfile = () => store.get('surf.profile', null) || {};
function saveProfile(patch){ const p = {...surfProfile(), ...patch}; store.set('surf.profileDirty', true); store.set('surf.profile', p); }
const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c === 'x' ? r : (r&3|8)).toString(16); });

// quanto ogni tavola va bene per ogni "taglia" di onda: molto piccola, piccola, media, grossa, molto grossa, enorme
const SUIT = {
 foam:[1,1,.6,.1,0,0], longboard:[1,.95,.6,.2,0,0], midlength:[.85,1,.85,.4,.1,0], fish:[.6,1,.8,.3,0,0],
 hybrid:[.9,1,.9,.5,.1,0], shortboard:[.2,.6,1,.9,.4,.1], stepup:[0,.1,.5,1,.9,.4], gun:[0,0,.1,.5,1,1]
};
const LEVEL_MULT = {
 principiante:{foam:1, longboard:.95, midlength:.55, fish:.3, hybrid:.3, shortboard:.05, stepup:0, gun:0},
 intermedio:{foam:.6, longboard:.9, midlength:1, fish:1, hybrid:1, shortboard:.85, stepup:.6, gun:.3},
 avanzato:{foam:.25, longboard:.8, midlength:1, fish:1, hybrid:1, shortboard:1, stepup:1, gun:.8},
 esperto:{foam:.15, longboard:.8, midlength:1, fish:1, hybrid:1, shortboard:1, stepup:1, gun:1}
};
const LEVEL_LIMIT = {principiante:.9, intermedio:1.7, avanzato:2.8, esperto:99};      // altezza a riva oltre cui le condizioni sono impegnative
const LKG = {principiante:.68, intermedio:.52, avanzato:.44, esperto:.40};            // litri per kg di una shortboard, per livello
const TYPE_F = {shortboard:1, stepup:1.05, gun:1.2, fish:1.12, hybrid:1.15, midlength:1.55, longboard:1.9, foam:1.8};
const BAND_WORDS = ['onda molto piccola','onda piccola','onda di media taglia','onda grossa','onda molto grossa','onda enorme'];

function boardCtx(sp, ev){
 const pr = surfProfile(), hasLevel = SURF_LEVELS.some(l => l.id === pr.level);
 const punch = ev.face * clamp(ev.T / 9, .6, 1.4);      // altezza corretta dal periodo: periodo lungo = più potenza
 const band = punch < .6 ? 0 : punch < 1 ? 1 : punch < 1.7 ? 2 : punch < 2.5 ? 3 : punch < 3.5 ? 4 : 5;
 const choppy = ev.windType !== 'offshore' && ev.windType !== 'debole' && ev.ws >= 20;
 return {band, punch, face:ev.face, T:ev.T, choppy, kind:sp.kind || null, level: hasLevel ? pr.level : 'intermedio', generic: !hasLevel,
  weight: pr.weight >= 30 && pr.weight <= 200 ? +pr.weight : null};
}
function catScore(type, c){
 let s = SUIT[type][c.band] * LEVEL_MULT[c.level][type];
 const up = (x, m) => Math.min(1, x * m);
 if (c.T < 7){                                           // mare corto e debole
  if (type === 'shortboard') s *= .7; else if (type === 'stepup') s *= .8;
  else if (type === 'fish' || type === 'hybrid') s = up(s, 1.15); else if (type === 'longboard' || type === 'midlength') s = up(s, 1.05);
 } else if (c.T >= 10){                                  // swell lungo e potente
  if (type === 'shortboard' || type === 'stepup') s = up(s, 1.05); else if (type === 'fish') s *= .85;
 }
 if (c.kind === 'point' && (type === 'longboard' || type === 'midlength')) s = up(s, 1.1);
 if (c.kind === 'reef'){ if (type === 'fish' || type === 'hybrid') s *= .9; else if (type === 'shortboard' || type === 'stepup') s = up(s, 1.05); }
 if (c.choppy){ if (type === 'hybrid' || type === 'fish' || type === 'midlength') s = up(s, 1.1); else if (type === 'shortboard') s *= .9; }
 return clamp(s, 0, 1);
}
function targetLitres(type, c){
 if (!c.weight) return null;
 let v = c.weight * LKG[c.level] * TYPE_F[type];
 if (c.band <= 1 && (type === 'shortboard' || type === 'stepup' || type === 'gun')) v *= 1.06;   // onda piccola: un po' più di volume
 else if (c.band >= 3) v *= .97;
 return v;
}
function boardAdvice(sp, ev){
 const c = boardCtx(sp, ev);
 const ranked = BOARD_TYPES.map(t => ({t, s:catScore(t.id, c)})).sort((a, b) => b.s - a.s);
 const best = ranked[0], alt = ranked[1] && ranked[1].s >= Math.max(.45, best.s - .15) ? ranked[1] : null;
 const tl = targetLitres(best.t.id, c);
 const parts = [BAND_WORDS[c.band]];
 if (c.T < 7) parts.push('poco potente (periodo corto)'); else if (c.T >= 10) parts.push('potente (periodo lungo)');
 if (c.choppy) parts.push('mare mosso dal vento');
 if (c.kind === 'reef') parts.push('fondale di roccia'); else if (c.kind === 'point') parts.push('onda lunga lungo la punta');
 const why = parts[0].charAt(0).toUpperCase() + parts.join(', ').slice(1);
 const limit = LEVEL_LIMIT[c.level] * (c.kind === 'reef' ? .85 : 1);
 let mine = null;
 const quiver = Data.boards.all();
 if (quiver.length){
  const list = quiver.map(b => {
   const t = targetLitres(b.type, c), s = catScore(b.type, c);
   let v = 1, note = '';
   if (t && b.litres){
    const r = b.litres / t, d = Math.abs(r - 1);
    v = d <= .08 ? 1 : d >= .35 ? 0 : 1 - (d - .08) / .27;
    note = d <= .08 ? 'litri giusti per il tuo peso' : r < 1 ? `litri un po' pochi (ideali ~${Math.round(t)})` : `litri un po' tanti (ideali ~${Math.round(t)})`;
   }
   return {b, s, fit: s * (.55 + .45 * v), note};
  }).sort((x, y) => y.fit - x.fit);
  mine = {best:list[0], alt: list[1] && list[1].fit >= Math.max(.4, list[0].fit - .12) ? list[1] : null};
 }
 return {c, best:best.t, bestScore:best.s, alt: alt ? alt.t : null, why, tooBig: best.s < .25, mine,
  vol: tl ? [Math.round(tl * .92), Math.round(tl * 1.08)] : null,
  warn: !c.generic && c.face > limit ? `Condizioni impegnative per il livello «${SURF_LEVELS.find(l => l.id === c.level).t.toLowerCase()}»${c.kind === 'reef' ? ', ancora di più su fondale di roccia' : ''}. Valuta bene prima di entrare.` : null};
}
// etichetta breve per l'elenco giorno per giorno
function boardShort(sp, ev){
 const a = boardAdvice(sp, ev);
 if (a.tooBig) return 'meglio aspettare';
 if (a.mine && a.mine.best.fit >= .3) return a.mine.best.b.name;
 return a.best.s + (a.alt ? ' / ' + a.alt.s : '');
}
function boardHtml(sp, ev){
 const a = boardAdvice(sp, ev), m = a.mine && a.mine.best.fit >= .3 ? a.mine.best : null;
 const cat = a.best.t + (a.alt ? ' o ' + a.alt.t.toLowerCase() : '');
 const chip = t => `<span class="ppill" style="--c:var(--s3);--fg:#171717">${t}</span>`;
 let top = '', name, chips = '', extra = '';
 if (a.tooBig){
  name = 'Meglio aspettare';
  extra = cnote('red', 'warn', `Onde troppo grosse per il livello «${SURF_LEVELS.find(l => l.id === a.c.level).t.toLowerCase()}»: aspetta una giornata più tranquilla o scegli uno spot più riparato.`);
 } else if (m){
  const t = boardType(m.b.type);
  const sure = m.b.litres && a.c.weight;      // senza litri o peso il giudizio guarda solo il tipo: meglio non esagerare
  top = m.fit >= .8 && sure ? chip('Ottima scelta') : m.fit >= .55 ? chip('Va bene') : chip('Meglio di niente');
  name = esc(m.b.name);
  chips = `<div class="bchips"><span class="bchip l">${t ? t.t : 'Tavola'}</span>${m.b.litres ? `<span class="bchip">${m.b.litres}L</span>` : ''}${m.b.length ? `<span class="bchip">${esc(m.b.length)}</span>` : ''}</div>`;
  if (m.note) extra += `<p class="xs muted">${m.note.charAt(0).toUpperCase() + m.note.slice(1)}.</p>`;
  if (m.s < .5) extra += `<p class="bmore muted">Non è la più adatta a queste condizioni: l'ideale sarebbe ${cat.toLowerCase()}.</p>`;
  if (a.mine.alt) extra += `<p class="bmore muted">In alternativa: «${esc(a.mine.alt.b.name)}».</p>`;
 } else {
  name = cat;
  if (a.mine) extra += '<p class="xs muted">Nessuna delle tue tavole è adatta a queste condizioni.</p>';
 }
 const why = a.tooBig ? '' : `<p class="xs muted">${a.why}.</p>${a.vol ? cnote('blue', 'wave', `Volume indicativo per i tuoi ${a.c.weight}kg: <b>${a.vol[0]}–${a.vol[1]}L</b>`) : ''}`;
 const hints = [];
 if (a.c.generic || !a.c.weight){
  const need = a.c.generic && !a.c.weight ? 'livello e peso' : a.c.generic ? 'il tuo livello' : 'il tuo peso';
  hints.push(`<button class="pillbtn add" data-goto="me">${ICON_PLUS}Imposta ${need}</button>`);
 }
 if (!a.mine && !a.tooBig) hints.push(`<button class="pillbtn add" data-goto="me">${ICON_PLUS}Aggiungi le tue tavole</button>`);
 const icon_ = a.tooBig ? `<span class="ctile" style="--tbg:#3A2523;--tfg:#E8A094">${cicon('warn')}</span>` : btileSm(m ? m.b.type : a.best.id, m ? parseLen(m.b.length).ft : null);
 return `<div class="board"><div class="chd">${icon_}<div class="grow"><span class="ck" style="color:#F0A22E">Che tavola portare</span><b class="cval bn">${name}</b></div>${top}</div>
  ${chips}${extra}${why}${a.warn ? cnote('red', 'warn', a.warn) : ''}${hints.length ? `<div class="bbtns">${hints.join('')}</div>` : ''}
  <p class="xs muted" style="margin-top:12px">Indicazione di massima: conta anche come ti senti tu e come sono le onde davvero.</p></div>`;
}

// ---------- Avvisi a comparsa ----------
let toastTimer = null;
function toast(msg, kind = 'ok'){
 let t = document.getElementById('toast');
 if (!t){ t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
 t.className = 'toast ' + kind;
 t.innerHTML = `<i aria-hidden="true">${kind === 'err' ? '!' : '✓'}</i>${esc(msg)}`;
 void t.offsetWidth; t.classList.add('on');
 clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
}
const ICON_SYNC = svgI('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>', 17);
const ICON_OUT = svgI('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>', 17);
const ICON_PLUS = svgI('<path d="M12 5v14M5 12h14"/>', 18);

// ---------- Tavole disegnate: ogni tipo ha la sua sagoma e la sua lunghezza ----------
const BOARD_COLOR = {foam:'#D9A441', longboard:'#2F9E8F', midlength:'#4C9F5B', fish:'#E0705A', hybrid:'#A0578E', shortboard:'#1D5F8A', stepup:'#4B3A9E', gun:'#13283B'};
const BOARD_SHAPE = {
 shortboard:'M20 2C29 20 31 48 28 74C26.5 88 23.5 96 20 96C16.5 96 13.5 88 12 74C9 48 11 20 20 2Z',
 fish:'M20 8C31 18 35 44 33 66C32 76 30 84 27 92L20 84L13 92C10 84 8 76 7 66C5 44 9 18 20 8Z',
 longboard:'M20 2C31 5 34 28 34 50C34 74 30 97 20 98C10 97 6 74 6 50C6 28 9 5 20 2Z',
 foam:'M20 2C31 5 34 28 34 50C34 74 30 97 20 98C10 97 6 74 6 50C6 28 9 5 20 2Z',
 midlength:'M20 4C32 14 35 40 33 62C31 82 26 94 20 94C14 94 9 82 7 62C5 40 8 14 20 4Z',
 hybrid:'M20 10C33 17 37 42 35 64C34 80 31 88 27 90L13 90C9 88 6 80 5 64C3 42 7 17 20 10Z',
 stepup:'M20 1C27 20 30 52 27 80C26 90 23 97 20 98C17 97 14 90 13 80C10 52 13 20 20 1Z',
 gun:'M20 0C26 22 28 58 25.5 88L20 100L14.5 88C12 58 14 22 20 0Z'
};
const BOARD_FT = {foam:8, longboard:9, midlength:7.2, fish:5.8, hybrid:6, shortboard:6, stepup:6.8, gun:8};   // lunghezza tipica in piedi
// "6", "5.8", "5'8", "5 8" diventano 6'0", 5'8"...: se non riconosco la misura la lascio com'è
function parseLen(s){
 s = String(s || '').trim();
 if (!s) return {text:'', ft:null};
 const m = s.match(/^(\d{1,2})\s*(?:'|’|ft|piedi|-|\.|,|\s)?\s*(\d{1,2})?\s*(?:"|”|in)?$/i);
 if (!m) return {text:s, ft:null};
 const f = +m[1], i = m[2] == null ? 0 : +m[2];
 if (f < 4 || f > 12 || i > 11) return {text:s, ft:null};
 return {text:`${f}'${i}"`, ft: f + i / 12};
}
function boardIcon(type, ft, tilt = 65, k = 1, sw = 1.7){
 const t = BOARD_SHAPE[type] ? type : 'shortboard', L = ft || BOARD_FT[t];
 const H = Math.round(clamp(30 + (L - 5) * 2, 30, 38) * k), W = Math.round(H * .44);   // la lunghezza si vede, ma resta un'icona
 const ln = 'vector-effect="non-scaling-stroke"';
 const band = t === 'foam' ? `<path d="M9 40H31" ${ln}/>` : '';
 return `<svg class="bico" width="${W}" height="${H}" viewBox="0 0 40 100" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${tilt}deg)" aria-hidden="true"><path d="${BOARD_SHAPE[t]}" ${ln}/>${band}<path d="M20 14V86" opacity=".45" ${ln}/></svg>`;
}
const boardTile = (type, ft, big = false) => `<span class="btile${big ? ' big' : ''}">${boardIcon(type, ft, 65, big ? 2.05 : 1, big ? 2.6 : 1.7)}</span>`;
// dal nome ("Fish rosso", "Egg 7'2"...) provo a indovinare il tipo
function guessBoardType(name){
 const n = String(name).toLowerCase();
 const rules = [[/step\s*-?up|semi\s*-?gun/, 'stepup'], [/\bgun\b/, 'gun'], [/fish|twin|keel/, 'fish'], [/hybrid|grovel/, 'hybrid'],
  [/\begg\b|mid\s*-?length|midlength|funboard|\bfun\b/, 'midlength'], [/long\s*-?board|\blog\b|malibu|\bmal\b/, 'longboard'],
  [/soft\s*-?top|softop|foam/, 'foam'], [/short|thruster|performance|\bpw\b/, 'shortboard']];
 const r = rules.find(([re]) => re.test(n)); return r ? r[1] : null;
}

// ---------- Profilo: livello, peso e quiver ----------
const lvIcon = i => `<span class="lvi" aria-hidden="true">${[0, 1, 2, 3].map(k => `<i class="${k <= i ? 'on' : ''}" style="height:${6 + k * 4.5}px"></i>`).join('')}</span>`;
let weightTimer = null;
// ---------- Sezioni del profilo ad accordion ----------
const ME_KEYS = ['me-acc', 'me-surf', 'me-boards', 'me-data', 'me-admin'];
let meInit = false;
const adm = {days: 30, data: null, busy: false, err: null, at: 0};
function updateMeSummaries(){
 const set = (k, sum, info) => { const s = document.getElementById('sum-' + k), i = document.getElementById('info-' + k); if (s) s.innerHTML = sum; if (i) i.textContent = info; };
 const pr = surfProfile(), lv = SURF_LEVELS.find(l => l.id === pr.level), okW = pr.weight >= 30 && pr.weight <= 200, q = Data.boards.all();
 if (!Cloud.ready || !Cloud.user) set('me-acc', '<span><b>Non collegato</b>tocca per entrare</span>', 'Entra per non perdere i tuoi dati');
 else set('me-acc', `<span><b>Collegato</b>${Cloud.lastErr ? 'errore' : (Cloud.busy || !Cloud.lastSync) ? 'sincronizzo…' : Cloud.partialErr ? 'da controllare' : 'sincronizzato'}</span>`, Cloud.user.email || '');
 set('me-surf', lv || okW ? `<span><b>${lv ? lv.t : 'Livello?'}</b>${okW ? pr.weight + 'kg' : 'peso?'}</span>` : '<span>Da impostare</span>',
  lv && okW ? `Shortboard di riferimento: ~${Math.round(pr.weight * LKG[pr.level])}L` : 'Livello e peso servono a consigliarti la tavola');
 const L = q.map(b => b.litres).filter(x => x);
 set('me-boards', q.length ? `<span><b>${q.length} ${q.length === 1 ? 'tavola' : 'tavole'}</b>${L.length ? (Math.min(...L) === Math.max(...L) ? Math.min(...L) : Math.min(...L) + '–' + Math.max(...L)) + 'L' : ''}</span>` : '<span>Nessuna tavola</span>',
  q.length ? q.map(b => b.name).join(', ') : 'Aggiungi le tue tavole per sapere quale portare');
 set('me-data', '<span><b>Backup</b>manuale</span>', 'Copia di sicurezza di sessioni, spot e impostazioni');
 const asec = document.getElementById('sec-me-admin');
 if (asec) asec.hidden = !(Cloud.ready && Cloud.user && Cloud.admin);
 const ap = adm.data && adm.data.registered > 0 ? Math.round(adm.data.registered_active * 100 / adm.data.registered) : null;
 set('me-admin', ap != null ? `<span><b>${ap}%</b>attivi in ${adm.data.days} g</span>` : '<span><b>Admin</b>tocca per aprire</span>',
  adm.data ? `${adm.data.registered} registrati, ${adm.data.guests_active} guest attivi` : 'Utenti e utilizzo dell\'app');
}
// la prima volta in una sessione apro solo ciò che richiede un'azione; poi decide la persona
function initMeOpen(){
 if (meInit) return; meInit = true;
 const pr = surfProfile(), done = SURF_LEVELS.some(l => l.id === pr.level) && pr.weight >= 30;
 const def = {'me-acc': !Cloud.user, 'me-surf': !done, 'me-boards': Data.boards.all().length === 0, 'me-data': false, 'me-admin': false};
 ME_KEYS.forEach(k => openSection(k, def[k]));
}
document.querySelectorAll('#v-me [data-toggle]').forEach(t => { t.onclick = () => { openSection(t.dataset.toggle); if (t.dataset.toggle === 'me-admin' && t.getAttribute('aria-expanded') === 'true') loadAdminStats(); }; });

function renderProfile(){
 const pr = surfProfile(), sBox = document.getElementById('meSurf'), qBox = document.getElementById('quiver');
 if (!sBox || !qBox) return;
 initMeOpen(); updateMeSummaries();
 const hasLv = SURF_LEVELS.some(l => l.id === pr.level), okW = pr.weight >= 30 && pr.weight <= 200;
 const ref = hasLv && okW ? `<div class="refbox"><p class="xs muted">Litri di riferimento per te</p><div class="bmeta">${['shortboard', 'fish', 'midlength', 'longboard'].map(t =>
  `<span class="bchip l" style="--bc:${BOARD_COLOR[t]}">${boardType(t).s} ~${Math.round(pr.weight * LKG[pr.level] * TYPE_F[t])}L</span>`).join('')}</div></div>` : '';
 sBox.innerHTML = `<div class="acct"><p class="lab">Livello</p>
  <div class="opts two">${SURF_LEVELS.map((l, i) => `<button type="button" data-lvl="${l.id}" aria-pressed="${pr.level === l.id}">${lvIcon(i)}<b>${l.t}</b><span>${l.d}</span></button>`).join('')}</div>
  <div class="wlabrow"><p class="lab">Peso</p><span class="xs muted">trascina il righello</span></div>
  ${rulerHtml(pr.weight)}
  <p class="err" id="meErr" hidden></p>${ref}
  <p class="xs muted" style="margin-top:12px">Serve solo a calcolare i litri giusti per te. ${Cloud.user ? 'Si salva nel tuo account e lo vedi solo tu.' : 'Resta su questo telefono finché non entri con l\'account.'}</p></div>`;
 sBox.querySelectorAll('[data-lvl]').forEach(b => b.onclick = () => {
  const l = SURF_LEVELS.find(x => x.id === b.dataset.lvl);
  saveProfile({level:l.id}); renderProfile(); toast('Livello: ' + l.t);
 });
 initRuler(sBox, pr);

 const q = Data.boards.all();
 const rows = q.map(b => { const t = boardType(b.type), pl = parseLen(b.length);
  return `<button type="button" class="bcard" data-bedit="${b.id}" style="--bc:${BOARD_COLOR[b.type] || BOARD_COLOR.shortboard}" aria-label="Modifica ${esc(b.name)}">${boardTile(b.type, pl.ft)}
   <span style="flex:1;min-width:0"><b class="bname">${esc(b.name)}</b><span class="bmeta"><span class="bchip l">${esc(t ? t.s : b.type)}</span>${b.litres ? `<span class="bchip">${b.litres}L</span>` : ''}${pl.text ? `<span class="bchip">${esc(pl.text)}</span>` : ''}</span></span>
   <span class="bchev">${ICON.chev}</span></button>`; }).join('');
 const empty = `<div class="bempty"><div class="bfan" aria-hidden="true">${['fish', 'shortboard', 'longboard'].map(t => `<span class="btile">${boardIcon(t, null)}</span>`).join('')}</div>
  <p class="small muted">Nessuna tavola. Aggiungi quelle che hai e l'app ti dice quale portare, spot per spot.</p></div>`;
 qBox.innerHTML = `<div class="pcard">${q.length ? rows : empty}</div><button class="pillbtn addspot" id="bAdd">${ICON_PLUS}Aggiungi una tavola</button>`;
 qBox.querySelectorAll('[data-bedit]').forEach(b => b.onclick = () => openBoard(b.dataset.bedit));
 qBox.querySelector('#bAdd').onclick = () => openBoard();
}
function openBoard(id){
 const b = id ? Data.boards.all().find(x => x.id === id) : null;
 const wrap = document.createElement('div');
 wrap.className = 'sheet'; wrap.id = 'boardSheet';
 wrap.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-p form" role="dialog" aria-modal="true" aria-labelledby="bdT">
  <div class="sheet-h"><h2 id="bdT">${b ? 'Modifica tavola' : 'Nuova tavola'}</h2><button class="sheet-x" data-close aria-label="Chiudi">×</button></div>
  <div class="bprev"><span id="bdPrev"></span><p class="xs muted" id="bdHint" style="flex:1"></p></div>
  <label>Nome<input id="bdName" maxlength="60" autocomplete="off" placeholder="Es. Fish rossa" value="${b ? esc(b.name) : ''}"></label>
  <label>Tipo<select id="bdType">${BOARD_TYPES.map(t => `<option value="${t.id}"${(b ? b.type : 'shortboard') === t.id ? ' selected' : ''}>${t.t}</option>`).join('')}</select></label>
  <label>Litri (facoltativo)<input id="bdL" type="number" inputmode="decimal" step="0.1" min="5" max="150" placeholder="es. 32" value="${b && b.litres != null ? b.litres : ''}"></label>
  <p class="xs muted" style="margin-top:4px">Di solito sono scritti sulla tavola o sul sito di chi l'ha fatta. Senza litri il consiglio guarda solo il tipo.</p>
  <label>Misura (facoltativo)<input id="bdLen" maxlength="12" autocomplete="off" placeholder="es. 5'8&quot;" value="${b ? esc(b.length || '') : ''}"></label>
  <p class="err" id="bdErr" hidden></p>
  <button class="pillbtn primary" id="bdSave" style="margin-top:16px">Salva tavola</button>
  ${b ? '<button class="pillbtn" id="bdDel" style="margin-top:8px;width:100%;justify-content:center">Elimina tavola</button>' : ''}</div>`;
 document.body.appendChild(wrap); document.body.classList.add('locked');
 const close = () => { wrap.remove(); document.body.classList.remove('locked'); };
 const nameEl = wrap.querySelector('#bdName'), typeEl = wrap.querySelector('#bdType'), lenEl = wrap.querySelector('#bdLen');
 let touched = !!b;                         // se la persona sceglie il tipo, non lo cambio più io dal nome
 const preview = () => {
  const el = wrap.querySelector('#bdPrev'), t = typeEl.value;
  el.innerHTML = boardTile(t, parseLen(lenEl.value).ft, true);
  wrap.querySelector('#bdHint').textContent = boardType(t)?.d || '';
 };
 preview();
 typeEl.onchange = () => { touched = true; preview(); };
 lenEl.oninput = preview;
 nameEl.oninput = () => { if (touched) return; const g = guessBoardType(nameEl.value); if (g && g !== typeEl.value){ typeEl.value = g; preview(); } };
 wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
 wrap.querySelector('#bdSave').onclick = () => {
  const name = nameEl.value.trim(), type = typeEl.value, err = wrap.querySelector('#bdErr');
  const rawL = wrap.querySelector('#bdL').value.trim().replace(',', '.'), litres = rawL ? parseFloat(rawL) : null;
  if (!name){ err.hidden = false; err.textContent = 'Dai un nome alla tavola.'; return; }
  if (litres != null && (isNaN(litres) || litres < 5 || litres > 150)){ err.hidden = false; err.textContent = 'I litri devono essere tra 5 e 150.'; return; }
  Data.boards.save({...(b || {}), id: b ? b.id : uid(), name, type, litres: litres == null ? null : Math.round(litres * 10) / 10, length: parseLen(lenEl.value).text});
  close(); renderProfile(); toast(b ? 'Tavola aggiornata' : 'Tavola aggiunta');
 };
 const del = wrap.querySelector('#bdDel');
 if (del) del.onclick = () => { Data.boards.remove(b.id); close(); renderProfile(); toast('Tavola eliminata'); };
 nameEl.focus();
}

function offReason(sp, ev){
 if (ev.face < 0.3) return ev.hs >= 0.5 ? `${ev.hs.toFixed(1)}m al largo, swell fuori finestra` : 'Piatto';
 if (ev.windType === 'onshore' && ev.ws >= 15) return `${ev.face.toFixed(1)}m, onshore ${Math.round(ev.ws)}km/h`;
 return `${ev.face.toFixed(1)}m, ${ev.windType} ${Math.round(ev.ws)}km/h`;
}

// ---------- Dettaglio ----------
function chartHtml(sp){
 const s = data[sp.id], ci = currentIndex(s), days = allDays();
 const cols = days.map(day => CHART_HOURS.map(h => {
  const i = s.time.indexOf(`${day}T${h}:00`);
  return i < 0 ? null : {e: evaluate(sp, s, i), past: i < ci};
 }));
 const faces = cols.flat().filter(c=>c?.e).map(c=>c.e.face);
 const maxF = Math.ceil(Math.max(1, ...faces)*1.15*2)/2, H = 110;
 const px = v => Math.min(v, maxF)/maxF*H;
 const bandB = px(sp.min), bandH = sp.min < maxF ? px(sp.max) - px(sp.min) : 0;
 const best = forecastDays(sp).reduce((a,d)=> !a || d.best.score > a.best.score ? d : a, null);
 return `<div class="chart"><div class="bars">
  ${bandH ? `<div class="band" style="bottom:${bandB}px;height:${bandH}px"></div>` : ''}
  <span class="scale">${maxF}m</span>
  <div class="cols">${cols.map(g=>`<div class="g">${g.map(c=>{
   if (!c || !c.e) return '<span style="height:3px;--c:var(--line)"></span>';
   return `<span class="${c.past?'past':''}" style="height:${Math.max(3, px(c.e.face)).toFixed(0)}px;--c:${tone(c.e.score)[0]}" title="${c.e.face.toFixed(1)}m, ${c.e.score}/5"></span>`;
  }).join('')}</div>`).join('')}</div></div>
  <div class="labels">${days.map(d=>`<span class="${best && best.day===d && best.best.score>=ACTIVE_FROM ? 'best':''}">${dayShort(d)}</span>`).join('')}</div>
  ${legendHtml('<span><i style="--c:var(--s2);opacity:.25"></i>Range surfabile</span><span><i style="--c:var(--s3);opacity:.3"></i>Ore già passate (barre sbiadite)</span>')}</div>`;
}

// ---------- Nuovo stile: strumenti a cerchio, anello del punteggio, finestra migliore ----------
const GC = {
 light:{track:'#E6E8E4', win:'#91C4EE', off:'#F5C27E', swell:'#2B96E3', wind:'#EC8D2C', swellT:'#2272B8', windT:'#B5651A', n:'#5E625E'},
 dark:{track:'#3A3A3A', win:'#DDB892', off:'#8FBF6A', swell:'#3DA5F5', wind:'#F0A22E', n:'#B9B9B3'}
};
// uno strumento = un anello, un arco "dove va bene" e una freccia che dice dov'è adesso
function gauge(size, rng, arcCol, bearing, arrowCol, trackCol, nCol, showN){
 const c = size/2, ringw = Math.max(6, size*0.07), R = size*(showN ? 0.34 : 0.40);
 const arcPath = (d1, d2) => { const [x1,y1] = pt(c,R,d1), [x2,y2] = pt(c,R,d2); return `M${x1},${y1} A${R.toFixed(1)},${R.toFixed(1)} 0 ${(((d2-d1)%360)+360)%360 > 180 ? 1 : 0} 1 ${x2},${y2}`; };
 let arrow = '';
 if (bearing != null){
  const [tx,ty] = pt(c,R,bearing), [hx,hy] = pt(c,R*0.26,bearing);
  const L = Math.hypot(hx-tx, hy-ty), ux = (hx-tx)/L, uy = (hy-ty)/L, hl = size*0.11, hw = size*0.06;
  const bx = hx-ux*hl, by = hy-uy*hl, qx = -uy, qy = ux;
  arrow = `<line x1="${tx}" y1="${ty}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${arrowCol}" stroke-width="${Math.max(2.5, size*0.03).toFixed(1)}" stroke-linecap="round"/><polygon points="${hx},${hy} ${(bx+qx*hw).toFixed(1)},${(by+qy*hw).toFixed(1)} ${(bx-qx*hw).toFixed(1)},${(by-qy*hw).toFixed(1)}" fill="${arrowCol}"/>`;
 }
 const n = showN ? `<text x="${c}" y="${(size*0.10).toFixed(1)}" fill="${nCol}" font-size="${Math.max(8, size*0.08).toFixed(1)}" font-weight="700" text-anchor="middle" font-family="Space Mono,monospace">N</text>` : '';
 return `<svg class="gauge" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${R.toFixed(1)}" fill="none" stroke="${trackCol}" stroke-width="${ringw.toFixed(1)}"/><path d="${arcPath(rng[0], rng[1])}" fill="none" stroke="${arcCol}" stroke-width="${ringw.toFixed(1)}" stroke-linecap="round"/>${arrow}${n}</svg>`;
}
const swellGauge = (sp, ev, size, th='light') => { const g = GC[th]; return gauge(size, [sp.facing-sp.window, sp.facing+sp.window], g.win, ev ? ev.dir : null, g.swell, g.track, g.n, size >= 100); };
const windGauge = (sp, ev, size, th='light', showN=false) => { const g = GC[th]; return gauge(size, [sp.offshore-45, sp.offshore+45], g.off, ev && ev.ws >= 3 ? ev.wd : null, g.wind, g.track, g.n, showN); };

// marker: capsula rastremata (larga fuori, stretta dentro), bordo bianco che stacca l'arco
const ptf = (c, r, deg) => { const a = deg*Math.PI/180; return [c + r*Math.sin(a), c - r*Math.cos(a)]; };
function hullSvg(O, I, ro, ri, col){
 const dx = O[0]-I[0], dy = O[1]-I[1], dd = Math.hypot(dx, dy), ux = dx/dd, uy = dy/dd, qx = -uy, qy = ux;
 const sp = (ro-ri)/dd, cp = Math.sqrt(Math.max(0, 1-sp*sp));
 const n1 = [qx*cp-ux*sp, qy*cp-uy*sp], n2 = [-qx*cp-ux*sp, -qy*cp-uy*sp];
 const pts = [[O[0]+ro*n1[0], O[1]+ro*n1[1]], [O[0]+ro*n2[0], O[1]+ro*n2[1]], [I[0]+ri*n2[0], I[1]+ri*n2[1]], [I[0]+ri*n1[0], I[1]+ri*n1[1]]].map(p => p[0].toFixed(2)+','+p[1].toFixed(2)).join(' ');
 return `<polygon points="${pts}" fill="${col}"/><circle cx="${O[0].toFixed(2)}" cy="${O[1].toFixed(2)}" r="${ro.toFixed(2)}" fill="${col}"/><circle cx="${I[0].toFixed(2)}" cy="${I[1].toFixed(2)}" r="${ri.toFixed(2)}" fill="${col}"/>`;
}
function capsule(c, R, deg, col, w, m = 1, b = .17*w*m){
 // w = spessore della fascia colorata; il bordo bianco b è spesso come il grigio che sporge ai lati della fascia
 const ro = .48*w*m, ri = .37*w*m, L = 1.8*w*m, ctr = R + .13*w;
 const O = ptf(c, ctr + L/2 - ro, deg), I = ptf(c, ctr - L/2 + ri, deg);
 return hullSvg(O, I, ro + b, ri + b, '#fff') + hullSvg(O, I, ro, ri, col);
}
// proporzioni del quadrante: D = diametro esterno della pista, fascia = 11,5% di D, pista = 1,75 volte la fascia
const gaugeDims = size => { const D0 = .681*size, a = .115*D0, margin = Math.max((1.75*a - a)/2, .8), T = a + 2*margin,
  k = size >= 90 ? 1.25 : 1, D = D0*k, S = Math.round(size*k),   // cerchio grigio più grande (1,25×) sui quadranti grandi: fasce, marker e tondo restano della stessa misura
  border = Math.min(margin, Math.max(.25*a, .8)); // bordo bianco col tetto: sui quadranti grandi resta più sottile del grigio che sporge
 return {D, a, margin, border, T, S, R:D/2 - T/2, hub:Math.round(.48*D0)}; };
// un solo anello: pista grigia con due fasce centrate (azzurro = finestra delle onde, arancio = zona offshore del vento) e due marker
function comboGauge(sp, ev, size){
 const g = GC.light, {a, border, T, R, S} = gaugeDims(size), c = S/2, m = size >= 90 ? 1 : 1.5;
 // se onde e vento arrivano da direzioni quasi uguali i due marker si scostano di pochi gradi (la direzione esatta resta nel testo)
 let sd = ev ? ev.dir : null, wd = ev && ev.ws >= 3 ? ev.wd : null;
 if (sd != null && wd != null){ const diff = ((wd - sd + 180) % 360 + 360) % 360 - 180, SEP = 20; if (Math.abs(diff) < SEP){ const sh = (SEP - Math.abs(diff))/2, sg = diff >= 0 ? 1 : -1; sd -= sg*sh; wd += sg*sh; } }
 const arcP = (d1, d2) => { const [x1,y1] = ptf(c,R,d1), [x2,y2] = ptf(c,R,d2); return `M${x1.toFixed(2)},${y1.toFixed(2)} A${R.toFixed(2)},${R.toFixed(2)} 0 ${(((d2-d1)%360)+360)%360 > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`; };
 const n = size >= 90 ? `<text x="${c}" y="${(size*0.066).toFixed(1)}" fill="${g.n}" font-size="${(size*0.07).toFixed(1)}" font-weight="700" text-anchor="middle" font-family="Space Mono,monospace">N</text>` : '';
 return `<svg class="gauge" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${R.toFixed(2)}" fill="none" stroke="${g.track}" stroke-width="${T.toFixed(2)}"/><path d="${arcP(sp.facing-sp.window, sp.facing+sp.window)}" fill="none" stroke="${g.win}" stroke-width="${a.toFixed(2)}" stroke-linecap="round"/><path d="${arcP(sp.offshore-45, sp.offshore+45)}" fill="none" stroke="${g.off}" stroke-width="${a.toFixed(2)}" stroke-linecap="round"/>${n}${sd != null ? capsule(c,R,sd,g.swell,a,m,border) : ''}${wd != null ? capsule(c,R,wd,g.wind,a,m,border) : ''}</svg>`;
}
// il cerchio con il pallino del punteggio al centro
const gaugeWithScore = (sp, ev, size) => { const {hub: hs, S} = gaugeDims(size), [bg, fg] = tone(ev?.score);
 return `<div class="gw" style="width:${S}px;height:${S}px">${comboGauge(sp, ev, size)}<span class="badge" style="--c:${bg};--fg:${fg};width:${hs}px;height:${hs}px;font-size:${Math.round(hs*0.43)}px" aria-label="Punteggio ${ev?.score ?? 'non disponibile'} su 5">${ev?.score ?? '–'}</span></div>`; };

// anello del punteggio (arco = punteggio su 5)
function ringHtml(size, pct, track, arc, sw, inner){
 const r = (size-sw)/2, c = 2*Math.PI*r;
 return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="position:absolute;left:0;top:0;transform:rotate(-90deg)"><circle cx="${size/2}" cy="${size/2}" r="${r.toFixed(1)}" fill="none" stroke="${track}" stroke-width="${sw}"/><circle cx="${size/2}" cy="${size/2}" r="${r.toFixed(1)}" fill="none" stroke="${arc}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${(c*Math.max(0,Math.min(1,pct))).toFixed(1)} ${c.toFixed(1)}"/></svg><div style="position:absolute;left:0;top:0;width:${size}px;height:${size}px;display:flex;flex-direction:column;align-items:center;justify-content:center">${inner}</div></div>`;
}
const tintBg = sc => sc == null || sc < 1.5 ? '#2E2E2E' : sc < 2.5 ? '#3E3224' : '#26331F';

// parte alta della pagina dello spot: indietro, avvisi, preferito, nome, punteggio, onde e vento
function detailTop(sp, ev, backTo, fol, isFav){
 const bell = `<svg width="20" height="20" viewBox="0 0 24 24" fill="${fol?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" fill="none"/></svg>`;
 const top = `<div class="dtop"><button class="cbtn" id="back" aria-label="Indietro: ${backTo}">${ICON.back}</button>
  <div class="hacts"><button class="hstar" id="followBtn" aria-pressed="${fol}" aria-label="${fol?'Alert attivi: tocca per disattivarli':'Avvisami quando questo spot entra in condizione'}">${bell}</button>
  <button class="hstar" id="favBtn" aria-pressed="${isFav}" aria-label="${isFav?'Togli dai preferiti':'Metti tra i preferiti'}">${ICON.star(isFav).replace('width="16" height="16"','width="20" height="20"')}</button></div></div>`;
 const head = `<div class="dhead"><p class="harea">${esc(sp.area||'Spot')}</p><h1 class="dname">${esc(sp.name)}</h1></div>`;
 const G = GC.light;
 const hero = `<section class="hero">
  <button class="hdial" id="dialBtn" aria-label="Come leggere il cerchio">${gaugeWithScore(sp, ev, 132)}<span class="info" aria-hidden="true">i</span></button>
  <div class="hmain">
   <div><p class="hlab">${scoreLabel(ev?.score)}</p><p class="hsub">adesso</p></div>
   ${ev ? `<div class="hrd"><p class="hl" style="color:${G.swellT}"><i style="background:${G.swell}"></i>ONDE</p><p class="hv">${ev.face.toFixed(1)}m · ${Math.round(ev.T)}s</p><p class="hs">da ${cardinal(ev.dir)}, ${Math.round(ev.dir)}°</p></div>
   <div class="hrd"><p class="hl" style="color:${G.windT}"><i style="background:${G.wind}"></i>VENTO</p><p class="hv">${ev.ws < 3 ? 'quasi assente' : `${Math.round(ev.ws)}km/h`}</p>${ev.ws < 3 ? '' : `<p class="hs">da ${cardinal(ev.wd)}</p>`}</div>` : '<p class="small" style="color:var(--lightmuted)">Nessun dato per ora.</p>'}
  </div></section>`;
 return top + head + hero;
}

// finestra migliore: le ore consecutive in cui il punteggio è vicino al massimo del giorno
function bestWindow(sp){
 const s = data[sp.id]; if (!s) return null;
 const nowH = +nowKey().slice(11,13), today = todayIso();
 const evAt = (day, h) => { const i = s.time.indexOf(`${day}T${String(h).padStart(2,'0')}:00`); return i < 0 ? null : evaluate(sp, s, i); };
 const tomorrow = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); })();
 const tryDay = (day, fromH) => {
  const hrs = []; for (let h = Math.max(DAY_START, fromH); h <= DAY_END; h++){ const e = evAt(day, h); hrs.push({h, e, sc: e ? e.score : -1}); }
  const mx = Math.max(-1, ...hrs.map(x => x.sc));
  if (mx < ACTIVE_FROM) return {day, none:true, mx};
  const ok = x => x.sc >= Math.max(ACTIVE_FROM, mx - 0.5);
  let best = null, cur = null;
  hrs.forEach(x => {
   if (ok(x)){ if (!cur) cur = {from:x.h, to:x.h+1, items:[x]}; else { cur.to = x.h+1; cur.items.push(x); } }
   else { if (cur && (!best || cur.items.length > best.items.length)) best = cur; cur = null; }
  });
  if (cur && (!best || cur.items.length > best.items.length)) best = cur;
  return {day, from:best.from, to:best.to, score:mx, items:best.items};
 };
 let w = tryDay(today, nowH);
 if (w.none){ const t = tryDay(tomorrow, DAY_START); if (!t.none) w = t; }
 if (!w.none){
  const nxt = evAt(w.day, w.to), last = w.items[w.items.length-1].e;
  const calm = w.items.every(x => x.e.windType === 'debole' || x.e.windType === 'offshore');
  w.head = calm ? 'vento debole o offshore, onda pulita' : 'la parte migliore del giorno';
  if (w.to > DAY_END || !nxt) w.why = 'Resta buona fino a sera.';
  else if ((nxt.windType === 'onshore' || nxt.windType === 'laterale') && nxt.windType !== last.windType) w.why = `Dopo le ${w.to} il vento gira ${nxt.windType} e sale a ${Math.round(nxt.ws)}km/h.`;
  else if (nxt.face < sp.min) w.why = `Dopo le ${w.to} l'onda cala.`;
  else if (nxt.face > sp.max) w.why = `Dopo le ${w.to} l'onda diventa troppo grossa.`;
  else w.why = `Dopo le ${w.to} il punteggio scende.`;
 }
 w.isToday = w.day === today; w.nowH = nowH + new Date().getMinutes()/60;
 return w;
}
function windowHtml(sp){
 const w = bestWindow(sp); if (!w) return '';
 const pad = n => String(n).padStart(2,'0'), pc = h => (h/24*100).toFixed(3) + '%';
 if (w.none) return `<div class="ablock">${chd('amber','clock','Finestra migliore',`<b class="cval sm">Nessuna finestra buona</b>`)}<p class="xs muted" style="margin-top:8px">Oggi e domani il punteggio resta basso.</p></div>`;
 const ticks = Array.from({length:25}, (_, h) => `<line x1="${h*10}" y1="${h%3 === 0 ? 20 : 25}" x2="${h*10}" y2="30" stroke="#A27C54" stroke-width="1.2" opacity=".7" vector-effect="non-scaling-stroke"/>`).join('');
 const labs = [3,6,9,12,15,18,21].map(h => `<span style="left:${pc(h)}">${h}</span>`).join('');
 const win = `<div class="win" style="left:${pc(w.from)};width:${((w.to-w.from)/24*100).toFixed(3)}%"></div>`;
 const now = w.isToday ? `<div class="now" style="left:${pc(w.nowH)}"></div>` : '';
 return `<div class="ablock">${chd('amber','clock','Finestra migliore',`<b class="cval">${pad(w.from)}:00 – ${pad(w.to)}:00</b>`,`<span class="ppill" style="--c:#3E3224;--fg:#F0A22E">${w.isToday ? 'oggi' : 'domani'}</span>`)}
  <div class="wbar">${win}<svg viewBox="0 0 240 30" preserveAspectRatio="none" aria-hidden="true">${ticks}</svg>${now}</div>
  <div class="wlab">${labs}</div>
  <p class="wwhy"><span>${ICON_WIND}</span><span>${w.head.charAt(0).toUpperCase() + w.head.slice(1)}. ${w.why}</span></p></div>`;
}
const ICON_WIND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>';

// come leggere il cerchio: un anello, due archi "buoni" e due triangolini che dicono dove sono adesso onde e vento
function dirSheetHtml(sp, ev){
 const a0 = ((sp.facing - sp.window) % 360 + 360) % 360, a1 = (sp.facing + sp.window) % 360;
 const inWin = ev && angDiff(ev.dir, sp.facing) <= sp.window, calm = ev && ev.ws < 3, wt = ev ? ev.windType : '';
 const goodWind = wt === 'offshore' || wt === 'debole';
 const chip = (t, ok) => `<span class="st" style="background:${ok ? '#E3EEDB' : '#FBEFD9'};color:${ok ? '#2F5F1A' : '#8A5A24'}">${t}</span>`;
 const arcG = col => `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="9.5" fill="none" stroke="#E6E8E4" stroke-width="4"/><path d="M4.6 17.2 A9.5 9.5 0 0 1 17.2 4.6" fill="none" stroke="${col}" stroke-width="4" stroke-linecap="round"/></svg>`;
 const triG = col => `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">${hullSvg([13,8.8],[13,18.3],4.8,3.7,col)}</svg>`;
 const row = (g, t, d) => `<div class="drow"><span class="dg">${g}</span><div><b>${t}</b><p>${d}</p></div></div>`;
 const card = `<section class="dirc2">${gaugeWithScore(sp, ev, 190)}
  <div class="dleg">
   ${row(arcG(GC.light.win), `Finestra dello spot: da ${cardinal(a0)} a ${cardinal(a1)}`, 'Le direzioni da cui lo swell entra bene.')}
   ${ev ? row(triG(GC.light.swell), `Swell: da ${cardinal(ev.dir)}, ${Math.round(ev.dir)}°`, `${chip(inWin ? 'dentro la finestra' : 'fuori finestra', inWin)} Dentro l'arco azzurro le onde arrivano piene.`) : ''}
   ${row(arcG(GC.light.off), `Zona offshore: da ${cardinal(sp.offshore)}`, 'Il vento che pulisce l\'onda.')}
   ${ev ? row(triG(GC.light.wind), calm ? 'Vento: quasi assente' : `Vento: da ${cardinal(ev.wd)}, ${Math.round(ev.ws)}km/h`, `${chip(calm ? 'debole' : wt, goodWind)} Dentro l'arco arancio è offshore, fuori è laterale o onshore.`) : ''}
  </div></section>`;
 const eff = `<div class="dire"><div><b class="g">Swell nell'arco</b><span>le onde arrivano piene</span></div><div><b class="g">Vento nell'arco</b><span>onda pulita</span></div><div><b class="a">Vento fuori dall'arco</b><span>onda sporca, punteggio più basso</span></div></div>`;
 return `${card}<h2 style="margin:22px 0 0;font-size:16px">Che effetto ha</h2>${eff}`;
}

// carte interne: etichetta colorata + icona su tinta + note a tinta
const TONES = {blue:['#243442','#3DA5F5'], amber:['#3E3224','#F0A22E'], green:['#26331F','#9FD18B'], purple:['#2B2640','#A99BFF'], red:['#3A2523','#E8A094']};
const CIC = {
 wave:'<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 7c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>',
 ppl:'<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2c2.9 0 4.9 1.9 4.9 4.8"/>',
 board:'<path d="M12 2c3.6 3 4.8 9 4.4 14.2C16.1 19.6 14.4 22 12 22s-4.1-2.4-4.4-5.8C7.2 11 8.4 5 12 2z"/><path d="M12 6v11"/>',
 buoy:'<circle cx="12" cy="7" r="3"/><path d="M12 10v6"/><path d="M3 19c2.5-2 5-2 9 0s6.5 2 9 0"/>',
 warn:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
 ok:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
const cicon = (k, s=22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CIC[k]}</svg>`;
const chd = (tone, ic, label, val='', right='') => `<div class="chd"><span class="ctile" style="--tbg:${TONES[tone][0]};--tfg:${TONES[tone][1]}">${cicon(ic)}</span><div class="grow"><span class="ck" style="color:${TONES[tone][1]}">${label}</span>${val}</div>${right}</div>`;
const cnote = (tone, ic, html) => `<p class="cnote" style="--nbg:${TONES[tone][0]};--nfg:${TONES[tone][1]}">${cicon(ic, 16)}<span>${html}</span></p>`;

// ---------- Meteo: icone piatte nei colori dell'app, al posto delle emoji ----------
const WXC = {sun:'#F0A22E', moon:'#B9AEFF', cloud:'#C4C9D1', rain:'#3DA5F5', snow:'#E8EEF3', bolt:'#F0A22E'};
function wxSvg(c, day, s = 26){
 c = c ?? 0;
 const SUN = `<circle cx="12" cy="12" r="4.8" fill="${WXC.sun}"/><path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M5.2 18.8l1.7-1.7M17.1 6.9l1.7-1.7" stroke="${WXC.sun}" stroke-width="2" stroke-linecap="round" fill="none"/>`;
 const MOON = `<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z" fill="${WXC.moon}"/>`;
 const CLOUD = dy => `<path transform="translate(0 ${dy})" d="M7.5 19h9.2a3.9 3.9 0 0 0 .5-7.77A5.8 5.8 0 0 0 6 12.3 3.4 3.4 0 0 0 7.5 19z" fill="${WXC.cloud}"/>`;
 let g;
 if (c === 0) g = day ? SUN : MOON;
 else if (c <= 2) g = `<g transform="translate(-1.6 -1.8) scale(.72)">${day ? SUN : MOON}</g>${CLOUD(.8)}`;
 else if (c === 3) g = CLOUD(0);
 else if (c <= 48) g = `${CLOUD(-2.2)}<path d="M6 20.2h12M8 22.6h8" stroke="${WXC.cloud}" stroke-width="1.8" stroke-linecap="round"/>`;
 else if (c <= 67) g = `${CLOUD(-2.8)}<path d="M8.5 19.5l-1 2.6M12.5 19.5l-1 2.6M16.5 19.5l-1 2.6" stroke="${WXC.rain}" stroke-width="1.9" stroke-linecap="round"/>`;
 else if (c <= 77) g = `${CLOUD(-2.8)}<circle cx="8" cy="20.5" r="1.3" fill="${WXC.snow}"/><circle cx="12" cy="22" r="1.3" fill="${WXC.snow}"/><circle cx="16" cy="20.5" r="1.3" fill="${WXC.snow}"/>`;
 else if (c <= 82) g = `${CLOUD(-2.8)}<path d="M8.5 19.5l-1 2.6M12.5 19.5l-1 2.6M16.5 19.5l-1 2.6" stroke="${WXC.rain}" stroke-width="1.9" stroke-linecap="round"/>`;
 else g = `${CLOUD(-3.2)}<path d="M12.8 15.4l-2.6 3.6h2.5l-1.3 3.2 4-4.6h-2.7z" fill="${WXC.bolt}"/>`;
 return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true" style="display:block">${g}</svg>`;
}
const wxBg = (c, day) => (c ?? 0) === 0 && day ? '#3E3224' : (c ?? 0) <= 2 && !day ? '#2B2640' : '#343434';
const WXI = {
 water:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3DA5F5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 7c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/></svg>`,
 gust:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B9B9B3" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>`,
 rain:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3DA5F5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/></svg>`,
 sunr:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F0A22E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 4v3M5 10l2 2M19 10l-2 2"/></svg>`
};

// tessera della tavola: 40 px, come le altre icone delle carte
function btileSm(type, ft){ return `<span class="btile sm">${boardIcon(type, ft, 65, .84, 1.7)}</span>`; }

// ---------- Profilo: righello del peso (30-200kg, tacche ogni 0,1kg) ----------
const W_MIN = 30, W_MAX = 200, W_PX = 70;   // 70 px per chilo = 7 px ogni 0,1kg
function refboxHtml(pr){
 const hasLv = SURF_LEVELS.some(l => l.id === pr.level), okW = pr.weight >= 30 && pr.weight <= 200;
 return hasLv && okW ? `<div class="refbox"><p class="xs muted">Litri di riferimento per te</p><div class="bmeta">${['shortboard', 'fish', 'midlength', 'longboard'].map(t =>
  `<span class="bchip l" style="--bc:${BOARD_COLOR[t]}">${boardType(t).s} ~${Math.round(pr.weight * LKG[pr.level] * TYPE_F[t])}L</span>`).join('')}</div></div>` : '';
}
function rulerHtml(w){
 const tw = (W_MAX - W_MIN) * W_PX;
 let pat = `<line x1="1" y1="10" x2="1" y2="40" stroke="#6B5330" stroke-width="2"/>`;
 for (let i = 1; i < 10; i++) pat += `<line x1="${i*7+.5}" y1="20" x2="${i*7+.5}" y2="40" stroke="#4A4A4A" stroke-width="1"/>`;
 let labels = ''; for (let k = W_MIN; k <= W_MAX; k++) labels += `<span style="left:${(k - W_MIN) * W_PX}px">${k}</span>`;
 return `<div class="wruler">
  <div class="wbig"><input class="wnum" id="meW" type="text" inputmode="decimal" autocomplete="off" placeholder="75.0" value="${w != null ? Number(w).toFixed(1) : ''}" aria-label="Peso in chili: scrivilo oppure usa il righello"><span class="wkg">kg</span></div>
  <div class="wtrack" id="wTrack" role="slider" tabindex="0" aria-label="Righello del peso" aria-valuemin="${W_MIN}" aria-valuemax="${W_MAX}" aria-valuenow="${w ?? 75}" aria-valuetext="${w != null ? Number(w).toFixed(1) + ' chili' : 'non impostato'}">
   <div class="wscroll" id="wScroll"><div class="wticks" style="width:${tw + 2}px"><svg width="${tw + 2}" height="46" aria-hidden="true"><defs><pattern id="wpat" width="${W_PX}" height="46" patternUnits="userSpaceOnUse">${pat}</pattern></defs><rect width="${tw + 2}" height="46" fill="url(#wpat)"/></svg>${labels}</div></div>
   <div class="wmark" aria-hidden="true"></div></div></div>`;
}
function initRuler(sBox, pr){
 const sc = sBox.querySelector('#wScroll'), tr = sBox.querySelector('#wTrack'), num = sBox.querySelector('#meW'), err = sBox.querySelector('#meErr');
 let cur = pr.weight != null && pr.weight >= W_MIN && pr.weight <= W_MAX ? pr.weight : null, saved = cur, lockUntil = 0, settle = 0;
 const toX = v => (v - W_MIN) * W_PX, toV = x => Math.round((W_MIN + x / W_PX) * 10) / 10;
 const setX = v => { lockUntil = performance.now() + 160; sc.scrollLeft = toX(v); };      // spostamento da codice: non conta come gesto
 const aria = v => { tr.setAttribute('aria-valuenow', v); tr.setAttribute('aria-valuetext', v == null ? 'non impostato' : v.toFixed(1) + ' chili'); };
 const refresh = () => {
  const box = sBox.querySelector('.refbox'), html = refboxHtml(surfProfile());
  if (box){ if (html) box.outerHTML = html; else box.remove(); } else if (html) err.insertAdjacentHTML('afterend', html);
  updateMeSummaries();
 };
 const commit = v => {
  v = Math.round(v * 10) / 10; if (v === saved) return;
  saved = v; saveProfile({weight:v}); refresh(); toast(`Peso salvato: ${v.toFixed(1)}kg`);
 };
 // il righello si posiziona quando la sezione è visibile (da chiusa non ha larghezza) e a ogni cambio di misura
 if (window.ResizeObserver) new ResizeObserver(() => { if (sc.clientWidth) setX(cur ?? 75); }).observe(sc);
 else setX(cur ?? 75);
 sc.addEventListener('scroll', () => {
  if (performance.now() < lockUntil) return;
  const v = clamp(toV(sc.scrollLeft), W_MIN, W_MAX);
  cur = v; num.value = v.toFixed(1); aria(v); err.hidden = true;
  clearTimeout(settle); settle = setTimeout(() => { setX(v); commit(v); }, 380);
 }, {passive:true});
 // numero scritto a mano
 num.addEventListener('focus', () => num.select());
 num.addEventListener('keydown', e => { if (e.key === 'Enter') num.blur(); });
 num.addEventListener('change', () => {
  const raw = num.value.trim().replace(',', '.');
  if (!raw){ cur = null; saved = null; saveProfile({weight:null}); aria(null); refresh(); setX(75); toast('Peso rimosso'); return; }
  const w = parseFloat(raw);
  if (isNaN(w) || w < W_MIN || w > W_MAX){ err.hidden = false; err.textContent = 'Scrivi un peso tra 30 e 200kg.'; return; }
  err.hidden = true; cur = Math.round(w * 10) / 10; num.value = cur.toFixed(1); aria(cur); setX(cur); commit(cur);
 });
 // tastiera: frecce = 0,1kg, Maiusc = 1kg, Pag su/giù = 5kg
 tr.addEventListener('keydown', e => {
  const d = {ArrowLeft:-.1, ArrowDown:-.1, ArrowRight:.1, ArrowUp:.1, PageDown:-5, PageUp:5}[e.key]; if (d == null) return;
  e.preventDefault();
  const v = clamp(Math.round(((cur ?? 75) + (e.shiftKey && Math.abs(d) < 1 ? d * 10 : d)) * 10) / 10, W_MIN, W_MAX);
  cur = v; num.value = v.toFixed(1); aria(v); setX(v); clearTimeout(settle); settle = setTimeout(() => commit(v), 500);
 });
 // mouse: si trascina (il tocco usa lo scorrimento nativo)
 let drag = null;
 sc.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') return; drag = {x:e.clientX, s:sc.scrollLeft}; sc.setPointerCapture(e.pointerId); });
 sc.addEventListener('pointermove', e => { if (drag) sc.scrollLeft = drag.s - (e.clientX - drag.x); });
 const end = () => { drag = null; };
 sc.addEventListener('pointerup', end); sc.addEventListener('pointercancel', end);
}

// ---------- Settimana: righe dei giorni, complete (A) o compatte (B) ----------
const WK = {
 wind:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EC8D2C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>`,
 people:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A99BFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.4c.5-.2 1-.3 1.5-.3 2.5 0 4 2 4 4.9"/></svg>`,
 board:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#F0A22E" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c3.6 3 4.8 9 4.4 14.2C16.1 19.6 14.4 22 12 22s-4.1-2.4-4.4-5.8C7.2 11 8.4 5 12 2z"/><path d="M12 6v11"/></svg>`,
 chev:`<svg class="wchev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`
};
function weekRow(sp, d, isBest){
 const compact = true, w = d.best, ws = Math.round(w.ws);      // di partenza le righe sono compatte: un tocco apre il giorno
 const rng = `${d.minFace.toFixed(1)}–${d.maxFace.toFixed(1)}m`, lbl = dayLabel(d.day);
 return `<div class="wday${isBest ? ' best' : ''}${compact ? ' compact' : ''}" data-lbl="${lbl}">
  <button type="button" class="whead" aria-expanded="${!compact}" aria-label="${lbl}: ${compact ? 'espandi' : 'compatta'}">
   <span class="wdn"><b class="wfull">${lbl}</b><b class="wshort">${dayShort(d.day)}</b></span>
   <span class="wmid"><span class="wr"><b>${rng}</b><i class="adot" data-agdot="${d.day}" hidden></i></span><small>meglio alle ${d.bestHour}</small></span>
   <span class="wwc">${WK.wind}<span>${w.windType}<b>${ws}km/h</b></span></span>
   ${badge(w.score, 'sm')}${WK.chev}
  </button>
  <div class="wbody">
   <p class="wrng"><b>${rng}</b><span>meglio alle ${d.bestHour}</span></p>
   <p class="wwind">${WK.wind}<span>vento ${w.windType} <b>${ws}km/h</b></span></p>
   <p class="wchips"><span class="wchip">${WK.people}${crowdDay(sp, d).label.toLowerCase()}</span><span class="wchip">${WK.board}${esc(boardShort(sp, w))}</span></p>
   <p class="agree" data-agree="${d.day}"></p>
  </div>
 </div>`;
}
document.addEventListener('click', e => {
 const t = e.target; if (!t.closest) return;
 const hd = t.closest('.whead');
 if (hd){
  const row = hd.closest('.wday'), c = row.classList.toggle('compact');
  hd.setAttribute('aria-expanded', String(!c)); hd.setAttribute('aria-label', `${row.dataset.lbl}: ${c ? 'espandi' : 'compatta'}`);
  return;
 }
});

// ---------- Onde in arrivo: come la perturbazione arriva allo spot ----------
// "Arrivo" = prima ora in cui l'onda a riva (la stessa "face" di evaluate) raggiunge il minimo
// del range dello spot e ci resta per almeno 3 ore. Conta l'onda e non il punteggio, così un
// vento sfavorevole non nasconde la perturbazione. "Picco" = massimo da adesso in poi.
const WG_URL = 'waves-grid.json';
let wvGrid = null, wv = null;
const wvHm = k => k.slice(11,16);
const keyMs = k => Date.parse(k + ':00Z');   // le chiavi sono ora locale: servono solo per le differenze
function whenTxt(k){
 const d = k.slice(0,10), t = todayIso();
 const tom = new Date(keyMs(t + 'T12:00') + 864e5).toISOString().slice(0,10);
 return `${d === t ? 'oggi' : d === tom ? 'domani' : weekday(d).toLowerCase()} alle ${wvHm(k)}`;
}
function waveArrival(sp){
 const s = data[sp.id]; if (!s) return null;
 const i0 = currentIndex(s), n = s.time.length;
 const face = i => { const e = evaluate(sp, s, i); return e ? e.face : null; };
 const ok = i => { const f = face(i); return f != null && f >= sp.min; };
 const peakFrom = from => { let pk = null; for (let i = from; i < n; i++){ const f = face(i); if (f != null && (!pk || f > pk.f)) pk = {i, f}; } return pk; };
 if (face(i0) == null) return null;
 if (ok(i0)) return {state:'now', i0, s, peak:peakFrom(i0)};
 for (let i = i0 + 1; i < n - 2; i++) if (ok(i) && ok(i+1) && ok(i+2)) return {state:'soon', i0, arr:i, s, peak:peakFrom(i)};
 return {state:'none', i0, s, peak:peakFrom(i0)};
}
function waveThumb(state, dir){
 const on = state !== 'none', d = Math.round(dir ?? 290);
 const bands = on ? [6,14,22,30,38].map((y,i) => `<rect x="-24" y="${y-3}" width="96" height="6" fill="#2B96E3" opacity="${state === 'now' ? .55 : (.75 - i*.14).toFixed(2)}"/>`).join('') : '';
 const front = state === 'soon' ? '<path d="M-24 26H72" stroke="#F0A22E" stroke-width="1.6" stroke-dasharray="4 3"/>' : '';
 return `<svg class="wvthumb" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true"><defs><clipPath id="wvtc"><rect width="48" height="48" rx="14"/></clipPath></defs><g clip-path="url(#wvtc)"><rect width="48" height="48" fill="#17313F"/><g transform="rotate(${d} 24 24)"><g style="filter:blur(1.6px)">${bands}</g>${front}</g><circle cx="24" cy="24" r="4.5" fill="#F5F5F2" stroke="#F0A22E" stroke-width="2"/></g></svg>`;
}
function waveCardHtml(sp){
 const a = waveArrival(sp); if (!a) return '';
 const s = a.s, ev = i => evaluate(sp, s, i);
 let sub, dir = null;
 if (a.state === 'soon'){
  const e = ev(a.arr); dir = e.dir;
  sub = `Da ${cardinal(e.dir)}: arriva ${whenTxt(s.time[a.arr])}, picco ${a.peak.f.toFixed(1)} m ${whenTxt(s.time[a.peak.i])}`;
 } else if (a.state === 'now'){
  const e = ev(a.i0); dir = e.dir;
  sub = a.peak.i - a.i0 > 3 && a.peak.f > e.face + .3
   ? `Onde in corso da ${cardinal(e.dir)}, picco ${a.peak.f.toFixed(1)} m ${whenTxt(s.time[a.peak.i])}`
   : `Onde in corso da ${cardinal(e.dir)}, ${e.face.toFixed(1)} m`;
 } else sub = `Nessuna onda utile nei prossimi ${Math.max(1, Math.round((s.time.length - a.i0) / 24))} giorni`;
 return `<div class="ablock"><button class="wvcard" id="wvOpen" type="button" aria-label="Apri la mappa delle onde in arrivo. ${esc(sub)}">${waveThumb(a.state, dir)}<span class="wvt"><b>Onde in arrivo</b><span>${esc(sub)}</span></span><span class="wvx" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></span></button></div>`;
}

// colori del campo: onde in blu, vento in arancione (come nel resto dell'app)
const rampFn = stops => v => {
 if (v <= stops[0][0]) return stops[0][1];
 for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]){
  const [v0, c0] = stops[i-1], [v1, c1] = stops[i], f = (v - v0) / (v1 - v0);
  return `rgb(${c0.map((x, j) => Math.round(x + (c1[j] - x) * f)).join(',')})`;
 }
 return stops[stops.length-1][1];
};
const hexRgb = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16));
const toRamp = st => rampFn(st.map(([v, h]) => [v, hexRgb(h)])), asStr = c => Array.isArray(c) ? `rgb(${c})` : c;
const waveColor = (r => v => asStr(r(v)))(toRamp([[0,'#17313F'],[.5,'#1F6F9E'],[1.5,'#2B96E3'],[2.5,'#8FD0F8'],[4,'#E4F3FD']]));
const windColor = (r => v => asStr(r(v)))(toRamp([[0,'#2A2118'],[15,'#7A4A14'],[30,'#EC8D2C'],[50,'#FFD08A']]));

// livello Leaflet: campo colorato (canvas sfocato), linea tratteggiata del fronte e frecce
const FRONT_SEG = {1:['LB'],2:['BR'],3:['LR'],4:['RT'],5:['LT','BR'],6:['BT'],7:['LT'],8:['LT'],9:['BT'],10:['LB','RT'],11:['RT'],12:['LR'],13:['BR'],14:['LB']};
let WaveFieldCls = null;
const makeWaveField = () => L.Layer.extend({
 initialize(g){ this.g = g; this.t = 0; this.mode = 'waves'; this.thr = null; },
 onAdd(map){
  this._map = map;
  this._c = L.DomUtil.create('canvas', 'wvfield'); this._f = L.DomUtil.create('canvas', 'wvfront');
  const pane = map.getPane('overlayPane'); pane.appendChild(this._c); pane.appendChild(this._f);
  map.on('zoom zoomend moveend resize', this._soon, this); this._draw();
 },
 onRemove(map){ cancelAnimationFrame(this._raf); L.DomUtil.remove(this._c); L.DomUtil.remove(this._f); map.off('zoom zoomend moveend resize', this._soon, this); this._map = null; },
 _soon(){ if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); }); },
 setState(t, mode, thr){ this.t = t; this.mode = mode; this.thr = thr; if (this._map) this._draw(); },
 _idx(lat, lon){
  const g = this.g, fy = (lat - g.lat0) / g.step, fx = (lon - g.lon0) / g.step;
  return (fy < 0 || fx < 0 || fy > g.nlat - 1 || fx > g.nlon - 1) ? null : {fy, fx};
 },
 _val(arr, lat, lon){   // media pesata dei nodi con dato; this._w = quanto peso viene dal mare (verso la costa il campo sfuma)
  const p = this._idx(lat, lon); this._w = 0; if (!p) return null;
  const g = this.g, y0 = Math.min(g.nlat - 2, Math.floor(p.fy)), x0 = Math.min(g.nlon - 2, Math.floor(p.fx)), dy = p.fy - y0, dx = p.fx - x0;
  let sum = 0, w = 0;
  for (const [yy, xx, ww] of [[y0,x0,(1-dy)*(1-dx)],[y0,x0+1,(1-dy)*dx],[y0+1,x0,dy*(1-dx)],[y0+1,x0+1,dy*dx]]){
   const v = arr[yy * g.nlon + xx]; if (v != null){ sum += v * ww; w += ww; }
  }
  this._w = w; return w < .45 ? null : sum / w;
 },
 _near(arr, lat, lon){ const p = this._idx(lat, lon); return p ? arr[Math.round(p.fy) * this.g.nlon + Math.round(p.fx)] : null; },
 _front(fx, PAD){   // linea dove l'onda arriva all'altezza minima dello spot (marching squares sui nodi della griglia)
  const m = this._map, g = this.g, h = g.hs[this.t], T = this.thr, nl = g.nlon;
  const pt = (j, i) => { const p = m.latLngToContainerPoint([g.lat0 + j * g.step, g.lon0 + i * g.step]); return [p.x + PAD, p.y + PAD]; };
  const lerp = (v0, v1, p0, p1) => { const f = (T - v0) / (v1 - v0); return [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f]; };
  fx.beginPath();
  for (let j = 0; j < g.nlat - 1; j++) for (let i = 0; i < nl - 1; i++){
   const a = h[j*nl + i], b = h[j*nl + i + 1], c = h[(j+1)*nl + i + 1], d = h[(j+1)*nl + i];
   if (a == null || b == null || c == null || d == null) continue;
   const k = (a >= T ? 1 : 0) | (b >= T ? 2 : 0) | (c >= T ? 4 : 0) | (d >= T ? 8 : 0);
   if (k === 0 || k === 15) continue;
   const A = pt(j, i), B = pt(j, i + 1), C = pt(j + 1, i + 1), D = pt(j + 1, i);
   const E = {L:() => lerp(a, d, A, D), B:() => lerp(a, b, A, B), R:() => lerp(b, c, B, C), T:() => lerp(d, c, D, C)};
   for (const s of FRONT_SEG[k]){ const p = E[s[0]](), q = E[s[1]](); fx.moveTo(p[0], p[1]); fx.lineTo(q[0], q[1]); }
  }
  fx.strokeStyle = '#F0A22E'; fx.lineWidth = 2.6; fx.lineCap = 'butt'; fx.setLineDash([7, 5]); fx.stroke(); fx.setLineDash([]);
 },
 _draw(){
  const m = this._map; if (!m) return;
  const PAD = 160, B = 8, sz = m.getSize(), W = sz.x + 2*PAD, H = sz.y + 2*PAD, tl = m.containerPointToLayerPoint([-PAD, -PAD]);
  for (const cv of [this._c, this._f]){ cv.width = W; cv.height = H; L.DomUtil.setPosition(cv, tl); }
  const g = this.g, wind = this.mode === 'wind', t = this.t;
  const arr = wind ? g.ws[t] : g.hs[t], dirs = wind ? g.wd[t] : g.dir[t];
  const cx = this._c.getContext('2d'), fx = this._f.getContext('2d'), col = wind ? windColor : waveColor;
  const ll = (x, y) => m.containerPointToLatLng([x - PAD, y - PAD]);
  for (let y = 0; y < H; y += B) for (let x = 0; x < W; x += B){
   const p = ll(x + B/2, y + B/2), v = this._val(arr, p.lat, p.lng);
   if (v == null) continue;
   cx.globalAlpha = Math.max(.2, Math.min(1, (this._w - .45) / .45)); cx.fillStyle = col(v); cx.fillRect(x, y, B, B);
  }
  cx.globalAlpha = 1;
  if (!wind && this.thr != null) this._front(fx, PAD);
  fx.strokeStyle = wind ? '#FFD08A' : 'rgba(228,243,253,.9)'; fx.lineWidth = 1.6; fx.lineCap = 'round'; fx.lineJoin = 'round';
  for (let y = 24; y < H; y += 48) for (let x = 24; x < W; x += 48){
   const p = ll(x, y), v = this._val(arr, p.lat, p.lng); if (v == null || this._w < .8 || v < (wind ? 3 : .25)) continue;
   const d = this._near(dirs, p.lat, p.lng); if (d == null) continue;
   fx.save(); fx.translate(x, y); fx.rotate((d + 180) * Math.PI / 180);   // la direzione è "da": la freccia va dove viaggia l'onda
   fx.beginPath(); fx.moveTo(0, 7); fx.lineTo(0, -7); fx.moveTo(-4, -2.5); fx.lineTo(0, -7); fx.moveTo(4, -2.5); fx.lineTo(0, -7); fx.stroke(); fx.restore();
  }
 }
});

async function loadWaveGrid(){
 if (wvGrid) return wvGrid;
 return wvGrid = await getJson(WG_URL + '?v=' + Math.floor(Date.now() / 6e5), {cache:'no-cache'}, 2);
}
function closeWaveMap(){
 if (!wv) return;
 wv.stop?.(); document.removeEventListener('keydown', wv.onKey);
 try{ wv.map.remove(); }catch(e){}
 wv.root.remove(); document.body.classList.remove('locked'); wv.opener?.focus?.(); wv = null;
}
async function openWaveMap(id){
 const sp = spots.find(x => x.id === id), s = data[id];
 if (!sp || !s) return;
 if (!window.L){ toast('Mappa non disponibile: controlla la connessione.', 'err'); return; }
 closeWaveMap();
 const opener = document.activeElement;
 let grid = null, away = false;
 try{ grid = await loadWaveGrid(); }catch(e){ console.warn('Griglia onde non disponibile', e); }
 const nowK = nowKey(), a = waveArrival(sp), b = beach(sp);
 const gb = grid && [[grid.lat0, grid.lon0], [grid.lat0 + (grid.nlat - 1) * grid.step, grid.lon0 + (grid.nlon - 1) * grid.step]];
 if (grid && !(b.lat >= gb[0][0] && b.lat <= gb[1][0] && b.lon >= gb[0][1] && b.lon <= gb[1][1])){ grid = null; away = true; }
 const times = grid ? grid.times : s.time.filter(k => k >= nowK && +k.slice(11,13) % 3 === 0).slice(0, 40);
 if (!times.length) return;
 let tNow = 0; times.forEach((k, i) => { if (k <= nowK) tNow = i; });
 const faces = times.map(k => { const i = s.time.indexOf(k), e = i >= 0 ? evaluate(sp, s, i) : null; return e ? e.face : 0; });
 const fmax = Math.max(1, ...faces);
 let tPeak = tNow; faces.forEach((f, i) => { if (i >= tNow && f > faces[tPeak]) tPeak = i; });
 const tArr = a && a.state === 'soon' ? Math.max(0, times.findIndex(k => k >= s.time[a.arr])) : null;
 const refI = a ? (a.state === 'soon' ? a.arr : a.i0) : currentIndex(s), re = evaluate(sp, s, refI);
 const thr = sp.min / (re && re.hs ? clamp(re.face / re.hs, .3, 1.3) : 1);
 const upd = grid?.generated ? new Intl.DateTimeFormat('it-IT', {timeZone:TZ, hour:'2-digit', minute:'2-digit'}).format(new Date(grid.generated)) : null;
 const stops = [{t:tNow, l:'Adesso', s:wvHm(times[tNow])}];
 if (tArr != null && tArr !== tNow) stops.push({t:tArr, l:'Arrivo', s:`${weekday(times[tArr].slice(0,10)).slice(0,3)} ${wvHm(times[tArr])}`});
 if (a && a.state !== 'none' && faces[tPeak] > 0 && tPeak !== tNow) stops.push({t:tPeak, l:'Picco', s:`${weekday(times[tPeak].slice(0,10)).slice(0,3)} ${wvHm(times[tPeak])}`});
 stops.sort((x, y) => x.t - y.t);
 const PLAY_ICO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>', PAUSE_ICO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
 const root = document.createElement('div');
 root.id = 'wvmap'; root.className = 'wvmap'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', `Onde in arrivo, ${sp.name}`);
 const dayMarks = times.map((k, i) => (i === 0 || k.slice(0,10) !== times[i-1].slice(0,10)) ? `<span style="left:${(i / times.length * 100).toFixed(2)}%">${weekday(k.slice(0,10)).slice(0,3)}</span>` : '').join('');
 root.innerHTML = `<div class="wvleaf" id="wvLeaf"></div>
  <header class="wvhead"><button type="button" class="wvbtn" id="wvBack" aria-label="Chiudi la mappa"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
   <div class="wvttl"><b>${esc(sp.name)}</b><span>Onde in arrivo${upd ? ' · agg. ' + upd : ''}</span></div>
   <button type="button" class="wvbtn" id="wvCenter" aria-label="Ricentra sullo spot"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button></header>
  <div class="wvchips" role="group" aria-label="Livello"><button type="button" aria-pressed="true" data-m="waves">Onde</button><button type="button" aria-pressed="false" data-m="wind">Vento</button></div>
  <div class="wvlegend" id="wvLegend"></div>
  <p class="wvnote" ${grid ? 'hidden' : ''}>${away ? 'Il campo delle onde copre per ora solo la Sardegna: qui vedi solo lo spot.' : 'Campo delle onde non disponibile: vedi solo lo spot.'}</p>
  <section class="wvsheet"><div class="wvrow"><button type="button" class="wvplay" id="wvPlay" aria-pressed="false" aria-label="Avvia l'animazione">${PLAY_ICO}</button><b id="wvTime"></b><span class="wvchip" id="wvChip"></span></div>
   <div class="wvread"><div><i>Onde</i><b id="wvW"></b><span id="wvWs"></span></div><div><i>Vento</i><b id="wvV"></b><span id="wvVs"></span></div></div>
   <div class="wvscrub" id="wvScrub" role="slider" tabindex="0" aria-label="Ora della previsione" aria-valuemin="0" aria-valuemax="${times.length - 1}">${faces.map((f, i) => `<i data-i="${i}" style="height:${Math.max(7, f / fmax * 100).toFixed(1)}%"></i>`).join('')}<u class="wvnow" style="left:${((tNow + .5) / times.length * 100).toFixed(2)}%"></u>${tArr != null ? `<em class="wvflag" style="left:${((tArr + .5) / times.length * 100).toFixed(2)}%" title="Arrivo"></em>` : ''}</div>
   <div class="wvdays" aria-hidden="true">${dayMarks}</div>
   <div class="wvstops" role="group" aria-label="Salta a">${stops.map(x => `<button type="button" class="wvstop" data-t="${x.t}" aria-pressed="false"><i>${x.l}</i><b>${x.s}</b></button>`).join('')}</div></section>`;
 document.body.appendChild(root); document.body.classList.add('locked');

 const map = L.map('wvLeaf', {zoomControl:false, attributionControl:true, zoomSnap:.5, minZoom:grid ? 7.5 : 7, maxZoom:11, zoomAnimation:false, markerZoomAnimation:false, fadeAnimation:false, maxBounds:gb || undefined, maxBoundsViscosity:1});
 L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {maxZoom:18, maxNativeZoom:16, attribution:'Tiles &copy; Esri · Onde: Open-Meteo'}).addTo(map);
 const field = grid ? new (WaveFieldCls ||= makeWaveField())(grid).addTo(map) : null;
 L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {maxZoom:18, maxNativeZoom:16, pane:'shadowPane'}).addTo(map);
 const marker = L.marker([b.lat, b.lon], {interactive:false, keyboard:false}).addTo(map);
 const center = () => { map.setView([b.lat, b.lon], 8.5, {animate:false}); map.panBy([0, Math.round(innerHeight * .2)], {animate:false}); };
 center();

 let cur = tNow, mode = 'waves';
 const $ = q => root.querySelector(q), bars = [...root.querySelectorAll('#wvScrub i')];
 const rel = k => Math.round((keyMs(k) - keyMs(nowK)) / 36e5);
 function legend(){
  $('#wvLegend').innerHTML = mode === 'waves'
   ? '<i style="background:linear-gradient(90deg,#17313F,#1F6F9E,#2B96E3,#8FD0F8,#E4F3FD)"></i><span>0.5 → 3 m</span>'
   : '<i style="background:linear-gradient(90deg,#2A2118,#7A4A14,#EC8D2C,#FFD08A)"></i><span>0 → 50 km/h</span>';
 }
 function show(t){
  cur = clamp(t, 0, times.length - 1);
  const k = times[cur], si = s.time.indexOf(k), e = si >= 0 ? evaluate(sp, s, si) : null;
  field?.setState(cur, mode, thr);
  const [bg, fg] = tone(e?.score);
  marker.setIcon(L.divIcon({className:'', iconSize:[34,34], iconAnchor:[17,17], html:`<div class="pin sel" style="--c:${bg};--fg:${fg}">${e?.score ?? '–'}</div>`}));
  const day = weekday(k.slice(0,10)).slice(0,3).toUpperCase();
  $('#wvTime').textContent = cur === tNow ? `ADESSO · ${day} ${wvHm(k)}` : `${day} ${wvHm(k)}${cur === tArr ? ' · ARRIVO' : cur === tPeak ? ' · PICCO' : ''}`;
  $('#wvChip').textContent = cur === tNow ? (a?.state === 'soon' ? (rel(s.time[a.arr]) <= 1 ? 'Arriva a breve' : `Arriva fra ${rel(s.time[a.arr])} ore`) : a?.state === 'now' ? 'Onde in corso' : 'Nessun arrivo') : (cur > tNow ? `Fra ${rel(k)} ore` : `${-rel(k)} ore fa`);
  $('#wvW').textContent = e ? `${e.face.toFixed(1)} m · ${Math.round(e.T)} s` : 'n.d.';
  $('#wvWs').textContent = e ? `da ${cardinal(e.dir)} ${Math.round(e.dir)}°` : '';
  $('#wvV').textContent = e ? `${Math.round(e.ws)} km/h` : 'n.d.';
  $('#wvVs').textContent = e ? `da ${cardinal(e.wd)}${e.windType === 'offshore' ? ' · offshore' : ''}` : '';
  bars.forEach((el, i) => { el.className = (i === cur ? 'sel ' : '') + (i < tNow ? 'past' : ''); });
  const sl = $('#wvScrub'); sl.setAttribute('aria-valuenow', cur); sl.setAttribute('aria-valuetext', `${day} ${wvHm(k)}`);
  root.querySelectorAll('.wvstop').forEach(bn => bn.setAttribute('aria-pressed', +bn.dataset.t === cur));
 }
 let timer = null;
 const playBtn = $('#wvPlay');
 const setPlay = on => {
  if (on === !!timer) return;
  if (on){ if (cur >= times.length - 1) show(tNow); timer = setInterval(() => show(cur >= times.length - 1 ? tNow : cur + 1), 420); }
  else { clearInterval(timer); timer = null; }
  playBtn.innerHTML = on ? PAUSE_ICO : PLAY_ICO; playBtn.setAttribute('aria-pressed', on);
  playBtn.setAttribute('aria-label', on ? "Metti in pausa l'animazione" : "Avvia l'animazione");
 };
 playBtn.onclick = () => setPlay(!timer);
 root.querySelectorAll('.wvstop').forEach(bn => bn.onclick = () => { setPlay(false); show(+bn.dataset.t); });
 $('#wvBack').onclick = closeWaveMap;
 $('#wvCenter').onclick = center;
 root.querySelectorAll('.wvchips button').forEach(bn => bn.onclick = () => {
  mode = bn.dataset.m; root.querySelectorAll('.wvchips button').forEach(x => x.setAttribute('aria-pressed', x === bn)); legend(); show(cur);
 });
 const sc = $('#wvScrub'); let drag = false;
 const idxAt = x => { const r = sc.getBoundingClientRect(); return Math.round(clamp((x - r.left) / r.width * times.length - .5, 0, times.length - 1)); };
 sc.onpointerdown = e => { setPlay(false); drag = true; sc.setPointerCapture(e.pointerId); show(idxAt(e.clientX)); };
 sc.onpointermove = e => { if (drag) show(idxAt(e.clientX)); };
 sc.onpointerup = sc.onpointercancel = () => { drag = false; };
 sc.onkeydown = e => { const d = {ArrowLeft:-1, ArrowRight:1, ArrowDown:-1, ArrowUp:1}[e.key]; if (d){ e.preventDefault(); setPlay(false); show(cur + d); } };
 const onKey = e => { if (e.key === 'Escape') closeWaveMap(); };
 document.addEventListener('keydown', onKey);
 wv = {root, map, onKey, opener, stop:() => setPlay(false)};
 legend(); show(tNow); $('#wvBack').focus();
}

function openDetail(id){
 const sp = spots.find(s=>s.id===id), s = data[id];
 if (!sp || !s) return;
 curDetail = id;
 const ev = nowEval(sp), days = forecastDays(sp);
 const best = days.reduce((a,d)=> !a || d.best.score > a.best.score ? d : a, null);
 const custom = !baseSpots.some(b=>b.id===id), isFav = favorite === id, fol = isFollowed(sp);
 const backTo = {spot:'Tutti gli spot', map:'Mappa', alert:'Alert', me:'Profilo'}[lastTab];
 const el = document.getElementById('v-detail');
 el.innerHTML = `${detailTop(sp, ev, backTo, fol, isFav)}
  ${idStrip(sp, custom)}
  <div class="sheet" id="dialSheet" hidden><div class="sheet-bg" data-close></div>
   <div class="sheet-p" role="dialog" aria-modal="true" aria-labelledby="sheetT">
    <div class="sheet-h"><h2 id="sheetT">Come leggere il cerchio</h2><button class="sheet-x" data-close aria-label="Chiudi">×</button></div>
    <p class="small muted" style="margin-top:6px">Un solo anello: gli archi dicono dove va bene, i marker dove sono adesso onde e vento. Il nord è in alto.</p>
    ${dirSheetHtml(sp, ev)}
   </div></div>
  <nav class="dtabs" id="dtabs" role="tablist" aria-label="Sezioni dello spot">
   <button role="tab" data-tab-d="now" aria-selected="true">Adesso</button><button role="tab" data-tab-d="boa" aria-selected="false">Misurato</button><button role="tab" data-tab-d="week" aria-selected="false">Settimana</button><button role="tab" data-tab-d="info" aria-selected="false">Meteo</button></nav>

  <section class="dsec t-now tpanel" id="sec-now" data-panel="now">
   <div class="adesso">
   ${ev ? `<div class="ablock">${periodCell(sp, ev.T)}</div>` : ''}
   ${windowHtml(sp)}
   ${ev ? crowdHtml(sp, crowdNow(sp, ev)) : ''}
   ${ev ? boardHtml(sp, ev) : ''}${waveCardHtml(sp)}</div>
   <div id="sec-cams">${camsHtml(sp)}</div>
   <button class="pillbtn logbtn" id="logOpen"><span>Registra una sessione</span></button>
  </section>

  <section class="dsec t-now tpanel" id="sec-boa" data-panel="boa" hidden>
   <div class="adesso"><div id="buoyBox" data-spot="${sp.id}"></div><div id="agreeBox"></div></div>
  </section>
  <div class="tpanel" data-panel="boa" hidden>
  <section class="dsec t-cal" id="sec-cal">
   ${MOTIF.cal}
   ${secToggle('cal', 'Taratura', 'Le tue sessioni confrontate con le previsioni', calSummary(sp), calInfo(sp))}
   <div id="body-cal" hidden><div id="calBox">${calHtml(sp)}</div></div>
  </section>
  </div>

  <div class="tpanel" data-panel="week" hidden>
  <section class="dsec t-week${best && best.best.score >= 2.5 ? ' good' : ''}" id="sec-week" style="--goodbg:color-mix(in srgb, ${tone(best?.best.score)[0]} 32%, #fff)">
   ${MOTIF.week}
   ${secToggle('week', 'Settimana', 'Previsione dei prossimi 7 giorni: onda a riva alle 8, 11, 14 e 17', weekSummary(best), weekInfo(days))}
   <div id="body-week" hidden>
   <p class="xs muted" style="margin-bottom:10px">L'altezza della barra è l'onda, il colore è il punteggio. La fascia chiara è il range surfabile dello spot (${sp.min}–${sp.max}m).</p>
   ${chartHtml(sp)}
   <div class="wlisthd"><h3>Giorno per giorno</h3></div>
   <div class="wlist">${days.map(d => weekRow(sp, d, best && best === d && d.best.score >= ACTIVE_FROM)).join('')}</div>
   </div>
  </section>

  <section class="dsec t-season" id="sec-season">
   ${MOTIF.season}
   ${secToggle('season', 'Stagioni', 'Quando lo spot lavora, mese per mese', seasonSummary(sp), seasonInfo(sp))}
   <div id="body-season" hidden><div id="seasonBox" data-spot="${sp.id}">${seasonHtml(sp)}</div></div>
  </section>

  </div>

  <div class="tpanel" data-panel="info" hidden>
  <section class="dsec t-wx" id="sec-wx">
   <span id="wxMotif">${MOTIF.wx}</span>
   ${secToggle('wx', 'Meteo', 'Cielo, acqua e prossime ore sullo spot', '<span>…</span>', 'Carico…')}
   <div id="body-wx" hidden><div id="extraWx" data-spot="${sp.id}"><p class="small muted">Carico il meteo…</p></div></div>
  </section>

  <section class="dsec t-tide" id="sec-tide">
   ${MOTIF.tide}
   ${secToggle('tide', 'Marea', 'Alte e basse di oggi', '<span>…</span>', 'Carico…')}
   <div id="body-tide" hidden><div id="extraTide" data-spot="${sp.id}"><p class="small muted">Carico la marea…</p></div></div>
  </section>

  </div>

  <div class="dfoot"${custom ? '' : ' hidden'}>
  ${custom ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${!Cloud.user ? '' : Cloud.admin ? '<button class="pillbtn primary" id="pubSpot" style="width:auto">Pubblica come spot ufficiale</button>' : sp.visibility === 'proposed' ? '<span class="small muted" style="align-self:center">Proposto alla community: in attesa di approvazione</span>' : '<button class="pillbtn primary" id="propSpot" style="width:auto">Proponi alla community</button>'}<button class="pillbtn" id="editSpot">Modifica</button><button class="pillbtn" id="delSpot">Elimina spot</button>
  <a class="pillbtn" href="https://www.openstreetmap.org/edit#map=18/${beach(sp).lat}/${beach(sp).lon}" target="_blank" rel="noopener" style="text-decoration:none">Segnalalo su OpenStreetMap ↗</a></div>
  <p class="xs muted" id="copyMsg" style="margin-top:8px">${Cloud.user ? 'Lo spot è personale: lo vedi solo tu, su tutti i tuoi dispositivi.' : 'Entra con l\'account (Profilo › Account) per salvarlo online e poterlo condividere.'}</p>` : ''}
  </div>`;
 showView('detail');
 mountTiles(ev);
 initDetailNav();
 loadExtra(sp);
 bindSeason(sp);
 bindCal(sp);
 loadAgreement(sp);
 renderBuoy(sp);
 document.getElementById('back').onclick = ()=>setTab(lastTab);
 const wvo = document.getElementById('wvOpen'); if (wvo) wvo.onclick = ()=>openWaveMap(id);
 const sheet = document.getElementById('dialSheet'), opener = document.getElementById('dialBtn');
 const closeSheet = ()=>{ sheet.hidden = true; document.body.classList.remove('locked'); document.removeEventListener('keydown', onKey); opener.focus(); };
 const onKey = e=>{ if (e.key === 'Escape') closeSheet(); };
 opener.onclick = ()=>{ sheet.hidden = false; document.body.classList.add('locked'); document.addEventListener('keydown', onKey); sheet.querySelector('.sheet-x').focus(); };
 sheet.addEventListener('click', e=>{ if (e.target.closest('[data-close]')) closeSheet(); });
 document.getElementById('favBtn').onclick = ()=>{ favorite = favorite === id ? null : id; store.set('surf.favorite', favorite); openDetail(id); };
 document.getElementById('followBtn').onclick = ()=>{
  toggleFollow(id); openDetail(id);
  const on = isFollowed(sp), h = document.querySelector('#v-detail .hero');
  if (on) document.getElementById('followBtn')?.classList.add('ring');
  if (h){ const t = document.createElement('p'); t.className = 'htoast'; t.setAttribute('role','status');
   t.textContent = on ? `Alert attivi: ti avvisiamo quando ${sp.name} arriva a ${threshold}/5.` : 'Alert disattivati per questo spot.';
   h.appendChild(t); setTimeout(()=>t.remove(), 3500); }
 };
 const msgEl = () => document.getElementById('copyMsg');
 const pub = document.getElementById('pubSpot'), prop = document.getElementById('propSpot');
 if (pub) pub.onclick = async ()=>{ try{ await Cloud.setVisibility(id, 'public'); baseSpots = []; await refresh(); openDetail(id); }catch(e){ msgEl().textContent = 'Non riuscito: ' + e.message; } };
 if (prop) prop.onclick = async ()=>{ try{ await Cloud.setVisibility(id, 'proposed'); openDetail(id); }catch(e){ msgEl().textContent = 'Non riuscito: ' + e.message; } };
 const ca = document.getElementById('camAdd');
 if (ca) ca.onclick = ()=>{
  const url = prompt('Incolla il link della webcam'); if (!url || !/^https?:\/\//.test(url.trim())) return;
  const name = prompt('Come la chiamo?', sp.name) || sp.name;
  let src = 'Webcam'; try{ src = new URL(url.trim()).hostname.replace(/^www\./,''); }catch(e){}
  const list = Data.spots.all(), i = list.findIndex(x=>x.id===id);
  if (i < 0) return;
  list[i].cams = [...(list[i].cams || []), {name, url:url.trim(), src}];
  Data.spots.save(list[i]);
  spots = spots.map(x => x.id === id ? list[i] : x);
  openDetail(id);
 };
 const ed = document.getElementById('editSpot'), idE = document.getElementById('idEdit');
 if (ed) ed.onclick = ()=>openAdd(sp);
 if (idE) idE.onclick = ()=>openAdd(sp);
 const del = document.getElementById('delSpot');
 if (del) del.onclick = ()=>{
  Data.spots.remove(id);
  spots = spots.filter(s=>s.id!==id); delete data[id];
  if (favorite === id){ favorite = null; store.set('surf.favorite', null); }
  if (leafPins[id]){ myLayer.removeLayer(leafPins[id]); delete leafPins[id]; }
  setTab('spot');
 };
}
// ---------- Webcam pubbliche (link esterni: questi siti non si lasciano incorporare) ----------
const CAM = {
 capo:{lat:40.025, lon:8.400, name:'Putzu Idu, Capo Mannu e Mini Capo', src:'Panoramicams', url:'https://panoramicams.com/putzu-idu-capo-mannu/'},
 arco:{lat:40.016, lon:8.406, name:"Putzu Idu, arco di S'Architteddu", src:'WhatsupCams', url:'https://www.whatsupcams.com/en/webcams/italy/sardinia/oristano/live-webcam-putzu-idu-beach-arco-di-sarchitteddu-oristano-livecam-sardinia-italy/'},
 sg1:{lat:39.878, lon:8.438, name:'San Giovanni di Sinis', src:'Panoramicams', url:'https://panoramicams.com/san-giovanni-di-sinis/'},
 sg2:{lat:39.878, lon:8.438, name:'San Giovanni di Sinis, spiaggia', src:'WhatsupCams', url:'https://www.whatsupcams.com/en/webcams/italy/sardinia/oristano/live-webcam-san-giovanni-di-sinis-beach-oristano-sardinia-tourism-italy/'},
 sg3:{lat:39.878, lon:8.438, name:'San Giovanni di Sinis, con dati meteo', src:'Vedetta', url:'https://vedetta.org/en/webcam/Italy/Sardinia/oristano/San-Giovanni-Sinis/'},
 // Lazio, Santa Marinella
 banzai:{lat:42.029, lon:11.849, name:'Banzai, lineup', src:'SurfCamItalia', url:'https://surfcamitalia.it/spot/banzai-santa-marinella/'},
 toscana:{lat:42.031, lon:11.847, name:'La Toscana (a nord di Banzai)', src:'SurfCamItalia', url:'https://surfcamitalia.it/spot/la-toscana-santa-marinella/'},
 banzaisc:{lat:42.029, lon:11.849, name:'Banzai Sporting Club', src:'Banzai SC', url:'https://webcam.banzaisportingclub.it/'}
};
const SPOT_CAMS = {
 'capo-mannu':['capo'], 'mini-capo':['capo'], 'godzilla':['capo'], 'la-punta':['capo'], 'lo-scivolo':['capo','arco'], 'putzu-idu':['capo','arco'],
 'sg-la-torre':['sg1','sg2','sg3'], 'sg-scalini':['sg1','sg2','sg3']
};
// webcam entro 4km dalla spiaggia: così anche gli spot che aggiungi tu se le ritrovano
const camsNear = p => Object.values(CAM).filter(c => distanceKm(p, c) <= 4);
function camsHtml(sp){
 const list = [...(SPOT_CAMS[sp.id] ? SPOT_CAMS[sp.id].map(k=>CAM[k]) : camsNear(beach(sp))), ...(sp.cams || [])];
 const custom = !baseSpots.some(b=>b.id===sp.id);
 if (!list.length && !custom) return '';
 return `<div class="cams"><p class="xs muted">${list.length ? 'Webcam live nella zona: guarda onde e gente con i tuoi occhi' : 'Nessuna webcam conosciuta in zona'}</p><div class="list">${list.map(c=>
  `<a href="${esc(c.url)}" target="_blank" rel="noopener"><i class="live" aria-hidden="true"></i><span>${esc(c.name)}</span><span class="xs muted" style="flex:0 0 auto;font-weight:500">${esc(c.src)} ↗</span></a>`).join('')}</div>
  ${custom ? `<button class="pillbtn add" id="camAdd">${ICON_PLUS}Aggiungi una webcam</button>` : ''}</div>`;
}

// ---------- Affollamento stimato (una previsione, non una misura) ----------
const SPOT_POP = {'mini-capo':1, 'capo-mannu':.9, 'putzu-idu':.9, 'lo-scivolo':.8, 'la-punta':.7, 'sa-mesa-longa':.7, 'sg-la-torre':.8, 'sg-scalini':.7, 'godzilla':.5, 'su-pallosu':.5};
function easter(y){ const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1; return new Date(Date.UTC(y,mo-1,da)); }
function dayKind(iso){
 const d = new Date(iso+'T12:00:00Z'), wd = d.getUTCDay(), md = iso.slice(5);
 const fixed = ['01-01','01-06','04-25','05-01','06-02','08-15','11-01','12-08','12-25','12-26'];
 const pasquetta = new Date(easter(d.getUTCFullYear()).getTime() + 86400000).toISOString().slice(5,10);
 if (fixed.includes(md) || md === pasquetta) return 'festivo';
 if (wd === 0) return 'domenica'; if (wd === 6) return 'sabato';
 return 'feriale';
}
function flatBefore(sp, day){
 const s = data[sp.id]; if (!s) return false;
 const from = new Date(new Date(day+'T12:00:00Z').getTime() - 3*86400000).toISOString().slice(0,10);
 let best = null;
 for (let i = 0; i < s.time.length; i++){
  const t = s.time[i]; if (t < from || t >= day) continue;
  const h = +t.slice(11,13); if (h < DAY_START || h > DAY_END) continue;
  const e = evaluate(sp, s, i); if (e) best = Math.max(best ?? 0, e.score);
 }
 return best != null && best < 2.5;
}
function crowdCalc(sp, score, day, hour){
 const why = [];
 const q = score < 1.5 ? .05 : score < 2.5 ? .25 : score < 3.5 ? .55 : score < 4.5 ? .8 : 1;
 if (score >= 3.5) why.push('onde buone');
 const kind = dayKind(day), month = +day.slice(5,7);
 let dayF = kind === 'feriale' ? (month === 8 ? .85 : .6) : 1;
 if (kind !== 'feriale') why.push(kind === 'festivo' ? 'giorno festivo' : kind);
 else if (month === 8) why.push('agosto');
 const hourF = hour < 7 || hour > 20 ? .1 : hour < 9 ? .8 : hour < 12 ? 1 : hour < 15 ? .7 : hour < 18 ? 1 : .6;
 const pop = SPOT_POP[sp.id] ?? .6;
 if (pop >= .9) why.push('spot molto frequentato'); else if (pop <= .5) why.push('spot poco battuto');
 const rare = score >= 3 && flatBefore(sp, day);
 if (rare) why.push('prime onde dopo giorni di piatto');
 const x = Math.min(1, q * dayF * hourF * pop * (rare ? 1.25 : 1) * 1.15);
 let lvl = x < .15 ? 0 : x < .35 ? 1 : x < .6 ? 2 : 3;
 const fix = crowdFix(sp);
 if (fix && score >= 1.5){ lvl = Math.max(0, Math.min(3, Math.round(lvl + fix.shift))); if (Math.abs(fix.shift) >= .5) why.push(`corretta con le tue ${fix.n} segnalazioni`); }
 if (score < 1.5) why.splice(0, why.length, 'onde quasi assenti, in acqua non va quasi nessuno');
 else if (score < 2.5) why.unshift('onde scarse');
 return {lvl, label:['Probabilmente vuoto','Poca gente','Un po\' di gente','Affollato'][lvl], why};
}
// scarto medio tra quanta gente hai trovato e quanta ne stimava l'app, nelle tue sessioni su questo spot
function crowdFix(sp){
 if (!sp) return null;
 const rows = Data.sessions.bySpot(sp.id).filter(x => x.affollamento_1_4 && x.punteggio_app !== '');
 if (rows.length < 3) return null;
 const d = rows.map(x => { const base = crowdCalcRaw(sp, x.punteggio_app, x.data, +x.ora.slice(0,2)); return (x.affollamento_1_4 - 1) - base; });
 return {n: rows.length, shift: d.reduce((a,b)=>a+b,0)/d.length};
}
function crowdCalcRaw(sp, score, day, hour){
 const q = score < 1.5 ? .05 : score < 2.5 ? .25 : score < 3.5 ? .55 : score < 4.5 ? .8 : 1;
 const kind = dayKind(day), month = +day.slice(5,7), dayF = kind === 'feriale' ? (month === 8 ? .85 : .6) : 1;
 const hourF = hour < 7 || hour > 20 ? .1 : hour < 9 ? .8 : hour < 12 ? 1 : hour < 15 ? .7 : hour < 18 ? 1 : .6;
 const x = Math.min(1, q * dayF * hourF * (SPOT_POP[sp.id] ?? .6) * 1.15);
 return x < .15 ? 0 : x < .35 ? 1 : x < .6 ? 2 : 3;
}
const crowdNow = (sp, ev) => crowdCalc(sp, ev.score, todayIso(), +nowKey().slice(11,13));
const crowdDay = (sp, d) => crowdCalc(sp, d.best.score, d.day, d.bestHour);
function crowdHtml(sp, c){
 const col = ['#9FD18B','#E6B84A','#F0A22E','#E0624F'][c.lvl] || '#9FD18B';
 const person = on => `<svg class="${on?'':'off'}" width="18" height="22" viewBox="0 0 18 22" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="4"/><path d="M1 21c0-5 3.6-8 8-8s8 3 8 8z"/></svg>`;
 return `<div class="crowd">${chd('purple','ppl','Affollamento stimato',`<b class="cval">${c.label}</b>`,`<span class="ppl" role="img" aria-label="${c.lvl+1} su 4" style="color:${col}">${[0,1,2,3].map(i=>person(i<=c.lvl)).join('')}</span>`)}
  <p class="xs muted" style="margin-top:10px">${c.why.length ? 'Perché: '+c.why.join(', ')+'. ' : ''}È una stima fatta da onde, giorno e ora, non un conteggio reale.</p></div>`;
}

// ---------- Sezioni della pagina spot ----------
const MOTIF = {
 // rosa dei venti: il momento, onde e vento
 now:`<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g fill="none" stroke="currentColor"><circle cx="100" cy="100" r="92" stroke-width="2"/><circle cx="100" cy="100" r="62" stroke-width="1.5" stroke-dasharray="3 6"/>${Array.from({length:16},(_, i)=>{const a=i*22.5*Math.PI/180, r1=i%2?84:76; return `<line x1="${(100+r1*Math.sin(a)).toFixed(1)}" y1="${(100-r1*Math.cos(a)).toFixed(1)}" x2="${(100+92*Math.sin(a)).toFixed(1)}" y2="${(100-92*Math.cos(a)).toFixed(1)}" stroke-width="2"/>`;}).join('')}</g><path d="M100 22 L112 100 L100 178 L88 100Z M22 100 L100 88 L178 100 L100 112Z" fill="currentColor"/></svg>`,
 // sole: il meteo
 wx:`<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="44" fill="currentColor"/><g stroke="currentColor" stroke-width="7" stroke-linecap="round">${Array.from({length:12},(_, i)=>{const a=i*30*Math.PI/180; return `<line x1="${(100+62*Math.sin(a)).toFixed(1)}" y1="${(100-62*Math.cos(a)).toFixed(1)}" x2="${(100+86*Math.sin(a)).toFixed(1)}" y2="${(100-86*Math.cos(a)).toFixed(1)}"/>`;}).join('')}</g></svg>`,
 // luna e orbita: la marea
 tide:`<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="88" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/><path d="M132 52 A52 52 0 1 0 150 132 A40 40 0 1 1 132 52Z" fill="currentColor"/></svg>`,
 // calendario: i prossimi giorni
 cal:`<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"><path d="M30 150 L80 100 L115 125 L170 60"/><circle cx="170" cy="60" r="10" fill="currentColor"/><path d="M30 175h140" opacity=".6"/></g><g fill="currentColor"><circle cx="80" cy="100" r="8"/><circle cx="115" cy="125" r="8"/><circle cx="30" cy="150" r="8"/></g></svg>`,
 season:`<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="86" fill="none" stroke="currentColor" stroke-width="5"/><g fill="currentColor">${Array.from({length:12},(_, i)=>{const a=i*30*Math.PI/180, r=[26,22,16,12,10,8,8,10,16,22,28,30][i]; return `<circle cx="${(100+64*Math.sin(a)).toFixed(1)}" cy="${(100-64*Math.cos(a)).toFixed(1)}" r="${r/2.4}"/>`;}).join('')}</g></svg>`,
 week:`<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"><rect x="22" y="36" width="156" height="142" rx="16"/><path d="M22 76h156M62 18v34M138 18v34"/></g><g fill="currentColor">${Array.from({length:12},(_, i)=>`<rect x="${40+(i%4)*34}" y="${92+Math.floor(i/4)*28}" width="18" height="14" rx="3"/>`).join('')}</g></svg>`
};
const SEC_ICONS = {
 now:'<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 7c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>',
 wx:'<circle cx="9" cy="9" r="3.5"/><path d="M9 2v1.5M2 9h1.5M4 4l1 1M14 4l-1 1"/><path d="M8 19h9a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.3 1.8A3.2 3.2 0 0 0 8 19z"/>',
 tide:'<path d="M7 4v11M4 12l3 3 3-3"/><path d="M17 20V9M14 12l3-3 3 3"/>',
 week:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'
};
const secHead = (icon, title, sub) => `<div class="shead"><h2>${title}</h2><p class="xs muted" style="margin-top:2px">${sub}</p></div>`;
// intestazione di una sezione a fisarmonica: chiusa mostra il riassunto a destra, aperta il dettaglio
const SECTILES = {wx:SEC_ICONS.wx, tide:SEC_ICONS.tide, week:SEC_ICONS.week, season:'<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>', cal:'<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'};
const secToggle = (key, title, sub, summary, info='') => `<button class="shead sbtn withtile" aria-expanded="false" aria-controls="body-${key}" data-toggle="${key}">
 <span class="stile st-${key}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SECTILES[key] || ''}</svg></span>
 <div class="stext"><div class="stitle"><h2>${title}</h2></div><p class="xs muted sub">${sub}</p><span class="ssum" id="sum-${key}">${summary}</span><p class="sinfo" id="info-${key}">${info}</p></div>
 <span class="tog" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12h14"/><path class="v" d="M12 5v14"/></svg></span></button>`;
// ---------- Sessioni reali e taratura ----------
const sessions = () => Data.sessions.all();
const spotSessions = sp => sessions().filter(x => x.spot_id === sp.id);
function appAt(sp, iso){
 const s = data[sp.id]; if (!s) return null;
 const i = s.time.indexOf(iso.slice(0,13) + ':00'); if (i < 0) return null;
 return evaluate(sp, s, i);
}
function openLog(sp){
 const now = nowKey();
 const wrap = document.createElement('div');
 wrap.className = 'sheet'; wrap.id = 'logSheet';
 wrap.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-p form" role="dialog" aria-modal="true" aria-labelledby="logT">
  <div class="sheet-h"><h2 id="logT">Com'era a ${esc(sp.name)}?</h2><button class="sheet-x" data-close aria-label="Chiudi">×</button></div>
  <p class="small muted" style="margin-top:4px">Serve a capire quanto l'app ci prende su questo spot. Bastano pochi secondi.</p>
  <label>Quando<input type="datetime-local" id="lgWhen" value="${now.slice(0,13)}:00"></label>
  <label>Onda reale a riva, in metri<input type="number" id="lgWave" inputmode="decimal" step="0.1" min="0" max="8" placeholder="es. 1.2"></label>
  <label>Com'era, da 1 (da non uscire) a 5 (epico)</label><div class="qual" id="lgQual">${[1,2,3,4,5].map(n=>`<button type="button" data-q="${n}" aria-pressed="false">${n}</button>`).join('')}</div>
  <label>Quanta gente c'era</label><div class="qual crowdq" id="lgCrowd">${[1,2,3,4].map(n=>`<button type="button" data-c="${n}" aria-pressed="false" aria-label="${['Nessuno o quasi','Poca gente','Un po\' di gente','Affollato'][n-1]}">${'<svg width="12" height="16" viewBox="0 0 18 22" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="4"/><path d="M1 21c0-5 3.6-8 8-8s8 3 8 8z"/></svg>'.repeat(n)}</button>`).join('')}</div>
  <p class="xs muted" id="lgCrowdTxt" style="margin-top:4px">Da 1 (nessuno o quasi) a 4 (affollato)</p>
  <label>Vento in acqua<select id="lgWind"><option value="">Non so</option><option>assente</option><option>offshore</option><option>laterale</option><option>onshore</option></select></label>
  ${Data.boards.all().length ? `<label>Tavola usata<select id="lgBoard"><option value="">Non indicata</option>${Data.boards.all().map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>` : ''}
  <label>Note<textarea id="lgNote" rows="2" placeholder="es. chiudeva sul reef, marea alta"></textarea></label>
  <p class="err" id="lgErr" hidden></p>
  <button class="pillbtn primary" id="lgSave" style="margin-top:16px">Salva sessione</button></div>`;
 document.body.appendChild(wrap); document.body.classList.add('locked');
 let q = null, cr = null;
 const close = ()=>{ wrap.remove(); document.body.classList.remove('locked'); };
 wrap.addEventListener('click', e=>{
  if (e.target.closest('[data-close]')) close();
  const b = e.target.closest('[data-q]'); if (b){ q = +b.dataset.q; wrap.querySelectorAll('[data-q]').forEach(x=>x.setAttribute('aria-pressed', x===b)); }
  const c = e.target.closest('[data-c]'); if (c){ cr = +c.dataset.c; wrap.querySelectorAll('[data-c]').forEach(x=>x.setAttribute('aria-pressed', x===c)); wrap.querySelector('#lgCrowdTxt').textContent = c.getAttribute('aria-label'); }
 });
 wrap.querySelector('#lgSave').onclick = ()=>{
  const when = wrap.querySelector('#lgWhen').value, wave = parseFloat(wrap.querySelector('#lgWave').value.replace(',', '.'));
  const err = wrap.querySelector('#lgErr');
  if (!when || isNaN(wave) || !q){ err.hidden = false; err.textContent = 'Servono almeno quando, onda reale e voto.'; return; }
  const ev = appAt(sp, when);
  // quanto la boa aveva corretto la previsione in quell'ora: serve a tarare lo spot sul modello puro
  const S = data[sp.id], ii = S ? S.time.indexOf(when.slice(0,13) + ':00') : -1;
  const fix = S?.hsRaw && ii >= 0 && S.hsRaw[ii] ? +(S.hs[ii] / S.hsRaw[ii]).toFixed(3) : 1;
  const row = {data: when.slice(0,10), ora: when.slice(11,16), spot_id: sp.id,
   punteggio_app: ev ? ev.score : '', onda_app_m: ev ? +ev.face.toFixed(2) : '', gain: sp.gain ?? 1, fix,
   onda_reale_m: wave, qualita_reale_1_5: q, vento_reale: wrap.querySelector('#lgWind').value,
   vento_app: ev ? ev.windType : '', affollamento_1_4: cr ?? '', note: wrap.querySelector('#lgNote').value.trim(),
   tavola: '', tavola_tipo: ''};
  const bsel = wrap.querySelector('#lgBoard'), bused = bsel && bsel.value ? Data.boards.all().find(x => x.id === bsel.value) : null;
  if (bused){ row.tavola = bused.name; row.tavola_tipo = bused.type; }
  Data.sessions.add(row); toast('Sessione salvata');
  close(); openDetail(sp.id); openSection('cal', true);
  document.getElementById('sec-cal')?.scrollIntoView({behavior:'smooth', block:'start'});
 };
 wrap.querySelector('#lgWave').focus();
}
const median = a => { const b = [...a].sort((x,y)=>x-y), m = b.length >> 1; return b.length ? (b.length % 2 ? b[m] : (b[m-1]+b[m])/2) : null; };
function calStats(sp){
 const ss = spotSessions(sp), withApp = ss.filter(x => x.onda_app_m !== '' && x.onda_app_m > 0.15);
 const ratios = withApp.map(x => x.onda_reale_m / (x.onda_app_m / (x.gain || 1) / (x.fix || 1)));
 const gain = ratios.length ? median(ratios) : null;
 const diffs = ss.filter(x => x.punteggio_app !== '').map(x => x.qualita_reale_1_5 - x.punteggio_app);
 const bias = diffs.length ? diffs.reduce((a,b)=>a+b,0)/diffs.length : null;
 const windMiss = ss.filter(x => x.vento_reale === 'onshore' && ['offshore','debole'].includes(x.vento_app)).length;
 return {n: ss.length, nApp: withApp.length, gain, bias, windMiss, ss};
}
function calSummary(sp){ const st = calStats(sp); return st.n ? `<span><b>${st.n}</b>${st.n === 1 ? 'sessione' : 'sessioni'}</span>` : '<span>Nessuna sessione</span>'; }
function calInfo(sp){
 const st = calStats(sp);
 if (!st.n) return 'Registra com\'era davvero per rendere il punteggio più preciso';
 if (st.nApp < 3) return `Ancora ${3 - st.nApp} ${3 - st.nApp === 1 ? 'sessione' : 'sessioni'} per il primo suggerimento`;
 const pct = Math.round((st.gain / (sp.gain ?? 1) - 1) * 100);
 return Math.abs(pct) < 10 ? ((sp.gain ?? 1) !== 1 ? 'Correzione attiva: previsioni in linea con la realtà' : 'Le previsioni d\'onda qui sono in linea con la realtà') : `L'app ${pct < 0 ? 'sovrastima' : 'sottostima'} l'onda di circa il ${Math.abs(pct)}%`;
}
function calHtml(sp){
 const st = calStats(sp), cur = sp.gain ?? 1;
 let tips = '';
 if (st.nApp >= 3){
  const pct = Math.round((st.gain / cur - 1) * 100);
  tips += Math.abs(pct) < 10
   ? `<p><b>Onda:</b> ${cur !== 1 ? 'con la correzione attiva le previsioni' : 'le previsioni'} sono in linea con quello che hai trovato (scarto ${pct > 0 ? '+' : ''}${pct}%). Niente da correggere.</p>`
   : `<p><b>Onda:</b> sulle tue ${st.nApp} sessioni l'app ${pct < 0 ? 'sovrastima' : 'sottostima'} l'onda a riva di circa il ${Math.abs(pct)}%. Correzione proposta: ×${st.gain.toFixed(2)}.</p>
      <button class="pillbtn primary" id="calApply" style="margin-top:8px;width:auto">Applica la correzione</button>`;
 } else tips += `<p>Servono almeno 3 sessioni con la previsione dell'app per proporre una correzione (ora ${st.nApp}).</p>`;
 if (st.bias != null && st.n >= 3 && Math.abs(st.bias) >= 1)
  tips += `<p style="margin-top:8px"><b>Punteggio:</b> in media il tuo voto è ${st.bias > 0 ? 'più alto' : 'più basso'} di ${Math.abs(st.bias).toFixed(1)} punti. ${st.bias > 0 ? 'Lo spot rende più di quanto pensi l\'app: forse la finestra di direzioni è troppo stretta.' : 'Lo spot rende meno: forse la finestra è troppo larga o il range di onda troppo basso.'}</p>`;
 if (st.windMiss >= 2)
  tips += `<p style="margin-top:8px"><b>Vento:</b> ${st.windMiss} volte l'app lo dava buono ma in acqua era onshore. Probabilmente la direzione offshore dello spot (ora da ${cardinal(sp.offshore)}) va corretta.</p>`;
 const list = st.ss.slice(-6).reverse().map(x => `<div><b>${x.data.slice(8)}/${x.data.slice(5,7)} ${x.ora}</b><span>Reale ${x.onda_reale_m}m, voto ${x.qualita_reale_1_5}/5${x.vento_reale ? ', ' + x.vento_reale : ''}${x.affollamento_1_4 ? ', gente ' + x.affollamento_1_4 + '/4' : ''}${x.tavola ? ', ' + esc(x.tavola) : ''} · App ${x.onda_app_m !== '' ? x.onda_app_m.toFixed(1) + ' m, ' + x.punteggio_app + '/5' : 'n.d.'}</span></div>`).join('');
 return `${tips || ''}
  ${cur !== 1 ? `<p class="small" style="margin-top:10px">Correzione personale attiva: ×${cur.toFixed(2)}. Vale per le tue previsioni${Cloud.user ? ', su tutti i tuoi dispositivi e negli alert Telegram' : ' su questo telefono'}. <button class="linkbtn" id="calReset" style="min-height:auto">Azzera</button></p>` : ''}
  ${st.n ? `<h3 style="margin:16px 0 4px;font:600 18px var(--grot)">Ultime sessioni</h3><div class="slist">${list}</div>` : ''}
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
   <button class="pillbtn" id="calLog">✍️ Registra una sessione</button></div>
  <p class="xs muted" style="margin-top:8px">${Cloud.user ? 'Le sessioni sono salvate anche online, nel tuo account.' : 'Le sessioni restano su questo telefono: entra con l\'account (Profilo › Account) per salvarle anche online.'}</p>`;
}
function bindCal(sp){
 const on = (id, f) => { const b = document.getElementById(id); if (b) b.onclick = f; };
 on('logOpen', ()=>openLog(sp)); on('calLog', ()=>openLog(sp));
 on('calApply', ()=>{
  const g = store.get('surf.gain', {}); g[sp.id] = +calStats(sp).gain.toFixed(2); store.set('surf.gain', g);
  applyGains(); openDetail(sp.id); openSection('cal', true); renderAll();
 });
 on('calReset', ()=>{ const g = store.get('surf.gain', {}); delete g[sp.id]; store.set('surf.gain', g); sp.gain = baseSpots.find(b=>b.id===sp.id)?.gain; spots.forEach(x=>{ if (x.id===sp.id) x.gain = sp.gain; }); openDetail(sp.id); openSection('cal', true); renderAll(); });
}

// ================= Cloud: account e sincronizzazione con Supabase =================
// L'app resta "prima locale": tutto si salva sul telefono e, se hai fatto l'accesso, viene copiato
// sul database così lo ritrovi su ogni dispositivo. Nell'app c'è solo la chiave pubblica: le regole
// del database fanno sì che ognuno legga e scriva soltanto i propri dati.
const SUPA_URL = 'https://djicqanyclbrfzhxlsxm.supabase.co';
const SUPA_KEY = 'sb_publishable_YcNI9IPd7AyG5_EE-jc0Rw_BhsKkcMf';
// chiave pubblica delle notifiche push (la parte privata sta solo nei segreti di GitHub)
const VAPID_PUBLIC = 'BDV65RvRwRwOJknTN4R2i6Dy4_CEiQ2SSBM1susxE5NzXJgRppdCnlpR3-QMexf1oKkEYl_3jKm5Xw64Yo0QBck';
const Cloud = (() => {
 let sb = null, user = null, busy = false, timer = null, lastSync = null, lastErr = null, pendingEmail = null, partialErr = null, partialDetail = null;
 // errore "a metà": spot e sessioni si sincronizzano, ma profilo e tavole no (di solito manca l'aggiornamento del database)
 const friendly = m => /schema cache|could not find|does not exist|undefined (table|column)/i.test(m || '') ? 'il database non è ancora aggiornato (serve aggiorna_tavole.sql)' : /permission denied|row-level security|not allowed/i.test(m || '') ? 'permessi mancanti sul database (rilancia aggiorna_tavole.sql)' : (m || 'errore sconosciuto');
 let admin = false;
 const api = {ready:false, get busy(){ return busy; }, get partialErr(){ return partialErr; }, get partialDetail(){ return partialDetail; }, get admin(){ return admin; }, get user(){ return user; }, get lastSync(){ return lastSync; }, get lastErr(){ return lastErr; }, get pendingEmail(){ return pendingEmail; }, get pushOn(){ return pushOn; }};
 const SYNC_KEYS = ['surf.sessions','surf.customSpots','surf.favorite','surf.followed','surf.order','surf.gain','surf.threshold','surf.profile','surf.boards'];
 let tg = {linked:false, link:null}, tgTimer = null;
 let pushOn = false;   // questo telefono ha le notifiche push attive per questo account
 // vale la soglia di questo dispositivo solo se l'ha scelta la persona (o se c'era già prima che la soglia viaggiasse sull'account)
 const thresholdDirty = () => store.get('surf.thresholdDirty', store.get('surf.threshold', null) != null);
 const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');
 // --- conversioni tra formato del telefono e formato del database ---
 const toLocalDateTime = iso => { const d = new Date(iso), z = n => String(n).padStart(2,'0'); return [`${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`, `${z(d.getHours())}:${z(d.getMinutes())}`]; };
 const sessionOut = x => ({id: x.id, spot_id: x.spot_id, at: new Date(`${x.data}T${x.ora || '12:00'}`).toISOString(),
  wave_real_m: +x.onda_reale_m, quality: +x.qualita_reale_1_5,
  wind_real: ['assente','offshore','laterale','onshore'].includes(x.vento_reale) ? x.vento_reale : null,
  crowd: x.affollamento_1_4 ? +x.affollamento_1_4 : null, note: x.note || null,
  app_score: x.punteggio_app === '' || x.punteggio_app == null ? null : +x.punteggio_app,
  app_wave_m: x.onda_app_m === '' || x.onda_app_m == null ? null : +x.onda_app_m, app_wind: x.vento_app || null,
  gain: +(x.gain || 1), buoy_fix: +(x.fix || 1),
  ...(x.tavola ? {board_name: x.tavola, board_type: x.tavola_tipo || null} : {})});
 const sessionIn = r => { const [d, o] = toLocalDateTime(r.at); return {id: r.id, data: d, ora: o, spot_id: r.spot_id,
  punteggio_app: r.app_score ?? '', onda_app_m: r.app_wave_m ?? '', gain: +r.gain || 1, fix: +r.buoy_fix || 1,
  onda_reale_m: +r.wave_real_m, qualita_reale_1_5: r.quality, vento_reale: r.wind_real || '', vento_app: r.app_wind || '',
  affollamento_1_4: r.crowd ?? '', note: r.note || '', created: r.created_at,
  tavola: r.board_name || '', tavola_tipo: r.board_type || ''}; };
 const spotOut = x => ({id: x.id, name: x.name, area: x.area || null, lat: x.lat, lon: x.lon, beach_lat: x.beachLat ?? null, beach_lon: x.beachLon ?? null,
  facing: x.facing, window: x.window, offshore: x.offshore, min: x.min, max: x.max, min_period: x.minPeriod,
  cams: x.cams || [], kind: x.kind || null, access: x.access || null, big_only: !!x.bigOnly, owner: user.id,
  updated_at: x.updated || new Date().toISOString()});
 const spotIn = r => ({id: r.id, name: r.name, area: r.area || 'Spot personale', lat: r.lat, lon: r.lon, beachLat: r.beach_lat ?? undefined, beachLon: r.beach_lon ?? undefined,
  facing: +r.facing, window: +r.window, offshore: +r.offshore, min: +r.min, max: +r.max, minPeriod: +r.min_period, alert: true, cams: r.cams || [],
  kind: r.kind || null, access: r.access || null, bigOnly: !!r.big_only, visibility: r.visibility, updated: r.updated_at});
 const stamp = s => s ? new Date(s).getTime() : 0;
 const boardOut = x => ({id: x.id, user_id: user.id, name: x.name, type: x.type, litres: x.litres ?? null, length_text: x.length || null, updated_at: x.updated || new Date().toISOString()});
 const boardIn = r => ({id: r.id, name: r.name, type: r.type, litres: r.litres == null ? null : +r.litres, length: r.length_text || '', updated: r.updated_at});
 const sameBoard = (a, b) => ['name','type','litres','length'].every(k => (a[k] ?? null) === (b[k] ?? null));
 const sameSpot = (a, b) => ['name','area','lat','lon','beachLat','beachLon','facing','window','offshore','min','max','minPeriod','kind','access','bigOnly','visibility'].every(k => (a[k] ?? null) === (b[k] ?? null));
 const userSpotRows = () => {
  const fav = store.get('surf.favorite', null), fol = store.get('surf.followed', null), ord = store.get('surf.order', null) || [], g = store.get('surf.gain', {});
  return spots.map(sp => ({user_id: user.id, spot_id: sp.id, favorite: fav === sp.id,
   alert: fol ? fol.includes(sp.id) : !!sp.alert, sort_order: ord.includes(sp.id) ? ord.indexOf(sp.id) : null, gain: g[sp.id] ?? null}));
 };
 const status = () => { if (typeof renderAccount === 'function') renderAccount(); };

 api.init = async () => {
  if (!window.supabase?.createClient){ status(); return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  try{ const {data} = await sb.auth.getSession(); user = data?.session?.user || null; }catch(e){ user = null; }
  sb.auth.onAuthStateChange((ev, sess) => { const was = user?.id; user = sess?.user || null; if (!user) admin = false; status(); if (user && user.id !== was){ api.checkAdmin(); api.sync(); api.ping(); api.pushRefresh(); } });
  api.ready = true;
  window.__cloudTouch = k => { if (user && SYNC_KEYS.includes(k)){ clearTimeout(timer); timer = setTimeout(() => api.push(), 2500); } };
  window.__cloudRemoveSpot = id => { if (user && sb) sb.from('spots').delete().eq('id', id).eq('owner', user.id).then(()=>{}); };
  window.__cloudRemoveBoard = id => { if (user && sb) sb.from('boards').delete().eq('id', id).eq('user_id', user.id).then(()=>{}); };
  status();
  if (user){ api.checkAdmin(); api.sync(); api.pushRefresh(); }
  api.ping();
 };
 api.checkAdmin = async () => {
  try{ const {data} = await sb.from('profiles').select('is_admin').eq('id', user.id).single(); admin = !!data?.is_admin; }catch(e){ admin = false; }
  status();
 };
 // conteggio anonimo degli accessi: al massimo un ping al giorno per dispositivo, anche da ospite
 const deviceId = () => {
  let id = store.get('surf.deviceId', null);
  if (!isUuid(id)){
   const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
   const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
   id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
   store.set('surf.deviceId', id);
  }
  return id;
 };
 api.ping = async () => {
  try{
   if (!sb) return;
   const day = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Rome'}), key = `${day}|${user?.id || '-'}`;
   if (store.get('surf.lastPing', null) === key) return;
   const {error} = await sb.rpc('log_ping', {p_device: deviceId()});
   if (!error) store.set('surf.lastPing', key);
  }catch(e){ /* il conteggio è facoltativo: se non riesce, si riprova alla prossima apertura */ }
 };
 // statistiche di utilizzo: le calcola il database e le concede solo all'amministratore
 api.stats = async days => {
  const {data, error} = await sb.rpc('admin_stats', {p_days: days});
  if (error) throw error;
  return data;
 };
 // proporre uno spot alla community (chiunque) o renderlo ufficiale (solo amministratore)
 api.setVisibility = async (id, vis) => {
  if (!user) throw new Error('serve l\'accesso');
  await api.push();   // prima mi assicuro che lo spot sia nel database
  const {error} = await sb.from('spots').update({visibility: vis, updated_at: new Date().toISOString()}).eq('id', id);
  if (error) throw error;
  const list = Data.spots.all();
  if (vis === 'public') Data.set('surf.customSpots', list.filter(x => x.id !== id));   // ora è tra gli ufficiali
  else Data.set('surf.customSpots', list.map(x => x.id === id ? {...x, visibility: vis} : x));
 };
 // accesso con codice via email: funziona anche dentro l'app salvata sulla Home (il link aprirebbe Safari)
 api.sendCode = async email => {
  const {error} = await sb.auth.signInWithOtp({email, options:{emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true}});
  if (error) throw error; pendingEmail = email;
 };
 api.verifyCode = async code => {
  const {error} = await sb.auth.verifyOtp({email: pendingEmail, token: code.trim(), type: 'email'});
  if (error) throw error; pendingEmail = null;
 };
 // senza un servizio email personalizzato Supabase manda solo il link: lo si può incollare nell'app
 api.verifyLink = async link => {
  let u; try{ u = new URL(link.trim()); }catch(e){ throw new Error('non è un link'); }
  const hash = new URLSearchParams(u.hash.slice(1));
  if (hash.get('access_token')){ const {error} = await sb.auth.setSession({access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token')}); if (error) throw error; pendingEmail = null; return; }
  const token = u.searchParams.get('token_hash') || u.searchParams.get('token');
  if (!token) throw new Error('nel link manca il codice');
  const type = u.searchParams.get('type') || 'magiclink';
  const {error} = await sb.auth.verifyOtp({token_hash: token, type});
  if (error) throw error; pendingEmail = null;
 };
 api.cancelCode = () => { pendingEmail = null; status(); };
 // collegamento a Telegram: l'app chiede un codice monouso, l'utente apre il bot dal link e tocca Avvia
 api.tg = () => tg;
 api.loadTelegram = async () => {
  if (!user) return;
  const {data} = await sb.from('profiles').select('telegram_chat_id').eq('id', user.id).maybeSingle();
  const was = tg.linked; tg.linked = !!data?.telegram_chat_id;
  if (tg.linked){ if (tg.link) toast('Telegram collegato'); tg.link = null; clearInterval(tgTimer); }
  if (tg.linked !== was) status();
 };
 api.linkTelegram = async () => {
  const {data, error} = await sb.rpc('create_telegram_link');
  if (error) throw error;
  if (!data?.bot) throw new Error('Telegram non è ancora stato configurato dall\'amministratore');
  tg.link = {url: `https://t.me/${data.bot}?start=${data.code}`, bot: data.bot};
  status();
  // finché la persona è su Telegram controllo ogni pochi secondi se il collegamento è avvenuto
  clearInterval(tgTimer); let n = 0;
  tgTimer = setInterval(async () => { if (++n > 60){ clearInterval(tgTimer); return; } try{ await api.loadTelegram(); }catch(e){} }, 4000);
 };
 api.unlinkTelegram = async () => {
  const {error} = await sb.rpc('unlink_telegram'); if (error) throw error;
  tg.linked = false; tg.link = null; status();
 };
 // notifiche push: arrivano nel blocca schermo e accendono il badge sull'icona, anche con l'app chiusa
 api.pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
 const keyBytes = b64 => { const p = '='.repeat((4 - b64.length % 4) % 4), r = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
 api.pushRefresh = async () => {
  let on = false;
  try{
   if (user && api.pushSupported() && Notification.permission === 'granted'){
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub){
     const {data} = await sb.from('push_subscriptions').select('endpoint').eq('user_id', user.id).eq('endpoint', sub.endpoint).maybeSingle();
     on = !!data;
    }
   }
  }catch(e){ on = false; }
  if (on !== pushOn){ pushOn = on; status(); if (typeof renderAlert === 'function' && lastTab === 'alert') renderAlert(); }
 };
 api.pushEnable = async () => {
  if (!user) throw new Error('Entra prima con l\'account (nel Profilo)');
  if (!api.pushSupported()) throw new Error('Questo dispositivo non supporta le notifiche push');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permesso negato: abilita le notifiche per l\'app nelle impostazioni del telefono');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC)});
  const j = sub.toJSON();
  const {error} = await sb.from('push_subscriptions').upsert({user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth}, {onConflict: 'user_id,endpoint'});
  if (error) throw new Error(/schema cache|does not exist/i.test(error.message) ? 'il database non è aggiornato (serve aggiorna_push.sql)' : error.message);
  pushOn = true; status();
 };
 api.pushDisable = async () => {
  try{
   const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
   if (sub){ await sb.from('push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
  }catch(e){ /* se non c'è più l'iscrizione è già come volevamo */ }
  pushOn = false; status();
 };
 api.signOut = async () => { await api.pushDisable().catch(()=>{}); await sb.auth.signOut(); user = null; pushOn = false; tg = {linked:false, link:null}; clearInterval(tgTimer); status(); };

 // invia al database quello che c'è sul telefono
 api.push = async () => {
  if (!user || busy) return;
  busy = true; lastErr = null;
  try{
   const official = new Set(baseSpots.map(b => b.id));
   const known = await sb.from('spots').select('id,updated_at,owner'); if (known.error) throw known.error;
   const rmap = new Map(known.data.map(r => [r.id, r]));
   // spedisco solo gli spot nuovi o modificati DOPO la versione che sta nel database:
   // così un telefono rimasto indietro non cancella le modifiche fatte da un altro
   const mine = Data.spots.all().filter(x => !official.has(x.id) && x.visibility !== 'public')
    .filter(x => { const r = rmap.get(x.id); return !r || (x.updated && stamp(x.updated) > stamp(r.updated_at)); });
   if (mine.length){ const {error} = await sb.from('spots').upsert(mine.map(spotOut)); if (error) throw error;
    mine.forEach(x => rmap.set(x.id, {id:x.id, owner:user.id, updated_at:x.updated})); }
   // ricordo quali spot miei il database conosce: se sparisce da lì, è stato eliminato da un altro dispositivo
   Data.set('surf.syncedSpots', [...rmap.values()].filter(r => r.owner === user.id).map(r => r.id));
   // solo spot che il database conosce (ufficiali e miei): altrimenti il collegamento fallirebbe
   const ok = new Set(rmap.keys());
   const ses = Data.sessions.all().filter(x => isUuid(x.id) && ok.has(x.spot_id) && x.onda_reale_m !== '' && x.qualita_reale_1_5);
   if (ses.length){ const {error} = await sb.from('sessions').upsert(ses.map(sessionOut)); if (error) throw error; }
   const us = userSpotRows().filter(r => ok.has(r.spot_id));
   if (us.length){ const {error} = await sb.from('user_spots').upsert(us); if (error) throw error; }
   // la soglia degli alert sta sull'account: è quella che usa il bot su Telegram
   const th = store.get('surf.threshold', null);
   if (th != null && thresholdDirty()){
    const r = await sb.from('profiles').update({alert_threshold: th}).eq('id', user.id);
    if (r.error) console.warn('Soglia non salvata', r.error); else store.set('surf.thresholdDirty', false);
   }
   // profilo surfista e tavole: se questa parte non è ancora pronta sul database non deve bloccare il resto
   partialErr = null; partialDetail = null;
   try{
    const pf = store.get('surf.profile', null);
    if (pf && store.get('surf.profileDirty', false)){
     const r = await sb.from('profiles').update({surf_level: pf.level ?? null, weight_kg: pf.weight ?? null}).eq('id', user.id);
     if (r.error) throw r.error; store.set('surf.profileDirty', false);
    }
    const rb = await sb.from('boards').select('id,updated_at').eq('user_id', user.id); if (rb.error) throw rb.error;
    const bmap = new Map(rb.data.map(r => [r.id, r]));
    const bmine = Data.boards.all().filter(x => { const r = bmap.get(x.id); return !r || (x.updated && stamp(x.updated) > stamp(r.updated_at)); });
    if (bmine.length){ const {error} = await sb.from('boards').upsert(bmine.map(boardOut)); if (error) throw error; bmine.forEach(x => bmap.set(x.id, {id: x.id, updated_at: x.updated})); }
    store.set('surf.syncedBoards', [...bmap.keys()]);
   }catch(e){ partialErr = friendly(e.message || String(e)); partialDetail = [e.code, e.message || String(e)].filter(Boolean).join(' – '); console.warn('Profilo e tavole non sincronizzati', e); }
   lastSync = new Date();
  }catch(e){ lastErr = e.message || String(e); console.warn('Sincronizzazione', e); }
  busy = false; status();
 };
 // porta sul telefono quello che c'è nel database, poi rimanda indietro l'unione
 api.sync = async () => {
  if (!user || busy) return;
  busy = true; lastErr = null; status();
  let changedSpots = false;
  try{
   const [rs, rp, ru, rf, rg, rbd] = await Promise.all([
    sb.from('sessions').select('*').eq('user_id', user.id),
    sb.from('spots').select('*').eq('owner', user.id),
    sb.from('user_spots').select('*').eq('user_id', user.id),
    sb.from('profiles').select('telegram_chat_id,alert_threshold').eq('id', user.id),
    sb.from('profiles').select('surf_level,weight_kg').eq('id', user.id).then(r => r, e => ({error: e})),
    sb.from('boards').select('*').eq('user_id', user.id).then(r => r, e => ({error: e}))
   ]);
   if (rs.error) throw rs.error; if (rp.error) throw rp.error; if (ru.error) throw ru.error;
   // profilo: Telegram collegato? e su un dispositivo nuovo prendo la soglia già scelta
   const prof = rf.data?.[0];
   if (prof){
    tg.linked = !!prof.telegram_chat_id; if (tg.linked) tg.link = null;
    if (!thresholdDirty() && prof.alert_threshold != null && +prof.alert_threshold !== threshold){
     threshold = +prof.alert_threshold; store.set('surf.thresholdDirty', false); store.set('surf.threshold', threshold);
    }
   }
   // sessioni: unione per identificativo
   const local = Data.sessions.all(), ids = new Set(local.map(x => x.id));
   const add = rs.data.filter(r => !ids.has(r.id)).map(sessionIn);
   if (add.length) Data.set('surf.sessions', [...local, ...add]);
   // spot personali: unione
   const remoteMine = rp.data.filter(r => r.visibility !== 'public');
   const rById = new Map(remoteMine.map(r => [r.id, r]));
   const synced = new Set(store.get('surf.syncedSpots', []));
   const lsp = Data.spots.all();
   // eliminati da un altro dispositivo: erano già nel database e ora non ci sono più
   const kept = lsp.filter(x => !(synced.has(x.id) && !rById.has(x.id)));
   // modificati altrove: se la versione del database è più recente, vince quella
   const merged = kept.map(x => {
    const r = rById.get(x.id); if (!r) return x;
    const remoteNewer = !x.updated || stamp(r.updated_at) > stamp(x.updated);
    if (!remoteNewer) return x;
    const n = spotIn(r); return sameSpot(n, x) ? {...x, updated: n.updated} : n;
   });
   const lids = new Set(lsp.map(x => x.id));
   const added = remoteMine.filter(r => !lids.has(r.id)).map(spotIn);
   const next = [...merged, ...added];
   if (next.length !== lsp.length || next.some((x, i) => x !== lsp[i])){
    Data.set('surf.customSpots', next);
    changedSpots = next.length !== lsp.length || next.some((x, i) => lsp[i] && !sameSpot(x, lsp[i]));
   }
   Data.set('surf.syncedSpots', [...rById.keys()]);
   // livello e peso: su un dispositivo che non li ha cambiati prendo quelli dell'account
   const pg = rg.error ? null : rg.data?.[0];
   if (pg && !store.get('surf.profileDirty', false) && (pg.surf_level || pg.weight_kg != null)){
    const cur = store.get('surf.profile', null) || {};
    const rem = {level: pg.surf_level || cur.level, weight: pg.weight_kg != null ? +pg.weight_kg : cur.weight};
    if (rem.level !== cur.level || rem.weight !== cur.weight) Data.set('surf.profile', {...cur, ...rem});
   }
   // tavole: stessa logica degli spot personali, vince la modifica più recente
   if (!rbd.error){
    const rById = new Map(rbd.data.map(r => [r.id, r]));
    const bsynced = new Set(store.get('surf.syncedBoards', []));
    const lb = Data.boards.all();
    const bkept = lb.filter(x => !(bsynced.has(x.id) && !rById.has(x.id)));
    const bmerged = bkept.map(x => {
     const r = rById.get(x.id); if (!r) return x;
     if (!(!x.updated || stamp(r.updated_at) > stamp(x.updated))) return x;
     const n = boardIn(r); return sameBoard(n, x) ? {...x, updated: n.updated} : n;
    });
    const bids = new Set(lb.map(x => x.id));
    const bnext = [...bmerged, ...rbd.data.filter(r => !bids.has(r.id)).map(boardIn)];
    if (bnext.length !== lb.length || bnext.some((x, i) => x !== lb[i])) Data.set('surf.boards', bnext);
    Data.set('surf.syncedBoards', [...rById.keys()]);
   }
   // scelte personali: se nel database ci sono già, valgono quelle
   if (ru.data.length){
    const fav = ru.data.find(r => r.favorite)?.spot_id ?? null;
    const fol = ru.data.filter(r => r.alert).map(r => r.spot_id);
    const ord = ru.data.filter(r => r.sort_order != null).sort((a,b) => a.sort_order - b.sort_order).map(r => r.spot_id);
    const g = {}; ru.data.forEach(r => { if (r.gain != null) g[r.spot_id] = +r.gain; });
    Data.set('surf.favorite', fav); Data.set('surf.followed', fol); Data.set('surf.order', ord.length ? ord : null); Data.set('surf.gain', g);
    favorite = fav; followed = fol;
   }
  }catch(e){ lastErr = e.message || String(e); console.warn('Sincronizzazione', e); }
  busy = false;
  if (!lastErr) await api.push();
  if (changedSpots){ baseSpots = []; refresh(); } else { applyGains(); renderAll(); }
  status();
 };
 return api;
})();

function renderAccount(){ renderAccountBox(); renderTelegram(); updateMeSummaries(); }

// ---------- Statistiche di utilizzo (amministratore) ----------
async function loadAdminStats(force){
 if (!Cloud.admin || adm.busy) return;
 if (!force && adm.data && adm.data.days === adm.days && Date.now() - adm.at < 60000) return;
 adm.busy = true; adm.err = null; renderAdmin();
 try{ adm.data = await Cloud.stats(adm.days); adm.at = Date.now(); }catch(e){ adm.err = e?.message || String(e); }
 adm.busy = false; renderAdmin(); updateMeSummaries();
}
function renderAdmin(){
 const box = document.getElementById('adminBox'); if (!box) return;
 const d = adm.data, pct = (a, b) => b > 0 ? Math.round(a * 100 / b) : null;
 const seg = `<div class="seg" style="grid-template-columns:repeat(3,minmax(0,1fr))" role="group" aria-label="Periodo">${[7, 30, 90].map(n => `<button data-days="${n}" aria-pressed="${adm.days === n}">${n} giorni</button>`).join('')}</div>`;
 let body;
 if (adm.err){
  const missing = /function|schema cache|does not exist|PGRST202/i.test(adm.err);
  body = `<p class="err" style="margin-top:10px">${missing ? 'Statistiche non ancora attive: esegui aggiorna_statistiche.sql in Supabase.' : 'Non riuscito: ' + esc(adm.err)}</p>`;
 } else if (!d){
  body = '<p class="small muted" style="margin-top:10px">Carico…</p>';
 } else {
  const p = pct(d.registered_active, d.registered), days = d.days;
  const line = (label, a, b) => { const q = pct(a, b); return `<div class="admrow"><div class="top"><span class="small">${label}</span><span class="small"><b>${q == null ? '—' : q + '%'}</b> <span class="muted">(${a} su ${b})</span></span></div><div class="admbar"><i style="width:${q || 0}%"></i></div></div>`; };
  const s = Array.isArray(d.series) ? d.series : [], mx = Math.max(1, ...s.map(x => x.users + x.guests));
  const h = v => v ? Math.max(4, v / mx * 100) : 0;
  const dt = x => new Date(x + 'T12:00:00').toLocaleDateString('it-IT', {day: 'numeric', month: 'short'});
  const bars = s.map(x => `<span class="admcol" title="${esc(dt(x.day))}: ${x.users} registrati, ${x.guests} guest"><i class="g" style="height:${h(x.guests)}%"></i><i class="u" style="height:${h(x.users)}%"></i></span>`).join('');
  body = `<div class="admhero"><p class="xs muted">Utenti registrati attivi negli ultimi ${days} giorni</p>
   <p class="admbig">${p == null ? '—' : p + '%'}<span>${d.registered_active} su ${d.registered}</span></p><div class="admbar"><i style="width:${p || 0}%"></i></div></div>
   <div class="admgrid">
    <div class="admtile"><b>${d.registered}</b><span class="xs muted">registrati</span></div>
    <div class="admtile"><b>+${d.registered_new}</b><span class="xs muted">nuovi in ${days} giorni</span></div>
    <div class="admtile"><b>${d.guests_active}</b><span class="xs muted">guest attivi</span></div>
    <div class="admtile"><b>${d.telegram_linked}</b><span class="xs muted">con Telegram</span></div>
   </div>
   <div class="admrow"><p class="small" style="font-weight:600">Quanto fanno gli altri (${days} giorni)</p></div>
   ${line('Sessioni registrate', d.sessions_others, d.sessions_total)}${line('Spot creati', d.spots_others, d.spots_total)}
   ${s.length ? `<div class="admrow"><p class="small" style="font-weight:600">Accessi al giorno</p><div class="admchart">${bars}</div>
    <div class="admax"><span>${dt(s[0].day)}</span><span>max ${mx}</span><span>${dt(s[s.length - 1].day)}</span></div>
    <div class="admleg"><span><i style="background:var(--accent)"></i>registrati</span><span><i style="background:#9BB4C0"></i>guest</span></div></div>` : ''}
   <p class="xs muted" style="margin-top:12px">Il tuo uso e quello di altri amministratori è escluso. I guest sono dispositivi senza account: il conteggio è approssimato (stessa persona su app installata e su Safari conta due volte).</p>`;
 }
 box.innerHTML = `${seg}${body}<div style="margin-top:12px"><button class="pillbtn" id="admRefresh"${adm.busy ? ' disabled' : ''}>${adm.busy ? '<i class="spin"></i>Aggiorno…' : ICON_SYNC + 'Aggiorna'}</button></div>`;
 box.querySelectorAll('[data-days]').forEach(b => { b.onclick = () => { adm.days = +b.dataset.days; adm.data = adm.data && adm.data.days === adm.days ? adm.data : null; loadAdminStats(true); }; });
 const r = document.getElementById('admRefresh'); if (r) r.onclick = () => loadAdminStats(true);
}
function renderTelegram(){
 const box = document.getElementById('tgBox'); if (!box) return;
 const head = t => `<p style="font-weight:600">Telegram</p><p class="xs muted">${t}</p>`;
 if (!Cloud.ready || !Cloud.user){
  box.innerHTML = `<div class="srow"><div>${head('Entra con l\'account (nel Profilo) per ricevere gli alert sul tuo Telegram, anche con l\'app chiusa.')}</div></div>`; return;
 }
 const t = Cloud.tg();
 if (t.linked){
  box.innerHTML = `<div class="srow"><div>${head(`Collegato ✓ Ti scrivo per gli spot che segui, da ${threshold}/5, anche con l'app chiusa. Per smettere puoi anche scrivere /stop al bot.`)}</div><button class="pillbtn" id="tgOut">Scollega</button></div><p class="err" id="tgErr" hidden></p>`;
  document.getElementById('tgOut').onclick = async () => { try{ await Cloud.unlinkTelegram(); toast('Telegram scollegato'); }catch(e){ const x = document.getElementById('tgErr'); x.hidden = false; x.textContent = 'Non riuscito: ' + e.message; } };
 } else if (t.link){
  box.innerHTML = `<div class="srow" style="align-items:flex-start;flex-direction:column"><div>${head('Ultimo passo: si apre Telegram, tocca <b>Avvia</b> (Start). Poi torna qui: il collegamento si vede da solo.')}</div>
   <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="pillbtn primary" style="width:auto;text-decoration:none" href="${esc(t.link.url)}" target="_blank" rel="noopener">Apri Telegram ↗</a><button class="pillbtn" id="tgRetry">Ho toccato Avvia</button></div></div><p class="err" id="tgErr" hidden></p>`;
  document.getElementById('tgRetry').onclick = () => Cloud.loadTelegram();
 } else {
  box.innerHTML = `<div class="srow"><div>${head('Ricevi gli avvisi sul tuo Telegram anche con l\'app chiusa, per gli spot che segui e con la soglia scelta qui sopra.')}</div><button class="pillbtn primary" id="tgGo" style="width:auto;min-height:44px;font-size:14px">Collega Telegram</button></div><p class="err" id="tgErr" hidden></p>`;
  document.getElementById('tgGo').onclick = async () => { try{ await Cloud.linkTelegram(); }catch(e){ const x = document.getElementById('tgErr'); x.hidden = false; x.textContent = 'Non riuscito: ' + e.message; } };
 }
}
function renderAccountBox(){
 const box = document.getElementById('acctBox'); if (!box) return;
 const hm2 = d => d.toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'});
 if (!Cloud.ready){ box.innerHTML = `<div class="acct"><p class="small muted">Account non disponibile: controlla la connessione e riapri l'app.</p></div>`; return; }
 if (Cloud.user){
  const ini = esc((Cloud.user.email || '?').trim().charAt(0).toUpperCase());
  const st = Cloud.lastErr ? ['err', 'Sincronizzazione non riuscita: ' + Cloud.lastErr] : (Cloud.busy || !Cloud.lastSync) ? ['busy', 'Sincronizzo…'] : Cloud.partialErr ? ['warn', 'Spot e sessioni sì, ma profilo e tavole no: ' + Cloud.partialErr] : ['ok', `Sincronizzato alle ${hm2(Cloud.lastSync)}`];
  box.innerHTML = `<div class="acct"><div class="mehero"><span class="ava" aria-hidden="true">${ini}</span><div class="who"><p class="mail">${esc(Cloud.user.email || 'Account')}</p>
   <p class="stat" role="status"><i class="dot ${st[0]}"></i>${esc(st[1])}</p>${st[0] === 'warn' && Cloud.partialDetail ? `<p class="xs muted" style="margin:6px 0 0;overflow-wrap:anywhere">Dettaglio tecnico: ${esc(Cloud.partialDetail)}</p>` : ''}</div></div>
   <div class="row2"><button class="pillbtn" id="acSync"${Cloud.busy ? ' disabled' : ''}>${Cloud.busy ? '<i class="spin"></i>Sincronizzo…' : ICON_SYNC + 'Sincronizza ora'}</button>
   <button class="pillbtn" id="acOut">${ICON_OUT}Esci</button></div></div>`;
  document.getElementById('acSync').onclick = async () => { await Cloud.sync(); if (Cloud.lastErr) toast('Sincronizzazione non riuscita', 'err'); else if (Cloud.partialErr) toast('Profilo e tavole non sincronizzati', 'err'); else toast('Tutto sincronizzato'); };
  document.getElementById('acOut').onclick = async e => { const b = e.currentTarget; b.disabled = true; b.innerHTML = '<i class="spin"></i>Esco…'; await Cloud.signOut(); toast('Sei uscito dall\'account'); };
  return;
 }
 if (Cloud.pendingEmail){
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  box.innerHTML = `<div class="acct"><p class="small">Ti abbiamo mandato un'email a <b>${esc(Cloud.pendingEmail)}</b>.</p>
   <p class="xs muted" style="margin-top:6px">Scrivi qui il codice di 6 cifre che trovi nell'email.${standalone ? '' : ' Oppure tocca il link nell\'email: si riapre l\'app già collegata.'}</p>
   <p class="xs muted" style="margin-top:6px"><b>Non la trovi?</b> Può metterci un minuto. Guarda anche nello spam o in Promozioni e, se è lì, segnala «Non è spam»: le prossime arriveranno in posta in arrivo.</p>
   <input class="field" id="acCode" inputmode="numeric" autocomplete="one-time-code" placeholder="Codice di 6 cifre (o incolla il link)">
   <p class="err" id="acErr" hidden></p>
   <div class="row2"><button class="pillbtn primary" id="acVerify" style="width:auto">Entra</button><button class="pillbtn" id="acBack">Indietro</button></div></div>`;
  document.getElementById('acBack').onclick = () => Cloud.cancelCode();
  document.getElementById('acVerify').onclick = async () => {
   const e = document.getElementById('acErr');
   const v = document.getElementById('acCode').value.trim();
   try{ if (/^https?:\/\//.test(v)) await Cloud.verifyLink(v); else await Cloud.verifyCode(v); }
   catch(err){ e.hidden = false; e.textContent = 'Codice non valido o scaduto: controlla le cifre o torna indietro e richiedine un altro.'; }
  };
  return;
 }
 box.innerHTML = `<div class="acct"><p style="font-weight:600">Entra per non perdere i tuoi dati</p>
  <p class="xs muted" style="margin-top:2px">Con l'accesso sessioni, spot personali e preferiti si salvano anche online e li ritrovi su ogni dispositivo. Senza password: ti mandiamo un codice via email.</p>
  <input class="field" id="acEmail" type="email" inputmode="email" autocomplete="email" placeholder="La tua email">
  <p class="err" id="acErr" hidden></p>
  <div class="row2"><button class="pillbtn primary" id="acSend" style="width:auto">Mandami il codice</button></div></div>`;
 document.getElementById('acSend').onclick = async () => {
  const v = document.getElementById('acEmail').value.trim(), e = document.getElementById('acErr');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)){ e.hidden = false; e.textContent = 'Scrivi un indirizzo email valido.'; return; }
  try{ await Cloud.sendCode(v); renderAccount(); }catch(err){ e.hidden = false; e.textContent = /rate|limit|seconds/i.test(err.message) ? 'Troppe richieste ravvicinate: riprova tra qualche minuto.' : 'Invio non riuscito: ' + err.message; }
 };
}

// ---------- Boe reali ----------
// buoy.json lo aggiorna ogni ora l'automazione GitHub "Boe" (build_buoy.py)
let buoyData = null;
async function loadBuoys(){
 try{ buoyData = await getJson('buoy.json', {cache:'no-cache'}, 1, 15000); }catch(e){ buoyData = null; }
}
const bearing = (a, b) => { const r = Math.PI/180, y = Math.sin((b.lon-a.lon)*r)*Math.cos(b.lat*r), x = Math.cos(a.lat*r)*Math.sin(b.lat*r) - Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos((b.lon-a.lon)*r); return (Math.atan2(y,x)/r + 360) % 360; };
const ago = iso => { const m = Math.round((Date.now() - new Date(iso).getTime())/60000); if (m < 60) return `${m}min fa`; if (m < 12*60) return `${Math.round(m/60)}h fa`; const d = new Date(iso); return `${d.toDateString() === new Date().toDateString() ? 'oggi' : 'ieri'} alle ${d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}`; };
const buoyModelCache = {};
async function renderBuoy(sp){
 const box = document.getElementById('buoyBox'); if (!box) return;
 if (!buoyData) await loadBuoys();
 const ref = refBuoy(beach(sp));
 const list = (buoyData?.buoys || []).map(b => ({...b, d: distanceKm(beach(sp), b)})).filter(b => b.d <= 250).sort((a,b) => (a.id === ref?.id ? -1 : b.id === ref?.id ? 1 : a.d - b.d));
 const fresh = list.filter(b => Date.now() - new Date(b.last.time).getTime() <= 48*3600000);
 const bu = fresh[0];
 if (!bu){ box.innerHTML = ''; return; }
 // se la più vicina è in ritardo e un'altra ha misure più nuove, la segnalo sotto
 const newer = fresh.find(b => b !== bu && new Date(b.last.time) - new Date(bu.last.time) > 3*3600000);
 const name = bu.name ? bu.name : (bu.km != null && Math.abs(bu.lat - 40.55) < 0.6 && bu.lon < 8.6 ? 'Boa di Alghero' : 'Boa ondametrica ' + bu.id);
 const L = bu.last;
 const boaTxt = `${(+L.hs).toFixed(1)}m${L.tp ? `, ${Math.round(L.tp)}s` : ''}${L.dir != null && L.dir !== '' ? ` da ${cardinal(+L.dir)}` : ''}`;
 const fixOn = !!(buoyFix && buoyFix.applied && data[sp.id]?.hsRaw), pct = buoyFix ? Math.round((buoyFix.ratio - 1) * 100) : 0;
 const src = `${esc(name)} · ${Math.round(bu.d)}km verso ${cardinal(bearing(beach(sp), bu))} · misurata ${ago(L.time)}${newer ? `. Più recente: ${esc(newer.name || 'boa ' + newer.id)}, ${Math.round(newer.d)}km` : ''}`;
 const fixCard = buoyFix ? `<div class="bxfix"><span><b>${fixOn ? `Corretta ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%` : 'Nessuna correzione'}</b> · ${fixOn ? 'sfuma in 2 giorni' : 'modello in linea con la boa'}</span><button class="bxsm" id="fixToggle">${store.get('surf.buoyfix', true) ? 'Disattiva' : 'Attiva'}</button></div>` : '';
 const bindFix = () => { const t = document.getElementById('fixToggle');
  if (t) t.onclick = async ()=>{ store.set('surf.buoyfix', !store.get('surf.buoyfix', true)); Object.values(data).forEach(s=>{ if (s.hsRaw){ s.hs = s.hsRaw; s.sh = s.shRaw; delete s.hsRaw; delete s.shRaw; } }); await applyBuoyFix(); openDetail(sp.id); renderAll(); }; };
 const col = (cls, lab, v, w, color) => `<div class="bxrw"><span class="bxl">${lab}</span><div class="bxbar"><i style="width:${w ?? 10}%;background:${color}"></i></div><b class="bxv">${v.toFixed(1)}<small>m</small></b></div>`;
 const card = (head, cols, chart) => `<section class="bxcard"><div class="bxtop"><b>Boa e modelli</b>${head}</div><div class="bxcols">${cols}</div>${chart}${fixCard}<p class="bxsrc">${src}</p></section>`;
 box.innerHTML = `<div class="buoy" id="buoyCmp">${card('', col('bxb', 'Boa', +L.hs, null, '#6AA53F'), '')}</div>`;
 bindFix();
 // confronto con il modello nello stesso punto e nelle stesse ore
 try{
  const key = `${bu.lat},${bu.lon}`;
  let m = buoyModelCache[key];
  if (!m || Date.now() - m.at > 3600000){
   const r = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${bu.lat}&longitude=${bu.lon}&cell_selection=sea&timezone=GMT&past_days=2&forecast_days=1&hourly=wave_height`);
   m = buoyModelCache[key] = {at:Date.now(), h:r.hourly};
  }
  const mi = new Map(m.h.time.map((t,i)=>[t.slice(0,13), m.h.wave_height[i]]));
  const pts = bu.series.map(x => ({t:x.t, obs:x.hs, mod: mi.get(x.t.slice(0,13))})).filter(x => x.mod != null);
  const cmp = document.getElementById('buoyCmp'); if (!cmp) return;
  const nowMod = mi.get(L.time.slice(0,13));
  if (!pts.length || nowMod == null) return;
  const diff = Math.round((L.hs / Math.max(nowMod, .05) - 1) * 100);
  const sc = Math.max(nowMod, +L.hs, .3)*1.2, w = v => Math.max(3, Math.round(v/sc*100));
  const sgn = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const verdict = Math.abs(diff) < 10 ? 'modello e boa coincidono' : `${sgn}${Math.abs(diff)}%${fixOn ? (diff > 0 ? ': alziamo la previsione' : ': abbassiamo la previsione') : (diff > 0 ? ' più grosso del previsto' : ' più piccolo del previsto')}`;
  const head = `<em class="bxpill2">${verdict}</em>`;
  let chart = '';
  if (pts.length >= 4){
   const W = 300, Hh = 44, mx = Math.max(.5, ...pts.map(x=>Math.max(x.obs, x.mod)))*1.1;
   const X = i => (i/(pts.length-1 || 1))*W, Y = v => Hh - v/mx*Hh;
   const line = k => pts.map((x,i)=>`${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(x[k]).toFixed(1)}`).join(' ');
   chart = `<svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Onda misurata dalla boa e prevista dal modello nelle ultime ${pts.length} ore">
     <path d="${line('mod')}" fill="none" stroke="#B9B9B3" stroke-width="2" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
     <path d="${line('obs')}" fill="none" stroke="#6AA53F" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>
    <div class="bxlg"><span><i style="background:#6AA53F"></i>Boa</span><span><i style="background:#B9B9B3"></i>Modello</span><span class="bxwin">ultime ${pts.length} ore</span></div>`;
  }
  cmp.innerHTML = card(head, col('', 'Modello', nowMod, w(nowMod), '#E8A094') + col('bxb', 'Boa', +L.hs, w(+L.hs), '#6AA53F'), chart);
  bindFix();
 }catch(e){ /* resta il solo dato della boa */ }
}

// ---------- Correzione delle previsioni con la boa ----------
// Confronto misura e modello nel punto della boa nelle ultime 24 ore: se il modello sbaglia, correggo
// l'onda prevista degli spot vicini. Correzione piena fino all'ultima misura, poi sfuma a zero in 48 ore.
let buoyFix = null;
const FIX_FADE_H = 48;
// boa di riferimento per uno spot: tra quelle entro 250km con misure recenti, preferisco quelle sul lato ovest
// (da dove arrivano le mareggiate del Sinis), poi la più vicina
function refBuoy(p){
 const now = Date.now();
 const list = (buoyData?.buoys || []).map(b => ({...b, d: distanceKm(p, b), brg: bearing(p, b)}))
  .filter(b => b.d <= 250 && now - new Date(b.last.time).getTime() <= 48*3600000);
 const west = b => b.brg >= 200 && b.brg <= 340;
 return list.sort((a,b) => (west(b) - west(a)) || (a.d - b.d))[0] || null;
}
async function applyBuoyFix(){
 buoyFix = null;
 if (!store.get('surf.buoyfix', true) || !buoyData?.buoys?.length) return;
 const bu = refBuoy({lat:SINIS[0], lon:SINIS[1]}); if (!bu) return;
 try{
  const r = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${bu.lat}&longitude=${bu.lon}&cell_selection=sea&timezone=GMT&past_days=3&forecast_days=1&hourly=wave_height`, {}, 1, 15000);
  const mi = new Map(r.hourly.time.map((t,i)=>[t.slice(0,13), r.hourly.wave_height[i]]));
  const lastT = new Date(bu.last.time).getTime();
  const pairs = bu.series.filter(x => lastT - new Date(x.t).getTime() <= 24*3600000)
   .map(x => ({o:x.hs, m:mi.get(x.t.slice(0,13))})).filter(x => x.m != null && x.m > .2 && x.o != null);
  if (pairs.length < 6) return;
  const ratio = clamp(median(pairs.map(x => x.o / x.m)), .6, 1.6);
  buoyFix = {ratio, id:bu.id, name:bu.name || 'Boa ' + bu.id, lastT, n:pairs.length, lat:bu.lat, lon:bu.lon};
  if (Math.abs(ratio - 1) < .05){ buoyFix.applied = false; return; }
  buoyFix.applied = true;
  Object.entries(data).forEach(([id, s]) => {
   const sp = spots.find(x => x.id === id); if (!sp || distanceKm(beach(sp), bu) > 250) return;
   s.hsRaw = s.hsRaw || s.hs.slice(); s.shRaw = s.shRaw || (s.sh ? s.sh.slice() : null);
   const f = s.time.map(t => { const lead = (new Date(t).getTime() - lastT)/3600000; const w = lead <= 0 ? 1 : Math.max(0, 1 - lead/FIX_FADE_H); return 1 + (ratio - 1) * w; });
   s.hs = s.hsRaw.map((v,i) => v == null ? v : v * f[i]);
   if (s.shRaw) s.sh = s.shRaw.map((v,i) => v == null ? v : v * f[i]);
  });
 }catch(e){ buoyFix = null; }
}
function buoyFixNote(sp){
 if (!buoyFix) return '';
 const pct = Math.round((buoyFix.ratio - 1) * 100), on = buoyFix.applied && data[sp.id]?.hsRaw;
 const body = on
  ? `<b>Previsioni corrette</b>: nelle ultime ${buoyFix.n} ore di misure il modello ha ${pct > 0 ? 'sottostimato' : 'sovrastimato'} l'onda del <b>${Math.abs(pct)}%</b>, quindi l'onda prevista qui è ${pct > 0 ? 'alzata' : 'abbassata'} di conseguenza, con la correzione che sfuma nell'arco di 2 giorni.`
  : '<b>Nessuna correzione</b>: il modello è in linea con le misure della boa.';
 return `${cnote(on ? 'amber' : 'green', on ? 'warn' : 'ok', body)}<button class="pillbtn" id="fixToggle" style="margin-top:10px;min-height:40px;font-size:13px">${store.get('surf.buoyfix', true) ? 'Disattiva la correzione' : 'Attiva la correzione'}</button>`;
}

// ---------- Accordo tra i modelli d'onda ----------
const agreeCache = {};
// blocco "Accordo tra i modelli": per il giorno migliore dei prossimi, l'onda al largo secondo ciascun modello
function agreeBlock(sp, res){
 const box = document.getElementById('agreeBox'); if (!box) return;
 const H = res.hourly, keys = Object.keys(H).filter(k => k.startsWith('wave_height_'));
 const names = {meteofrance_wave:'Météo-France', ecmwf_wam025:'ECMWF', ncep_gfswave025:'NCEP'};
 const fd = forecastDays(sp).filter(d => d.best), best = fd.sort((a,b) => b.best.score - a.best.score)[0];
 const day = best ? best.day : todayIso();
 const rows = keys.map(k => { let m = null; H.time.forEach((t,i)=>{ if (!t.startsWith(day)) return; const h = +t.slice(11,13); if (h < DAY_START || h > DAY_END) return; const v = H[k][i]; if (v != null) m = Math.max(m ?? 0, v); });
  return {n: names[k.slice(12)] || k.slice(12), v: m}; }).filter(r => r.v != null);
 if (rows.length < 2){ box.innerHTML = ''; return; }
 const vs = rows.map(r => r.v), lo = Math.min(...vs), hi = Math.max(...vs), mean = vs.reduce((a,b)=>a+b,0)/vs.length, gap = hi - lo, rel = gap / Math.max(mean, .4);
 const [txt, bg, fg] = (gap <= .3 || rel <= .25) ? ['d\'accordo','#26331F','#9FD18B'] : (gap <= .6 || rel <= .5) ? ['abbastanza d\'accordo','#3E3224','#F0A22E'] : ['discordi','#3A2420','#E0624F'];
 const sc = Math.max(hi, .3)*1.3;
 box.innerHTML = `<h3 class="bxh">Accordo tra i modelli</h3><section class="bxsec"><div class="bxhead"><span>Onda al largo, ${dayLabel(day).toLowerCase()}</span><em style="background:${bg};color:${fg}">${txt}</em></div>
  <p style="margin:4px 0 0;font-size:11.5px;color:var(--muted)">${rows.length} modelli a confronto: tra ${lo.toFixed(1)} e ${hi.toFixed(1)}m.</p>
  ${rows.map((r,i) => `<div style="margin-top:14px"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:13px;color:${i ? 'var(--muted)' : 'var(--ink)'}">${r.n}</b><span style="font:700 14px var(--grot);color:${i ? 'var(--muted)' : '#9FD18B'}">${r.v.toFixed(1)}m</span></div><div class="bxbar" style="margin-top:6px;background:#3A3A3A"><i style="width:${Math.round(r.v/sc*100)}%;background:${i ? '#A8A8A3' : '#6AA53F'}"></i></div></div>`).join('')}</section>`;
}
async function loadAgreement(sp){
 const c = agreeCache[sp.id];
 const draw = res => {
  const H = res.hourly, keys = Object.keys(H).filter(k => k.startsWith('wave_height_'));
  document.querySelectorAll('#v-detail [data-agree]').forEach(el => {
   const day = el.dataset.agree, maxes = keys.map(k => {
    let m = null; H.time.forEach((t,i)=>{ if (!t.startsWith(day)) return; const h = +t.slice(11,13); if (h < DAY_START || h > DAY_END) return; const v = H[k][i]; if (v != null) m = Math.max(m ?? 0, v); });
    return m; }).filter(v => v != null);
   if (maxes.length < 2){ el.innerHTML = ''; return; }
   const lo = Math.min(...maxes), hi = Math.max(...maxes), mean = maxes.reduce((a,b)=>a+b,0)/maxes.length;
   const gap = hi - lo, rel = gap / Math.max(mean, 0.4);
   // d'accordo se differiscono di poco in assoluto o in proporzione
   const [txt, col] = (gap <= .3 || rel <= .25) ? ['Modelli d\'accordo','var(--s3)'] : (gap <= .6 || rel <= .5) ? ['Modelli abbastanza d\'accordo','var(--s1)'] : ['Modelli discordi','#C0504D'];
   el.innerHTML = `<i style="--c:${col}"></i><span><b>${txt}</b>: al largo tra ${lo.toFixed(1)}m e ${hi.toFixed(1)}m (${maxes.length} modelli)</span>`;
   el.title = `Onda al largo secondo ${maxes.length} modelli: da ${lo.toFixed(1)}m a ${hi.toFixed(1)}m`;
   const ad = document.querySelector(`#v-detail [data-agdot="${day}"]`); if (ad){ ad.style.setProperty('--c', col); ad.title = txt; ad.hidden = false; }
  });
  agreeBlock(sp, res);
 };
 if (c && Date.now() - c.at < 3600000){ draw(c.res); return; }
 try{
  const res = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${sp.lat}&longitude=${sp.lon}&cell_selection=sea&timezone=${encodeURIComponent(TZ)}&forecast_days=7&hourly=wave_height&models=meteofrance_wave,ecmwf_wam025,ncep_gfswave025`);
  agreeCache[sp.id] = {at:Date.now(), res}; draw(res);
 }catch(e){}
}

const TAB_OF = {wx:'info', tide:'info', cal:'boa', week:'week', season:'week'};
let detailTab = 'now';
function showDetailTab(name, keepScroll){
 detailTab = name;
 document.querySelectorAll('#v-detail .tpanel').forEach(p => p.hidden = p.dataset.panel !== name);
 document.querySelectorAll('#dtabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tabD === name));
 if (!keepScroll){ const t = document.getElementById('dtabs'); if (t && t.getBoundingClientRect().top < 0) scrollTo({top: Math.max(0, t.getBoundingClientRect().top + scrollY - 12), behavior:'auto'}); }
}
function mountTiles(ev){
 const hero = document.querySelector('#v-detail .hero'); if (!hero) return;
 const d = document.createElement('div'); d.className = 'tiles htiles';
 d.innerHTML = `<div><span class="l">A riva</span><b>${ev ? ev.face.toFixed(1) : '–'}</b><span class="u">metri</span></div>
  <div><span class="l">Al largo</span><b>${ev ? ev.hs.toFixed(1) : '–'}</b><span class="u">metri</span></div>
  <div><span class="l">Acqua</span><b id="adAcqua">–</b><span class="u">gradi</span></div>
  <div><span class="l">Raffiche</span><b id="adRaff">–</b><span class="u">km/h</span></div>`;
 hero.appendChild(d);
}
function openSection(key, open){
 const sec = document.getElementById('sec-' + key); if (!sec) return;
 if (TAB_OF[key] && open !== false) showDetailTab(TAB_OF[key], true);
 const btn = sec.querySelector('[data-toggle]'), body = document.getElementById('body-' + key);
 if (!btn || !body) return;
 const on = open ?? btn.getAttribute('aria-expanded') !== 'true';
 btn.setAttribute('aria-expanded', on); body.hidden = !on; sec.classList.toggle('open', on);
}
function initDetailNav(){
 document.querySelectorAll('#v-detail [data-toggle]').forEach(t => t.onclick = () => openSection(t.dataset.toggle));
 const tabs = document.getElementById('dtabs'); if (!tabs) return;
 tabs.onclick = e => { const b = e.target.closest('[data-tab-d]'); if (b) showDetailTab(b.dataset.tabD); };
 openSection('season', true); openSection('week', true);
 showDetailTab('now', true);
}

// colore del testo per ogni livello, leggibile su fondo chiaro
const scoreInk = sc => sc == null || sc < 1.5 ? '#4F616C' : sc < 2.5 ? '#8A6A10' : sc < 3.5 ? '#3F7A2E' : sc < 4.5 ? '#1F7A45' : '#4B3A9E';
function weekSummary(best){
 if (!best || best.best.score < 2) return '<span><b>Niente</b>in vista</span>';
 const sc = best.best.score;
 return `<span><b>${scoreLabel(sc)} ${sc}</b>${dayLabel(best.day).toLowerCase()}</span>`;
}
function weekInfo(days){
 if (!days.length) return 'Nessun dato';
 const mx = days.reduce((a,d)=> d.maxFace > a.maxFace ? d : a, days[0]);
 return `Prossimi 7 giorni, onda fino a ${mx.maxFace.toFixed(1)}m ${dayLabel(mx.day).toLowerCase()}`;
}
function seasonInfo(sp){
 const st = store.get(statKey(sp), null);
 if (!st) return 'Quando conviene andarci, dai dati storici';
 const m = st.months, tot = m.reduce((a,x)=>a+x.good,0), n = m.reduce((a,x)=>a+x.n,0);
 return `Surfabile in media ${n ? Math.round(tot/n*365) : 0} giorni l'anno (${st.years})`;
}
function seasonSummary(sp){
 const st = store.get(statKey(sp), null);
 if (!st) return '<span>Da calcolare</span>';
 const top = st.months.map((m,i)=>({i, p:m.n ? m.good/m.n : 0})).sort((a,b)=>b.p-a.p).filter(x=>x.p>0).slice(0,3).map(x=>MONTHS[x.i]);
 return top.length ? `<span><b>${top.join(' · ')}</b>mesi migliori</span>` : '<span>Nessun mese buono</span>';
}

// ---------- Stagioni: statistiche storiche per mese ----------
// Scarica 3 anni di onde (Open-Meteo Marine) e vento (archivio ERA5), valuta ogni giorno alle 8, 11, 14 e 17
// con la stessa formula delle previsioni e conta, mese per mese, quanti giorni lo spot sarebbe stato surfabile.
const MONTHS = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const MONTHS_LONG = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
const statKey = sp => 'surf.stats.' + sp.id + '.' + [sp.lat, sp.lon, sp.facing, sp.window, sp.offshore, sp.min, sp.max, sp.minPeriod].join('|');
function seasonHtml(sp, selIn){
 const st = store.get(statKey(sp), null);
 if (!st) return `<p class="small">Quanti giorni al mese questo spot è stato surfabile negli ultimi anni: utile per scegliere il periodo di un viaggio.</p>
  <button class="pillbtn primary" id="seasonGo" style="margin-top:12px">Calcola le statistiche</button>
  <p class="xs muted" style="margin-top:8px">Scarica circa 3 anni di dati storici (qualche MB): meglio col Wi-Fi. Si fa una volta sola, poi resta salvato.</p>`;
 const pct = m => m.n ? Math.round(m.good / m.n * 100) : 0, pctA = m => m.n ? Math.round(m.act / m.n * 100) : 0;
 const maxP = Math.max(10, ...st.months.map(pctA));
 const order = st.months.map((m,i)=>({i, p:pct(m)})).sort((a,b)=>b.p-a.p);
 const top = order.filter(x=>x.p>0).slice(0,3).map(x=>x.i);
 const best = order[0], sel = selIn != null ? selIn : best.i, m = st.months[sel];
 const dim = [31,28,31,30,31,30,31,31,30,31,30,31][sel];
 const gD = m.n ? m.good / m.n * dim : 0, lD = m.n ? (m.act - m.good) / m.n * dim : 0;
 const gTxt = gD < .5 ? 'meno di un giorno' : `circa ${Math.round(gD)} su ${dim}`;
 const lTxt = lD < .5 ? 'meno di un giorno' : `circa ${Math.round(lD)} ${Math.round(lD) === 1 ? 'giorno' : 'giorni'}`;
 const name = MONTHS_LONG[sel].charAt(0).toUpperCase() + MONTHS_LONG[sel].slice(1);
 const card = `<div class="sdet" aria-live="polite"><div class="sdh"><b>${name}</b>${top.includes(sel) ? '<span class="sdchip">tra i mesi migliori</span>' : ''}</div>
   <p><i></i><span><b>${pct(m)}%</b> dei giorni surfabili, ${gTxt}</span></p>
   <p><i class="lo"></i><span><b>${pctA(m) - pct(m)}%</b> al limite, ${lTxt}</span></p>
   ${m.good ? `<p>${WXI.water}<span>Onda a riva media nei giorni buoni: <b>${m.avg.toFixed(1)}m</b></span></p>` : ''}</div>`;
 return `<p class="xs muted">Ogni barra è un mese: tocca un mese per vedere i dettagli.</p><div class="mbars" role="group" aria-label="Giorni surfabili per mese">${st.months.map((mm,i)=>`<button type="button" class="mcol${i===sel?' sel':''}" data-m="${i}" aria-pressed="${i===sel}" aria-label="${MONTHS_LONG[i]}: ${pct(mm)}% di giorni surfabili"><span class="v">${pct(mm)}</span>
   <i style="height:calc((100% - 22px) * ${(pctA(mm) - pct(mm)) / maxP})" class="lo"></i><i style="height:calc((100% - 22px) * ${pct(mm) / maxP});margin-top:-3px"></i></button>`).join('')}</div>
  <div class="mlab">${MONTHS.map((n,i)=>`<span data-m="${i}" class="${top.includes(i)?'top':''}${i===sel?' sel':''}">${n}</span>`).join('')}</div>
  <div class="legend" style="margin-top:10px"><span><i style="--c:var(--tacc)"></i><b>Surfabili<em>punteggio 3 o più</em></b></span><span><i style="--c:var(--tacc);opacity:.35"></i><b>Al limite<em>punteggio 2–2.5</em></b></span></div>
  ${best.p > 0 ? card : ''}
  <div class="sbox">${best.p > 0 ? `<p><b>Mesi migliori:</b> ${top.map(i=>MONTHS_LONG[i]).join(', ')}.</p>`
   : '<p>Negli anni analizzati lo spot non ha mai raggiunto un punteggio di 3: forse i parametri dello spot (direzione, range di onda) vanno rivisti.</p>'}
   <p class="xs muted" style="margin-top:6px">Dati ${st.years}, modello Open-Meteo: sono medie indicative, non una garanzia. Se cambi i parametri dello spot le statistiche si ricalcolano.</p>
   <button class="pillbtn" id="seasonRedo" style="margin-top:8px;min-height:36px;font-size:13px">Ricalcola</button></div>`;
}
function bindSeason(sp){
 const box = document.getElementById('seasonBox'); if (!box) return;
 const go = ()=>computeSeason(sp);
 const a = document.getElementById('seasonGo'), r = document.getElementById('seasonRedo');
 if (a) a.onclick = go; if (r) r.onclick = go;
 box.querySelectorAll('[data-m]').forEach(el => el.onclick = () => {
  const i = +el.dataset.m; box.innerHTML = seasonHtml(sp, i); bindSeason(sp);
  const b = box.querySelector(`button[data-m="${i}"]`); if (b && el.tagName === 'BUTTON') b.focus({preventScroll:true});
 });
}
async function computeSeason(sp){
 const box = document.getElementById('seasonBox');
 const say = t => { if (box && box.dataset.spot === sp.id) box.innerHTML = `<p class="small">${t}</p>`; };
 const y = +todayIso().slice(0,4), start = `${y-3}-01-01`, end = `${y-1}-12-31`;
 const b = beach(sp);
 say('Scarico onde e vento degli ultimi tre anni…');
 try{
  const [m, w] = await Promise.all([
   getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${sp.lat}&longitude=${sp.lon}&cell_selection=sea&timezone=${encodeURIComponent(TZ)}&start_date=${start}&end_date=${end}&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`, {}, 2, 90000),
   getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${b.lat}&longitude=${b.lon}&timezone=${encodeURIComponent(TZ)}&start_date=${start}&end_date=${end}&hourly=wind_speed_10m,wind_direction_10m`, {}, 2, 90000)
  ]);
  say('Calcolo mese per mese…');
  const mh = m.hourly, wh = w.hourly, wi = new Map(wh.time.map((t,i)=>[t,i]));
  const pick = (arr, t) => { const i = wi.get(t); return i == null ? null : arr[i]; };
  const s = {time:mh.time, hs:mh.wave_height, dir:mh.wave_direction, per:mh.wave_period, sh:mh.swell_wave_height, sd:mh.swell_wave_direction, sp:mh.swell_wave_period,
   ws:mh.time.map(t=>pick(wh.wind_speed_10m,t)), wd:mh.time.map(t=>pick(wh.wind_direction_10m,t))};
  const days = {};
  for (let i = 0; i < s.time.length; i++){
   const h = s.time[i].slice(11,13); if (!['08','11','14','17'].includes(h)) continue;
   const e = evaluate(sp, s, i); if (!e) continue;
   const d = s.time[i].slice(0,10), cur = days[d];
   if (!cur || e.score > cur.score) days[d] = {score:e.score, face:e.face};
  }
  const months = MONTHS.map(()=>({n:0, good:0, act:0, sum:0}));
  let first = null, last = null;
  Object.entries(days).forEach(([d, v])=>{
   const mo = +d.slice(5,7) - 1, M = months[mo];
   M.n++; if (v.score >= 2) M.act++; if (v.score >= 3){ M.good++; M.sum += v.face; }
   first = !first || d < first ? d : first; last = !last || d > last ? d : last;
  });
  if (!first) throw new Error('nessun dato storico per questo punto');
  months.forEach(M => M.avg = M.good ? M.sum / M.good : 0);
  store.set(statKey(sp), {at:Date.now(), years:`${first.slice(0,4)}–${last.slice(0,4)}`, months});
  if (box && box.dataset.spot === sp.id){ box.innerHTML = seasonHtml(sp); bindSeason(sp); const sm = document.getElementById('sum-season'); if (sm) sm.innerHTML = seasonSummary(sp); const si = document.getElementById('info-season'); if (si) si.textContent = seasonInfo(sp); }
 }catch(e){
  if (box && box.dataset.spot === sp.id){ box.innerHTML = `<p class="small">Statistiche non disponibili (${esc(e.message)}).</p><button class="pillbtn" id="seasonGo" style="margin-top:8px">Riprova</button>`; bindSeason(sp); }
 }
}

// ---------- Qualità del periodo ----------
const PERIODS = [
 {to:6, t:'Corto', c:'var(--s0)', fg:'#D5D8D4', d:'Mare di vento: onde corte e disordinate, con poca spinta.'},
 {to:8, t:'Scarso', c:'var(--s1)', fg:'#171717', d:'Onde ancora deboli e ravvicinate.'},
 {to:10, t:'Discreto', c:'var(--s2)', fg:'#171717', d:'Onde abbastanza ordinate, si surfa.'},
 {to:13, t:'Buono', c:'var(--s3)', fg:'#171717', d:'Swell ben formato: onde più potenti, più spazio tra una e l\'altra.'},
 {to:99, t:'Ottimo', c:'var(--s4)', fg:'#171717', d:'Swell lungo: onde potenti e pulite che arrivano a serie.'}
];
function periodCell(sp, T){
 const p = PERIODS.find(x => T < x.to), MAX = 16;
 let from = 0;
 const zones = PERIODS.map(x=>{ const w = (Math.min(x.to, MAX) - from)/MAX*100; from = Math.min(x.to, MAX); return `<i style="width:${w}%;background:${x.c}"></i>`; }).join('');
 const pos = Math.min(T, MAX)/MAX*100;
 const note = T < sp.minPeriod ? `Sotto il minimo di questo spot (${sp.minPeriod}s): il punteggio ne risente.` : `Sopra il minimo di questo spot (${sp.minPeriod}s).`;
 return `<div class="wide">${chd('blue','wave','Periodo dello swell',`<b class="cval">${Math.round(T)}s</b>`,`<span class="ppill" style="--c:${p.c};--fg:${p.fg}">${p.t}</span>`)}
  <div class="pwrap" role="img" aria-label="Periodo ${Math.round(T)} secondi, ${p.t.toLowerCase()}"><div class="pbar">${zones}</div><span class="pmark" style="left:${pos}%"></span></div>
  <div class="pscale">${[0,6,8,10,13].map(v=>`<span style="left:${v/MAX*100}%">${v}</span>`).join('')}<span style="left:100%">16+ s</span></div>
  <p class="xs muted" style="margin-top:8px">${p.d}</p>${cnote(T < sp.minPeriod ? 'amber' : 'green', T < sp.minPeriod ? 'warn' : 'ok', note)}</div>`;
}

// ---------- Legenda del cerchio ----------
function dialLegend(sp, ev){
 const a0 = ((sp.facing - sp.window) % 360 + 360) % 360, a1 = (sp.facing + sp.window) % 360;
 const swell = ev ? ` Adesso arriva da ${cardinal(ev.dir)} (${Math.round(ev.dir)}°) con periodo di ${Math.round(ev.T)} s${angDiff(ev.dir, sp.facing) <= sp.window ? ', dentro la finestra' : ', fuori dalla finestra'}.` : '';
 const wind = ev ? (ev.ws < 3 ? ' Adesso è quasi assente, per questo non si vede.' : ` Adesso soffia da ${cardinal(ev.wd)} a ${Math.round(ev.ws)}km/h (${ev.windType}).`) : '';
 return `<div><p class="small muted" style="text-align:center">Il nord è in alto, come su una mappa.</p>
  <div class="lrow"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M5 5 L20 20" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/><path d="M22 22 L14 20 L20 14Z" fill="var(--accent)"/></svg>
   <p><b>Freccia blu: lo swell.</b> Parte dal lato da cui arrivano le onde e punta verso lo spot.${swell}</p></div>
  <div class="lrow"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M6 22 L22 6" stroke="var(--wind)" stroke-width="2.5" stroke-dasharray="4 4"/></svg>
   <p><b>Tratteggio: il vento.</b> Sta sul lato da cui soffia.${wind} Qui il vento ideale (offshore) viene da ${cardinal(sp.offshore)}.</p></div>
  <div class="lrow"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M4 20 A11 11 0 0 1 20 5" fill="none" stroke="var(--s2)" stroke-width="5" stroke-linecap="round"/></svg>
   <p><b>Arco verde: la finestra dello spot.</b> Le direzioni da cui lo swell entra bene, qui da ${cardinal(a0)} a ${cardinal(a1)}. Con la freccia dentro l'arco le onde arrivano piene; più ne esce, meno lo spot le prende.</p></div>
 </div>`;
}

// ---------- Meteo e marea ----------
const extraCache = {};
const SKY = {
 clear:{bg:'#F6EBD3', acc:'#95660F'}, part:{bg:'#F2ECDD', acc:'#86692C'}, cloud:{bg:'#E4E8EC', acc:'#56646F'},
 fog:{bg:'#E7E9E9', acc:'#5E6A70'}, rain:{bg:'#DDE6EF', acc:'#3E5F80'}, snow:{bg:'#EBF1F6', acc:'#5A7390'},
 storm:{bg:'#E2DFEB', acc:'#4B456E'}, night:{bg:'#E2E5F1', acc:'#3F4C7A'}
};
const skyKind = (c, day) => c == null ? 'clear' : c === 0 ? (day ? 'clear' : 'night') : c <= 2 ? (day ? 'part' : 'night') : c === 3 ? 'cloud'
 : c <= 48 ? 'fog' : c <= 67 ? 'rain' : c <= 77 ? 'snow' : c <= 82 ? 'rain' : 'storm';
const CLOUD = '<path d="M58 150h96a30 30 0 0 0 0-60 44 44 0 0 0-84-10 34 34 0 0 0-12 70z" fill="currentColor"/>';
const SKY_MOTIF = {
 clear: null,
 part: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><circle cx="120" cy="70" r="36" fill="currentColor" opacity=".7"/><g stroke="currentColor" stroke-width="7" stroke-linecap="round" opacity=".7">${Array.from({length:8},(_, i)=>{const a=i*45*Math.PI/180; return `<line x1="${(120+50*Math.sin(a)).toFixed(1)}" y1="${(70-50*Math.cos(a)).toFixed(1)}" x2="${(120+66*Math.sin(a)).toFixed(1)}" y2="${(70-66*Math.cos(a)).toFixed(1)}"/>`;}).join('')}</g>${CLOUD}</svg>`,
 cloud: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g transform="translate(-20 -30) scale(.8)" opacity=".6">${CLOUD}</g>${CLOUD}</svg>`,
 fog: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g stroke="currentColor" stroke-width="12" stroke-linecap="round"><path d="M30 70h140M50 100h120M24 130h130M60 160h100"/></g></svg>`,
 rain: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g transform="translate(0 -30)">${CLOUD}</g><g stroke="currentColor" stroke-width="8" stroke-linecap="round"><path d="M70 150l-10 24M104 150l-10 24M138 150l-10 24"/></g></svg>`,
 snow: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g transform="translate(0 -30)">${CLOUD}</g><g fill="currentColor"><circle cx="66" cy="160" r="7"/><circle cx="100" cy="172" r="7"/><circle cx="134" cy="160" r="7"/></g></svg>`,
 storm: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><g transform="translate(0 -30)">${CLOUD}</g><path d="M108 124l-26 40h22l-10 30 34-46h-22l12-24z" fill="currentColor"/></svg>`,
 night: `<svg class="motif" viewBox="0 0 200 200" aria-hidden="true"><path d="M124 40a60 60 0 1 0 40 104A48 48 0 0 1 124 40z" fill="currentColor"/><g fill="currentColor"><circle cx="50" cy="50" r="5"/><circle cx="76" cy="26" r="3.5"/><circle cx="40" cy="96" r="3.5"/></g></svg>`
};
function paintSky(code, day){
 const sec = document.getElementById('sec-wx'), mot = document.getElementById('wxMotif'); if (!sec) return;
 const k = skyKind(code, day), c = SKY[k];
 sec.style.setProperty('--sbg', c.bg); sec.style.setProperty('--tacc', c.acc);
 if (mot) mot.innerHTML = SKY_MOTIF[k] || MOTIF.wx;
}
const WX = c => c === 0 ? ['☀️','🌙','Sereno'] : c <= 2 ? ['🌤️','🌙','Poco nuvoloso'] : c === 3 ? ['☁️','☁️','Coperto']
 : c <= 48 ? ['🌫️','🌫️','Nebbia'] : c <= 57 ? ['🌦️','🌧️','Pioviggine'] : c <= 67 ? ['🌧️','🌧️','Pioggia']
 : c <= 77 ? ['🌨️','🌨️','Neve'] : c <= 82 ? ['🌦️','🌧️','Rovesci'] : ['⛈️','⛈️','Temporale'];
const wxIcon = (c, day) => WX(c ?? 0)[day ? 0 : 1];
async function loadExtra(sp){
 const c = extraCache[sp.id];
 if (c && Date.now() - c.at < 60*60*1000){ renderExtra(sp, c); return; }
 const b = beach(sp), tz = encodeURIComponent(TZ);
 try{
  const [fc, mr] = await Promise.all([
   getJson(`https://api.open-meteo.com/v1/forecast?latitude=${b.lat}&longitude=${b.lon}&timezone=${tz}&forecast_days=2&hourly=temperature_2m,weather_code,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset,wind_gusts_10m_max`),
   getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${sp.lat}&longitude=${sp.lon}&cell_selection=sea&timezone=${tz}&past_days=1&forecast_days=2&hourly=sea_level_height_msl,sea_surface_temperature`)
  ]);
  extraCache[sp.id] = {at:Date.now(), fc, mr};
  renderExtra(sp, extraCache[sp.id]);
 }catch(e){
  ['extraWx','extraTide'].forEach(id=>{ const el = document.getElementById(id);
   if (el && el.dataset.spot === sp.id) el.innerHTML = `<p class="small muted">Non disponibile adesso (${esc(e.message)}).</p>`; });
  ['wx','tide'].forEach(k=>{ const i = document.getElementById('info-'+k), m = document.getElementById('sum-'+k); if (i) i.textContent = 'Non disponibile ora'; if (m) m.innerHTML = ''; });
 }
}
function tideExtremes(time, h){
 const out = [];
 for (let i = 1; i < h.length-1; i++){
  if (h[i-1] == null || h[i] == null || h[i+1] == null) continue;
  const hi = h[i] >= h[i-1] && h[i] > h[i+1], lo = h[i] <= h[i-1] && h[i] < h[i+1];
  if (!hi && !lo) continue;
  const den = h[i-1] - 2*h[i] + h[i+1], off = den ? 0.5*(h[i-1]-h[i+1])/den : 0;
  const t = new Date(time[i] + ':00Z').getTime() + off*3600*1000;
  out.push({hi, t, v: h[i] - 0.25*(h[i-1]-h[i+1])*off, day: time[i].slice(0,10)});
 }
 return out;
}
const hm = ms => new Date(ms).toISOString().slice(11,16);
function renderExtra(sp, {fc, mr}){
 const elW = document.getElementById('extraWx'), elT = document.getElementById('extraTide');
 if (!elW || elW.dataset.spot !== sp.id) return;
 const H = fc.hourly, D = fc.daily, key = nowKey(), today = todayIso();
 const i0 = Math.max(0, H.time.indexOf(key));
 const mi = mr.hourly.time.indexOf(key);
 const sst = mi >= 0 ? mr.hourly.sea_surface_temperature?.[mi] : null;
 const di = Math.max(0, D.time.indexOf(today));
 const ic = wxIcon(H.weather_code[i0], H.is_day[i0]), label = WX(H.weather_code[i0] ?? 0)[2];
 // prossime ore, ogni 3 ore
 const s = data[sp.id], slots = [i0];
 for (let i = i0 + 3 - (+H.time[i0].slice(11,13) % 3); i < H.time.length && slots.length < 8; i += 3) slots.push(i);
 const hours = slots.map((i,k)=>{
  const si = s ? s.time.indexOf(H.time[i]) : -1, ev = si >= 0 ? evaluate(sp, s, si) : null;
  return `<div class="hr${k===0?' now':''}"><span>${k===0 ? 'Ora' : H.time[i].slice(11,16)}</span><div class="i">${wxSvg(H.weather_code[i], H.is_day[i], 26)}</div>
   <b>${Math.round(H.temperature_2m[i])}°</b><span>${cardinal(H.wind_direction_10m[i])} ${Math.round(H.wind_speed_10m[i])}</span><span>${ev ? ev.face.toFixed(1)+'m' : ''}</span></div>`;
 }).join('');
 const sr = D.sunrise?.[di]?.slice(11,16), ss = D.sunset?.[di]?.slice(11,16);
 const wx = `<div class="wx">
  <div class="wxnow"><span class="wxi" style="background:${wxBg(H.weather_code[i0], H.is_day[i0])}" aria-hidden="true">${wxSvg(H.weather_code[i0], H.is_day[i0], 44)}</span>
   <div><p class="wxt">${Math.round(H.temperature_2m[i0])}°</p><p class="wxl">${label}</p><p class="xs muted">max ${Math.round(D.temperature_2m_max[di])}° · min ${Math.round(D.temperature_2m_min[di])}°</p></div></div>
  <div class="wxgrid">
   <div><span class="wl">${WXI.water}Acqua</span><b>${sst != null ? sst.toFixed(1)+'°' : '–'}</b></div>
   <div><span class="wl">${WXI.gust}Raffiche</span><b>${Math.round(H.wind_gusts_10m[i0])}km/h</b></div>
   <div><span class="wl">${WXI.rain}Pioggia oggi</span><b>${(D.precipitation_sum[di] ?? 0).toFixed(1)}mm</b></div>
   <div><span class="wl">${WXI.sunr}Alba e tramonto</span><b>${sr || '–'} / ${ss || '–'}</b></div></div>
  <div class="hours" aria-label="Prossime ore: meteo, vento in km/h e onda a riva">${hours}</div>
  <p class="xs muted" style="margin-top:10px">Ogni casella: ora, cielo, temperatura, vento (da, km/h) e onda a riva.</p></div>`;

 // marea
 const T = mr.hourly.time, L = mr.hourly.sea_level_height_msl || [];
 const idx = T.map((t,i)=>t.startsWith(today) ? i : -1).filter(i=>i>=0 && L[i] != null);
 let tide;
 if (idx.length < 12){
  tide = `<div class="tide"><p class="small muted">Dato di marea non disponibile per questo punto.</p></div>`;
 } else {
  const vals = idx.map(i=>L[i]), mn = Math.min(...vals), mx = Math.max(...vals), span = Math.max(mx - mn, 0.05);
  const X = h => 10 + h/24*280, Y = v => 70 - (v - mn)/span*55;
  const pts = idx.map(i=>`${X(+T[i].slice(11,13)).toFixed(1)},${Y(L[i]).toFixed(1)}`);
  const nowH = +key.slice(11,13) + new Date().getMinutes()/60;
  const ex = tideExtremes(T, L).filter(e=>e.day === today);
  const dots = ex.map(e=>{ const hh = (e.t - new Date(today+'T00:00:00Z').getTime())/3600000;
   return `<circle cx="${X(hh).toFixed(1)}" cy="${Y(e.v).toFixed(1)}" r="3.5" fill="${e.hi ? 'var(--tacc, var(--accent))' : 'var(--muted)'}"/>`; }).join('');
  const hiT = ex.filter(e=>e.hi).map(e=>hm(e.t)).join(', ') || '–', loT = ex.filter(e=>!e.hi).map(e=>hm(e.t)).join(', ') || '–';
  const cm = Math.round((mx - mn)*100);
  tide = `<div class="tide"><p class="small muted">Escursione di oggi: <b style="color:var(--ink)">${cm}cm</b></p>
   <svg viewBox="0 0 300 92" role="img" aria-label="Andamento della marea oggi: alte alle ${hiT}, basse alle ${loT}">
    <path d="M${pts[0]} L${pts.join(' L')} L${X(+T[idx.at(-1)].slice(11,13)).toFixed(1)},72 L${X(+T[idx[0]].slice(11,13)).toFixed(1)},72Z" fill="var(--sea)"/>
    <path d="M${pts.join(' L')}" fill="none" stroke="var(--tacc, var(--accent))" stroke-width="2"/>
    <line x1="${X(nowH).toFixed(1)}" y1="8" x2="${X(nowH).toFixed(1)}" y2="72" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="3 3"/>
    ${dots}
    ${[0,6,12,18,24].map(h=>`<text x="${X(h)}" y="86" text-anchor="middle" style="font:11px var(--mono);fill:var(--muted)">${String(h).padStart(2,'0')}</text>`).join('')}
   </svg>
   <div class="tx"><div><b>ALTA</b>${hiT}</div><div><b>BASSA</b>${loT}</div></div>
   <p class="xs muted" style="margin-top:8px">${cm < 40 ? 'Nel Mediterraneo la marea sposta il mare di pochi centimetri: conta poco sulle onde, ma sui reef bassi può fare la differenza.' : 'La linea tratteggiata è adesso.'} Dato modellistico, indicativo.</p></div>`;
 }
 elW.innerHTML = wx; elT.innerHTML = tide;
 const aA = document.getElementById('adAcqua'), aR = document.getElementById('adRaff');
 if (aA) aA.textContent = sst != null ? sst.toFixed(1) : '–';
 if (aR) aR.textContent = Math.round(H.wind_gusts_10m[i0]);
 const stl = document.querySelector('#sec-wx .stile');
 if (stl){ stl.innerHTML = wxSvg(H.weather_code[i0], H.is_day[i0], 26); stl.style.setProperty('--tbg', wxBg(H.weather_code[i0], H.is_day[i0])); }
 paintSky(H.weather_code[i0], H.is_day[i0]);
 const sw = document.getElementById('sum-wx');
 if (sw) sw.innerHTML = `<span><b>${Math.round(H.temperature_2m[i0])}° ${label.toLowerCase()}</b>${sst != null ? '· acqua ' + sst.toFixed(1) + '°' : ''}</span>`;
 const iw = document.getElementById('info-wx');
 if (iw) iw.textContent = `Vento ${cardinal(H.wind_direction_10m[i0])} ${Math.round(H.wind_speed_10m[i0])}km/h`;
 const it = document.getElementById('info-tide');
 if (it){ const v = idx.map(i=>L[i]); it.textContent = idx.length >= 12 ? `Escursione di oggi ${Math.round((Math.max(...v)-Math.min(...v))*100)}cm` : 'Dato non disponibile qui'; }
 const st = document.getElementById('sum-tide');
 if (st){
  const nowMs = new Date(key + ':00Z').getTime() + new Date().getMinutes()*60000;
  const nx = tideExtremes(T, L).find(e => e.t > nowMs);
  st.innerHTML = nx ? `<span><b>${nx.hi ? '↑ Alta' : '↓ Bassa'} ${hm(nx.t)}</b>${nx.day === today ? 'prossima' : 'domani'}</span>` : '<span>Non disponibile</span>';
 }
}

function toggleFollow(id){
 const list = spots.filter(isFollowed).map(s=>s.id);
 followed = list.includes(id) ? list.filter(x=>x!==id) : [...list, id];
 store.set('surf.followed', followed);
}

// ---------- Mappa ----------
function mapScore(sp){
 if (mapDay === 'now') return nowEval(sp);
 const d = forecastDays(sp).find(x=>x.day===mapDay);
 return d ? {...d.best, face:d.maxFace} : null;
}
function renderMap(){
 const days = allDays();
 document.getElementById('chips').innerHTML = [['now','Adesso'], ...days.map(d=>[d, dayChip(d)])]
  .map(([k,l])=>`<button aria-pressed="${mapDay===k}" data-day="${k}">${l}</button>`).join('');
 document.getElementById('mapSub').textContent = mapDay === 'now' ? 'Punteggi di adesso' : `Il meglio di ${dayLabel(mapDay).toLowerCase()} nelle ore di luce`;
 if (!window.L){ document.getElementById('leaf').innerHTML = '<p class="muted" style="padding:16px">Mappa non disponibile: controlla la connessione.</p>'; return; }
 if (!leaf){
  leaf = L.map('leaf', {zoomControl:false, attributionControl:true}).setView(SINIS, 11);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {maxZoom:18, maxNativeZoom:16, attribution:'Tiles &copy; Esri'}).addTo(leaf);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {maxZoom:18, maxNativeZoom:16, pane:'shadowPane'}).addTo(leaf);
  const all = spots.map(sp=>beach(sp)), home = all.filter(b => distanceKm(b, {lat:SINIS[0], lon:SINIS[1]}) < 100);
  const pts = (home.length > 1 ? home : all).map(b=>[b.lat, b.lon]);
  if (pts.length > 1) leaf.fitBounds(pts, {paddingTopLeft:[30,70], paddingBottomRight:[30,110], maxZoom:13});
  const cluster = (cls, fn) => L.markerClusterGroup ? L.markerClusterGroup({chunkedLoading:true, showCoverageOnHover:false, maxClusterRadius:48, disableClusteringAtZoom:13, spiderfyOnMaxZoom:false, iconCreateFunction:fn}) : L.layerGroup();
  myLayer = cluster('my', c => {
   const best = Math.max(...c.getAllChildMarkers().map(m => m.options.score ?? -1));
   const [bg,fg] = tone(best < 0 ? null : best);
   return L.divIcon({className:'', iconSize:[40,40], iconAnchor:[20,20], html:`<div class="clu" style="--c:${bg};--fg:${fg}" aria-label="${c.getChildCount()} spot, il migliore ${best < 0 ? 'n.d.' : best} su 5">${c.getChildCount()}</div>`});
  }).addTo(leaf);
  catLayer = cluster('cat', c => {
   const best = Math.max(...c.getAllChildMarkers().map(m => m.options.score ?? -1));
   const [bg,fg] = best < 0 ? ['#2B2B2B','#F0A22E'] : tone(best);
   return L.divIcon({className:'', iconSize:[40,40], iconAnchor:[20,20], html:`<div class="clu cat" style="--c:${bg};--fg:${fg}" aria-label="${c.getChildCount()} spot noti${best < 0 ? '' : ', potenziale migliore ' + best + ' su 5'}">${c.getChildCount()}</div>`});
  });
  if (store.get('surf.showCat', true)) catLayer.addTo(leaf);
  leaf.on('click', ()=>{ mapSel = null; catSel = null; renderMap(); });
  leaf.on('moveend', ()=>{ loadCatalog(); loadCatScores(); });
  setTimeout(()=>{ addCatPins(SEED); loadEurope(); }, 300);
 }
 spots.forEach(sp=>{
  const e = mapScore(sp), [bg,fg] = tone(e?.score), b = beach(sp);
  const icon = L.divIcon({className:'', iconSize:[34,34], iconAnchor:[17,17],
   html:`<div class="pin${mapSel===sp.id?' sel':''}" style="--c:${bg};--fg:${fg}" aria-label="${esc(sp.name)}, ${e?.score ?? 'n.d.'} su 5">${e?.score ?? '–'}</div>`});
  if (leafPins[sp.id]){ leafPins[sp.id].options.score = e?.score; leafPins[sp.id].setIcon(icon); }
  else {
   leafPins[sp.id] = L.marker([b.lat, b.lon], {icon, keyboard:true, title:sp.name, score:e?.score});
   myLayer.addLayer(leafPins[sp.id]);
   leafPins[sp.id].on('click', ev=>{ L.DomEvent.stopPropagation(ev); mapSel = sp.id; catSel = null; renderMap(); });
  }
 });
 if (myLayer.refreshClusters && leaf.hasLayer(myLayer)) try{ myLayer.refreshClusters(); }catch(e){ console.warn(e); }
 const card = document.getElementById('mapCard'), sel = spots.find(s=>s.id===mapSel);
 refreshCatIcons();
 renderCatCard();
 if (catSel) card.hidden = true;
 else if (sel && document.getElementById('windy').hidden){
  const e = mapScore(sel);
  card.hidden = false; card.dataset.open = sel.id;
  card.innerHTML = `${badge(e?.score)}<div style="flex:1;min-width:0"><p class="cond" style="font-weight:600;font-size:21px;line-height:1.1">${esc(sel.name)}</p>
   <p class="small muted">${e ? `${e.face.toFixed(1)}m, ${Math.round(e.T)}s da ${cardinal(e.dir)}, ${e.windType} ${Math.round(e.ws)}km/h` : 'Nessun dato'}</p></div>${ICON.chev}`;
 } else card.hidden = true;
 setTimeout(()=>leaf.invalidateSize(), 60);
}
document.getElementById('windyBtn').onclick = e=>{
 const on = e.currentTarget.getAttribute('aria-pressed') !== 'true', f = document.getElementById('windy');
 e.currentTarget.setAttribute('aria-pressed', on);
 e.currentTarget.textContent = on ? 'Spot' : 'Onde animate';
 if (on){
  let url = WINDY_URL;
  if (leaf){ const c = leaf.getCenter(), z = Math.max(3, Math.min(11, leaf.getZoom()));
   url = url.replace(/lat=[^&]*/, `lat=${c.lat.toFixed(3)}`).replace(/lon=[^&]*/, `lon=${c.lng.toFixed(3)}`)
    .replace(/detailLat=[^&]*/, `detailLat=${c.lat.toFixed(3)}`).replace(/detailLon=[^&]*/, `detailLon=${c.lng.toFixed(3)}`).replace(/zoom=[^&]*/, `zoom=${z}`); }
  if (f.src !== url) f.src = url;
 }
 f.hidden = !on; document.getElementById('leaf').hidden = on;
 renderMap();
};

// ---------- Alert ----------
function renderAlert(){
 const hits = upcomingAlerts();
const SV = (d, f='none') => `<svg width="20" height="20" viewBox="0 0 24 24" fill="${f}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
 const nFol = spots.filter(isFollowed).length, tgOn = !!(Cloud.ready && Cloud.user && Cloud.tg().linked);
 document.getElementById('alHero').innerHTML = `<ul>
  <li>${SV('<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 7c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>')}<span>${nFol} ${nFol === 1 ? 'spot che segui' : 'spot che segui'}</span></li>
  <li>${SV('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>')}<span>Soglia da ${threshold} / 5</span></li>
  <li>${SV('<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>')}<span>Telegram ${tgOn ? 'collegato' : 'non collegato'}</span></li></ul>
  <div class="albell${nFol ? '' : ' off'}"><svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true"><circle cx="52" cy="52" r="50" fill="none" stroke="#6B5330" stroke-width="1.5" stroke-dasharray="4 5"/></svg><div class="disc"><svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg></div><span class="dot"></span></div>`;
 document.getElementById('alertList').innerHTML = hits.length ? hits.slice(0,10).map(h=>{ const [bg,fg] = tone(h.d.best.score); return `
  <button data-open="${h.sp.id}" style="--c:${bg};--fg:${fg}"><span class="tile">${SV('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>').replace('width="20" height="20"','width="22" height="22"')}</span><span class="tx"><b>${esc(h.sp.name)}, ${dayLabel(h.d.day).toLowerCase()} ${+h.d.day.slice(8,10)}</b><span>Dalle ${h.d.firstHit}, fino a ${h.d.maxFace.toFixed(1)}m, vento ${h.d.best.windType}</span></span><span class="sc" aria-label="Punteggio ${h.d.best.score} su 5">${h.d.best.score}</span></button>`; }).join('')
  : `<p class="none">Nessuno spot seguito raggiunge ${threshold}/5 nei prossimi 7 giorni.</p>`;
 document.getElementById('seg').innerHTML = [2.5,3,3.5,4].map(v=>`<button aria-pressed="${v===threshold}" data-thr="${v}">${v}</button>`).join('');
 const ti = THR[threshold] || THR[3];
 document.getElementById('thrInfo').innerHTML = `<p class="tt">Da ${threshold}: ${ti.t}</p><p class="small" style="margin-top:4px">${ti.d}</p><p class="xs muted" style="margin-top:4px">${ti.f} Vale per le notifiche dell'app, per l'elenco "In arrivo" e per gli alert su Telegram.</p>${legendHtml()}`;
 document.getElementById('followList').innerHTML = spots.map(sp=>`
  <div class="srow"><span>${esc(sp.name)}</span>
  <button class="switch" aria-pressed="${isFollowed(sp)}" aria-label="Segui ${esc(sp.name)}" data-follow="${sp.id}"></button></div>`).join('');
 const ns = document.getElementById('notifState'), nb = document.getElementById('notifBtn');
 nb.textContent = 'Attiva';
 if (!('Notification' in window)){ ns.textContent = 'Non supportate: su iPhone aggiungi prima l\'app alla schermata Home.'; nb.hidden = true; }
 else if (Notification.permission === 'denied'){ ns.textContent = 'Bloccate nelle impostazioni del telefono: riabilitale da lì.'; nb.hidden = true; }
 else if (Cloud.ready && Cloud.user && Cloud.pushSupported()){
  if (Cloud.pushOn){ ns.textContent = 'Attive: arrivano nel blocca schermo e sull\'icona anche con l\'app chiusa.'; nb.textContent = 'Disattiva'; }
  else { ns.textContent = 'Attivale per riceverle nel blocca schermo e sull\'icona anche con l\'app chiusa.'; }
  nb.hidden = false;
 }
 else if (Notification.permission === 'granted'){ ns.textContent = 'Attive, arrivano quando apri l\'app. Entra con l\'account (nel Profilo) per riceverle anche ad app chiusa.'; nb.hidden = true; }
 else { ns.textContent = 'Arrivano quando apri l\'app. Entra con l\'account (nel Profilo) per riceverle anche ad app chiusa.'; nb.hidden = !Cloud.user; }
}
function notify(){
 if (!('Notification' in window) || Notification.permission !== 'granted') return;
 if (Cloud.pushOn) return;   // con le push attive l'avviso arriva già dal server
 const sent = store.get('surf.sent', {});
 upcomingAlerts().forEach(h=>{
  const key = `${h.sp.id}|${h.d.day}`;
  if ((sent[key] ?? -1) >= h.d.best.score) return;
  try{ new Notification(`${h.sp.name}: ${h.d.best.score}/5`, {body:`${dayLabel(h.d.day)} dalle ${h.d.firstHit}, fino a ${h.d.maxFace.toFixed(1)}m`}); }catch(e){}
  sent[key] = h.d.best.score;
 });
 store.set('surf.sent', sent);
}

// ---------- Nuovo spot ----------
const TYPES = [
 {id:'beach', t:'Spiaggia (beach break)', d:'Fondale di sabbia, lavora anche con onde piccole', min:0.5, max:2.5, window:50, minPeriod:6},
 {id:'reef', t:'Scogliera o punta (reef, point)', d:'Fondale di roccia, vuole onda più formata', min:0.8, max:3.5, window:40, minPeriod:7},
 {id:'big', t:'Solo con mareggiate', d:'Spot riparato, si attiva con mare grosso', min:1.2, max:4.5, window:35, minPeriod:8},
];
let add = {map:null, marker:null, arrow:null, osm:null, sat:null, pos:null, facing:null, type:'beach'};
const slug = t => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function offshorePoint(lat, lon, bearing, km){
 const b = bearing*Math.PI/180;
 return [+(lat + km*Math.cos(b)/111.32).toFixed(4), +(lon + km*Math.sin(b)/(111.32*Math.cos(lat*Math.PI/180))).toFixed(4)];
}

// rosa dei venti circolare a 16 direzioni: si trascina il dito sul cerchio
const CC = 150;
const cpt = (deg, r) => { const a = deg*Math.PI/180; return [+(CC+r*Math.sin(a)).toFixed(1), +(CC-r*Math.cos(a)).toFixed(1)]; };
function buildCompass(){
 const el = document.getElementById('compass');
 if (el.dataset.built) return;
 el.dataset.built = '1';
 let ticks = '', labels = '';
 DIR16.forEach((n,i)=>{
  const a = i*22.5, main = i%2 === 0;
  const [x1,y1] = cpt(a, main ? 117 : 122), [x2,y2] = cpt(a, 129);
  ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const [lx,ly] = cpt(a, 101);
  labels += `<text x="${lx}" y="${ly}" data-i="${i}" class="${main?'m':'s'}">${n}</text>`;
 });
 el.innerHTML = `<svg viewBox="0 0 300 300" role="slider" tabindex="0" aria-label="Direzione del mare aperto" aria-valuemin="0" aria-valuemax="337.5">
  <circle class="face" cx="150" cy="150" r="130"/>
  <path class="sec" id="cSec" d=""/>
  <g class="tk">${ticks}</g><g class="lb">${labels}</g>
  <line class="arm" id="cArm" x1="150" y1="150" x2="150" y2="150" visibility="hidden"/>
  <circle class="knob" id="cKnob" cx="150" cy="150" r="10" visibility="hidden"/>
  <circle class="hub" cx="150" cy="150" r="34"/>
  <text class="hub1" x="150" y="143">spiaggia</text>
  <text class="hub2" id="cVal" x="150" y="166">–</text>
 </svg>
 <p class="small muted out" id="cOut">Trascina il dito sul cerchio</p>`;
 const svg = el.querySelector('svg');
 let dragging = false;
 const pick = e => {
  const r = svg.getBoundingClientRect();
  const x = (e.clientX-r.left)/r.width*300-CC, y = (e.clientY-r.top)/r.height*300-CC;
  if (Math.hypot(x,y) < 34) return;
  let a = Math.atan2(x,-y)*180/Math.PI; if (a < 0) a += 360;
  setFacing(dirIndex(a)*22.5);
 };
 svg.addEventListener('pointerdown', e=>{ dragging = true; try{ svg.setPointerCapture(e.pointerId); }catch(_){} pick(e); });
 svg.addEventListener('pointermove', e=>{ if (dragging) pick(e); });
 svg.addEventListener('pointerup', ()=>{ dragging = false; });
 svg.addEventListener('pointercancel', ()=>{ dragging = false; });
 svg.addEventListener('keydown', e=>{
  const step = {ArrowRight:1, ArrowUp:1, ArrowLeft:-1, ArrowDown:-1}[e.key];
  if (!step) return;
  e.preventDefault();
  const cur = add.facing == null ? 270 : add.facing;
  setFacing(((cur + step*22.5) % 360 + 360) % 360);
 });
}
function setFacing(f){
 if (f === add.facing) return;
 add.facing = f;
 updateCompass(); drawArrow();
 if (navigator.vibrate) navigator.vibrate(8);
}
function updateCompass(){
 const svg = document.querySelector('#compass svg'); if (!svg) return;
 const f = add.facing, arm = document.getElementById('cArm'), knob = document.getElementById('cKnob');
 const sec = document.getElementById('cSec'), val = document.getElementById('cVal'), out = document.getElementById('cOut');
 const i = f == null ? -1 : dirIndex(f);
 svg.querySelectorAll('.lb text').forEach(t=>t.classList.toggle('on', +t.dataset.i === i));
 if (f == null){
  arm.setAttribute('visibility','hidden'); knob.setAttribute('visibility','hidden'); sec.setAttribute('d','');
  val.textContent = '–'; out.textContent = 'Trascina il dito sul cerchio';
  svg.setAttribute('aria-valuetext','Non scelta'); svg.removeAttribute('aria-valuenow');
  return;
 }
 const [x,y] = cpt(f, 82);
 arm.setAttribute('x2', x); arm.setAttribute('y2', y); arm.setAttribute('visibility','visible');
 knob.setAttribute('cx', x); knob.setAttribute('cy', y); knob.setAttribute('visibility','visible');
 const [ax,ay] = cpt(f-11.25,130), [bx,by] = cpt(f+11.25,130), [cx,cy] = cpt(f+11.25,34), [dx,dy] = cpt(f-11.25,34);
 sec.setAttribute('d', `M${ax},${ay} A130,130 0 0 1 ${bx},${by} L${cx},${cy} A34,34 0 0 0 ${dx},${dy} Z`);
 val.textContent = DIR16[i];
 out.textContent = `Il mare aperto è verso ${DIR16_LONG[i]} (${f}°)`;
 svg.setAttribute('aria-valuenow', f); svg.setAttribute('aria-valuetext', `${DIR16_LONG[i]}, ${f} gradi`);
}
function drawArrow(){
 if (!add.map) return;
 if (add.arrow){ add.map.removeLayer(add.arrow); add.arrow = null; }
 if (add.pos && add.facing != null){
  add.arrow = L.polyline([add.pos, offshorePoint(add.pos[0], add.pos[1], add.facing, 1.5)], {color:'#1D5F8A', weight:4, dashArray:'6 6'}).addTo(add.map);
 }
}
function drawAdd(){
 buildCompass(); updateCompass();
 document.getElementById('kinds').innerHTML = KINDS.map(k =>
  `<button type="button" aria-pressed="${add.kind===k.id}" data-kind="${k.id}">${k.icon}${k.t}<span>${k.d}</span></button>`).join('');
 document.getElementById('accessOpts').innerHTML = ACCESS.map(a =>
  `<button type="button" aria-pressed="${(add.access || 'unknown')===a.id}" data-access="${a.id}">${a.icon}${a.t}<span>${a.d}</span></button>`).join('');
 document.getElementById('addBig').setAttribute('aria-pressed', !!add.big);
 drawArrow();
}
// zona dello spot: la propongo dal punto sulla mappa (OpenStreetMap), finché l'utente non la scrive lui
let geoTimer = null;
function guessArea(lat, lon){
 clearTimeout(geoTimer);
 geoTimer = setTimeout(async ()=>{
  if (!add.areaAuto) return;
  try{
   const r = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=it`, {}, 1, 8000);
   const a = r.address || {};
   const place = a.town || a.village || a.city || a.municipality || a.hamlet;
   const region = a.island || a.archipelago || a.county || a.state || a.country;
   const txt = [...new Set([place, region].filter(Boolean))].join(', ');
   if (txt && add.areaAuto) document.getElementById('addArea').value = txt;
  }catch(e){}
 }, 700);
}
// da quali parametri era partito uno spot salvato prima che esistessero fondale e mareggiate
const typeOf = s => s.min >= 1.2 ? 'big' : s.min >= 0.8 ? 'reef' : 'beach';
function setPos(lat, lon, zoom){
 add.pos = [lat, lon];
 if (add.marker) add.marker.setLatLng(add.pos);
 else add.marker = L.circleMarker(add.pos, {radius:9, color:'#fff', weight:3, fillColor:'#1D5F8A', fillOpacity:1}).addTo(add.map);
 if (zoom) add.map.setView(add.pos, zoom);
 drawArrow();
 if (add.areaAuto) guessArea(lat, lon);
}
function openAdd(edit){
 const e = edit && edit.id ? (Data.spots.all().find(x => x.id === edit.id) || edit) : null;
 add = {...add, editId: e ? e.id : null, pos: e ? [e.beachLat ?? e.lat, e.beachLon ?? e.lon] : null, facing: e ? e.facing : null,
  kind: e ? (e.kind || (typeOf(e) === 'beach' ? 'beach' : 'reef')) : 'beach', big: e ? (e.bigOnly ?? typeOf(e) === 'big') : false,
  access: e ? (e.access || null) : null, areaAuto: !e};
 document.getElementById('addName').value = e ? e.name : '';
 document.getElementById('addArea').value = e && e.area && e.area !== 'Spot personale' ? e.area : '';
 document.getElementById('addTitle').textContent = e ? 'Modifica spot' : 'Nuovo spot';
 document.getElementById('addSave').textContent = e ? 'Salva le modifiche' : 'Salva spot';
 document.getElementById('addErr').hidden = true;
 showView('add');
 if (!window.L){ document.getElementById('pickMap').innerHTML = '<p class="muted" style="padding:14px">Mappa non disponibile: controlla la connessione e riapri.</p>'; drawAdd(); return; }
 if (!add.map){
  add.map = L.map('pickMap').setView(SINIS, 11);
  add.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:18, attribution:'&copy; OpenStreetMap'}).addTo(add.map);
  add.sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:18, attribution:'Esri, Maxar'});
  add.map.on('click', e => setPos(+e.latlng.lat.toFixed(5), +e.latlng.lng.toFixed(5)));
 } else if (add.marker){ add.map.removeLayer(add.marker); add.marker = null; }
 const start = add.pos; add.pos = null;
 if (start) setPos(start[0], start[1], 15); else add.map.setView(SINIS, 11);
 setTimeout(()=>add.map.invalidateSize(), 60);
 drawAdd();
}
document.getElementById('addOpen').onclick = ()=>openAdd();
document.getElementById('addBack').onclick = ()=> add.editId ? openDetail(add.editId) : setTab('spot');
document.getElementById('addArea').addEventListener('input', e=>{ add.areaAuto = !e.target.value.trim(); });
document.getElementById('addBig').onclick = ()=>{ add.big = !add.big; drawAdd(); };
document.getElementById('addHere').onclick = ()=>{
 navigator.geolocation?.getCurrentPosition(p=>setPos(+p.coords.latitude.toFixed(5), +p.coords.longitude.toFixed(5), 15),
  ()=>{ const e = document.getElementById('addErr'); e.hidden = false; e.textContent = 'Posizione non concessa: tocca il punto sulla mappa.'; });
};
document.getElementById('addSat').onclick = e=>{
 if (!add.map) return;
 const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
 e.currentTarget.setAttribute('aria-pressed', on);
 e.currentTarget.textContent = on ? 'Mappa' : 'Satellite';
 if (on){ add.map.removeLayer(add.osm); add.sat.addTo(add.map); } else { add.map.removeLayer(add.sat); add.osm.addTo(add.map); }
};
document.getElementById('v-add').addEventListener('click', e=>{
 const k = e.target.closest('[data-kind]'); if (k){ add.kind = k.dataset.kind; drawAdd(); return; }
 const a = e.target.closest('[data-access]'); if (a){ add.access = a.dataset.access === 'unknown' ? null : a.dataset.access; drawAdd(); }
});
document.getElementById('addSave').onclick = ()=>{
 const err = document.getElementById('addErr'), name = document.getElementById('addName').value.trim();
 const miss = !add.pos ? 'Tocca la mappa per indicare lo spot.' : add.facing == null ? 'Scegli sul cerchio da che parte è il mare aperto.' : !name ? 'Dai un nome allo spot.' : '';
 if (miss){ err.hidden = false; err.textContent = miss; return; }
 const typeId = add.big ? 'big' : add.kind === 'beach' ? 'beach' : 'reef';
 const t = TYPES.find(x=>x.id===typeId), [lat, lon] = offshorePoint(add.pos[0], add.pos[1], add.facing, 1.5);
 const old = add.editId ? Data.spots.all().find(x => x.id === add.editId) : null;
 // in modifica tengo range e finestra già tarati, a meno che cambi il tipo di spot
 const keep = old && typeOf(old) === typeId;
 const area = document.getElementById('addArea').value.trim();
 const sp = {...(old || {}), id: old ? old.id : 'c-'+Date.now(), name, area: area || 'Spot personale', lat, lon, beachLat:add.pos[0], beachLon:add.pos[1],
  facing:add.facing, offshore:(add.facing+180)%360,
  window: keep ? old.window : t.window, min: keep ? old.min : t.min, max: keep ? old.max : t.max, minPeriod: keep ? old.minPeriod : t.minPeriod,
  kind:add.kind, bigOnly:!!add.big, access:add.access, alert: old ? old.alert : true};
 Data.spots.save(sp); toast(old ? 'Modifiche salvate' : 'Spot salvato');
 if (old){
  spots = spots.map(x => x.id === sp.id ? sp : x); delete data[sp.id];
  if (leafPins[sp.id] && myLayer){ myLayer.removeLayer(leafPins[sp.id]); delete leafPins[sp.id]; }
 } else spots.push(sp);
 applyGains(); setTab('spot'); refresh().then(()=>openDetail(sp.id));
};

// ---------- Navigazione ----------
function showView(v){
 ['spot','detail','add','map','alert','me'].forEach(x=>document.getElementById('v-'+x).hidden = x!==v);
 window.scrollTo(0,0);
}
function setTab(t){
 lastTab = t;
 document.querySelectorAll('nav.tabs button').forEach(b=> b.dataset.tab===t ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current'));
 showView(t); renderAll();
}
function renderAll(){
 if (lastTab==='me') renderProfile();
 if (!Object.keys(data).length) return;
 if (lastTab==='spot') renderSpot();
 if (lastTab==='map') renderMap();
 if (lastTab==='alert') renderAlert();
}
function showStatus(msg, retry=true){
 const st = document.getElementById('status');
 st.hidden = false;
 st.innerHTML = `<p>${esc(msg)}</p>${retry ? '<button class="pillbtn" id="retryBtn">Riprova</button>' : ''}`;
 if (retry) document.getElementById('retryBtn').onclick = ()=>refresh();
}
const hhmm = d => new Date(d).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
let busy = false;
async function refresh(){
 if (busy) return; busy = true;
 const up = document.getElementById('updated'), st = document.getElementById('status');
 up.textContent = 'Scarico le previsioni…'; st.hidden = true;
 try{
  if (!baseSpots.length || !spotsFresh) await loadSpots();
  data = await fetchForecast();
  store.set('surf.cache', {at: Date.now(), data});
  await loadBuoys();
  await applyBuoyFix();
  up.textContent = 'Sinis, aggiornato alle ' + hhmm(Date.now()) + (buoyFix?.applied ? `, corretto con la ${buoyFix.name.replace(/^Boa /,'boa ')}` : '');
  renderAll(); notify();
 }catch(e){
  const c = store.get('surf.cache', null);
  if (c && c.data && spots.length && spots.every(sp=>c.data[sp.id])){
   data = c.data;
   up.textContent = `Previsioni salvate delle ${hhmm(c.at)}`;
   renderAll();
   showStatus(`Aggiornamento non riuscito: ${e.message}.`);
  } else {
   up.textContent = 'Previsioni non disponibili';
   showStatus(`Download non riuscito: ${e.message}. Controlla la connessione.`);
  }
 }finally{ busy = false; }
}
// errori imprevisti: li registro nella console senza allarmare. Il riquadro rosso resta per i problemi
// che contano davvero (previsioni non scaricate), gestiti in refresh().
window.addEventListener('error', e=>{ console.warn('Errore intercettato:', e.message, e.filename, e.lineno); });
window.addEventListener('unhandledrejection', e=>{ console.warn('Promessa non gestita:', e.reason); });
document.addEventListener('visibilitychange', ()=>{
 if (!document.hidden && Cloud.user && Cloud.tg().link) Cloud.loadTelegram().catch(()=>{});
 const c = store.get('surf.cache', null);
 if (!document.hidden && (!c || Date.now() - c.at > 60*60*1000)) refresh();
});

document.addEventListener('click', e=>{
 const ot = e.target.closest('#offToggle'); if (ot){ const on = ot.getAttribute('aria-expanded') !== 'true'; ot.setAttribute('aria-expanded', on); document.getElementById('offList').hidden = !on; return; }
 const o = e.target.closest('[data-open]'); if (o){ openDetail(o.dataset.open); return; }
 const t = e.target.closest('[data-tab]'); if (t){ setTab(t.dataset.tab); return; }
 const th = e.target.closest('[data-thr]'); if (th){ threshold = +th.dataset.thr; store.set('surf.thresholdDirty', true); store.set('surf.threshold', threshold); renderAlert(); return; }
 const kmb = e.target.closest('[data-km]'); if (kmb){ store.set('surf.nearKm', +kmb.dataset.km); renderSpot(); loadOsm(); return; }
 const oa = e.target.closest('[data-osmadd]'); if (oa){ const o = osm.list[+oa.dataset.osmadd]; if (o) addFromOsm(o); return; }
 if (e.target.closest('[data-osmretry]')){ osm.key = null; loadOsm(); return; }
 const dy = e.target.closest('[data-day]'); if (dy){ mapDay = dy.dataset.day; renderMap(); return; }
 const gt = e.target.closest('[data-goto]'); if (gt){ setTab(gt.dataset.goto); return; }
 const f = e.target.closest('[data-follow]'); if (f){ toggleFollow(f.dataset.follow); renderAlert(); }
});
document.getElementById('bkBtn').onclick = async ()=>{
 const txt = JSON.stringify(Data.exportAll()), st = document.getElementById('bkState');
 try{ if (navigator.share && /iPhone|iPad|Android/.test(navigator.userAgent)) await navigator.share({title:'Backup Sinis Waves', text:txt}); else await navigator.clipboard.writeText(txt);
  st.textContent = `Backup pronto (${Data.sessions.all().length} sessioni, ${Data.spots.all().length} spot personali). Salvalo nelle Note o mandalo a te stesso.`;
  toast('Backup copiato'); }
 catch(e){ st.textContent = 'Copia non riuscita: riprova.'; toast('Copia non riuscita', 'err'); }
};
document.getElementById('notifBtn').onclick = async ()=>{
 const err = document.getElementById('notifState');
 try{
  if (Cloud.user && Cloud.pushSupported()){ if (Cloud.pushOn) await Cloud.pushDisable(); else { await Cloud.pushEnable(); toast('Notifiche attivate'); } }
  else await Notification.requestPermission();
 }catch(e){ err.textContent = 'Non riuscito: ' + e.message; return; }
 renderAlert(); notify();
};
document.getElementById('nearBtn').onclick = e=>{
 const btn = e.currentTarget, st = document.getElementById('status');
 if (userPos){ userPos = null; btn.setAttribute('aria-pressed','false'); renderSpot(); return; }
 if (!navigator.geolocation){ st.hidden = false; st.textContent = 'Questo browser non fornisce la posizione.'; return; }
 navigator.geolocation.getCurrentPosition(p=>{ userPos = {lat:p.coords.latitude, lon:p.coords.longitude}; btn.setAttribute('aria-pressed','true'); st.hidden = true; renderSpot(); loadOsm(); },
  ()=>showStatus('Posizione non disponibile: controlla che Safari possa usare la posizione.', false), {enableHighAccuracy:false, timeout:15000, maximumAge:300000});
};

// niente zoom della pagina: blocca il pizzico (tranne sulle mappe, che hanno il loro zoom) e il doppio tocco
document.addEventListener('gesturestart', e => { if (!e.target.closest || !e.target.closest('.leaflet-container')) e.preventDefault(); });
document.addEventListener('touchmove', e => { if (e.touches.length > 1 && !e.target.closest('.leaflet-container')) e.preventDefault(); }, {passive:false});

// ---------- Tira per aggiornare ----------
// Nel browser lo fa già il telefono. Con l'app sulla schermata Home (iPhone e Android) non c'è, quindi lo faccio io.
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
async function pullRefresh(){
 // meteo, marea, boa e accordo tra i modelli hanno una memoria di un'ora: chi tira vuole dati freschi
 [extraCache, agreeCache, buoyModelCache].forEach(o => Object.keys(o).forEach(k => delete o[k]));
 const inDetail = !document.getElementById('v-detail').hidden && curDetail && spots.some(s => s.id === curDetail);
 const openKeys = inDetail ? [...document.querySelectorAll('#v-detail .dsec.open')].map(s => s.id.replace('sec-', '')) : [];
 const jobs = [refresh()];
 if (Cloud.user) jobs.push(Cloud.sync());
 await Promise.all(jobs.map(j => Promise.resolve(j).catch(() => {})));
 if (inDetail){ openDetail(curDetail); openKeys.forEach(k => openSection(k, true)); }   // riapro la pagina con gli stessi riquadri aperti
 if (lastTab === 'me') renderProfile();
 const bad = !document.getElementById('status').hidden;
 toast(bad ? 'Aggiornamento non riuscito' : 'Aggiornato alle ' + hhmm(Date.now()), bad ? 'err' : 'ok');
}
function setupPullToRefresh(){
 document.documentElement.classList.add('standalone');
 const el = document.createElement('div');
 el.className = 'ptr'; el.setAttribute('aria-hidden', 'true');
 el.innerHTML = '<span class="ptr-i"><svg class="ptr-a" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg><i class="spin ptr-s"></i></span>';
 document.body.appendChild(el);
 const arrow = el.querySelector('.ptr-i'), TH = 64, MAX = 96;
 let sy = 0, sx = 0, tracking = false, active = false, loading = false, ready = false;
 const top = () => (document.scrollingElement || document.documentElement).scrollTop;
 const show = (p, animate) => {
  el.style.transition = animate ? 'transform .22s ease, opacity .22s ease' : 'none';
  el.style.transform = `translate(-50%, ${p - 56}px)`; el.style.opacity = Math.min(1, p / 34);
  arrow.style.transform = `rotate(${Math.min(1, p / TH) * 180}deg)`;
 };
 // dove il gesto è di qualcun altro: mappa, liste da riordinare, scorrimenti orizzontali, finestre, modulo nuovo spot
 const blocked = t => {
  const n = t && t.nodeType === 1 ? t : t && t.parentElement;
  return document.body.classList.contains('locked') || document.body.classList.contains('sorting') || !document.getElementById('v-add').hidden
   || !!(n && n.closest && n.closest('.mapwrap, .leaflet-container, .bsl, .grip, .hours, .chips, .kmchips, .compass, input, textarea, select'));
 };
 document.addEventListener('touchstart', e => {
  tracking = false; active = false;
  if (loading || e.touches.length !== 1 || top() > 0 || blocked(e.target)) return;
  tracking = true; sy = e.touches[0].clientY; sx = e.touches[0].clientX;
 }, {passive:true});
 document.addEventListener('touchmove', e => {
  if (!tracking) return;
  const dy = e.touches[0].clientY - sy, dx = e.touches[0].clientX - sx;
  if (!active){
   if (dy < -6 || (Math.abs(dx) > 10 && Math.abs(dx) > dy) || top() > 0){ tracking = false; return; }   // sta scorrendo, non tirando
   if (dy < 10) return;
   active = true;
  }
  if (top() > 0){ active = false; tracking = false; show(0, true); return; }
  if (e.cancelable) e.preventDefault();          // niente rimbalzo del sistema mentre tiro
  const p = Math.min(MAX, dy * .5), was = ready;
  ready = p >= TH; el.classList.toggle('ready', ready); show(p, false);
  if (ready && !was && navigator.vibrate) navigator.vibrate(8);
 }, {passive:false});
 const end = async () => {
  if (!active){ tracking = false; return; }
  const go = ready; active = false; tracking = false; ready = false;
  if (!go){ el.classList.remove('ready'); show(0, true); return; }
  loading = true; el.classList.remove('ready'); el.classList.add('loading'); show(TH * .9, true);
  const t0 = Date.now();
  try{ await pullRefresh(); }catch(e){ toast('Aggiornamento non riuscito', 'err'); }
  await new Promise(r => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))));   // così il cerchio non lampeggia
  loading = false; el.classList.remove('loading'); show(0, true);
 };
 document.addEventListener('touchend', end, {passive:true});
 document.addEventListener('touchcancel', end, {passive:true});
}
if (STANDALONE) setupPullToRefresh();

if ('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });   // installazione su Android e notifiche push
document.addEventListener('touchstart', () => {}, {passive:true});   // su iOS serve perché :active dia feedback al tocco
setInterval(refresh, 3*60*60*1000);
// se il database locale del telefono non risponde (succede a volte su iPhone) l'app parte lo stesso dopo 4 secondi
Promise.race([Data.init().catch(e => console.warn('Database locale non disponibile', e)), new Promise(ok => setTimeout(ok, 4000))]).then(() => {
 // rileggo le impostazioni dal database (possono essere più aggiornate della copia di riserva)
 threshold = store.get('surf.threshold', 3); followed = store.get('surf.followed', null); favorite = store.get('surf.favorite', null);
 document.getElementById('catBtn')?.setAttribute('aria-pressed', store.get('surf.showCat', true));
 // Home subito: se ho previsioni salvate di meno di 24 ore e l'elenco spot, le mostro all'istante
 // e scarico quelle nuove poco dopo, senza far aspettare
 let seeded = false;
 try{
  const c = store.get('surf.cache', null), base = store.get('surf.baseSpots', null) || store.get('surf.officialSpots', null);
  if (c && c.data && Array.isArray(base) && base.length && Date.now() - c.at < 24*60*60*1000){
   const ids = new Set(base.map(s => s.id));
   const mine = Data.spots.all().filter(s => !ids.has(s.id));
   const all = [...base, ...mine];
   if (all.every(sp => c.data[sp.id])){
    baseSpots = base; spots = all; data = c.data; applyGains();
    document.getElementById('updated').textContent = `Previsioni salvate delle ${hhmm(c.at)}`;
    renderAll(); seeded = true;
    if (Date.now() - c.at > 10*60*1000) setTimeout(() => refresh(), 2500);
   }
  }
 }catch(e){ console.warn('Partenza dalla copia salvata non riuscita', e); baseSpots = []; spots = []; data = {}; }
 if (!seeded) refresh();
 Cloud.init();
});
