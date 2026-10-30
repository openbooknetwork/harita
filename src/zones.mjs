// harita zones: the zones of different stories that look like one region, so one shared zone can replace them.
// A copy is found by a hash of the drawing, a near copy by the share of land the two zones cover together.
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import * as turf from '@turf/turf';
import { check, Zone, SharedZone, Story, Apart, liftStory } from './schema.mjs';
import { world } from './world.mjs';
import { libraryItems, storyFolders, isZone } from './folders.mjs';
import { catalogueText, flatten } from '@openbooknetwork/kitap';
import { hash as sha, idOf, boxesMeet } from './util.mjs';

const REPORT = 0.9, SAME = 0.98; // the overlap a pair is reported at, and the one that makes it the same land
// part of each land cut's cache key: this file, world.mjs and the versions of the libraries the cut comes from
const require = createRequire(import.meta.url);
// the zones report is a local file, so it loads the MapLibre harita installed, without the .js or .css
const MAPLIBRE = pathToFileURL(require.resolve('maplibre-gl')).href.replace(/\.js$/, '');
const LAND_CODE = sha([fileURLToPath(import.meta.url), fileURLToPath(new URL('./world.mjs', import.meta.url))].map(f => fs.readFileSync(f, 'utf8'))
  .concat(['@turf/turf', 'world-atlas'].map(m => require(`${m}/package.json`).version)));
const english = v => typeof v === 'object' && v !== null ? v.en ?? Object.values(v)[0] : v;

const readJson = (root, file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${path.relative(root, file)}: ${e.message}`); } };

// Every zone the build reads: each story's in shared/zones/ and in its pages' zones/, and the shared ones. place is
// the folder that holds the zones/ folder, where a zones.yaml beside it belongs. With onProblem, a file that does not
// read goes to it and is left out, else it throws.
function zoneIndex({ root = process.cwd(), onProblem = null } = {}) {
  const content = path.join(root, 'content'), index = [];
  const add = (story, id, file, schema, place) => {
    try {
      const feat = check(schema, readJson(root, file), path.relative(root, file));
      index.push({ story, id, file, place, family: feat.properties.family, name: english(feat.properties.name), clip: feat.properties.clip ?? null, geometry: feat.geometry });
    } catch (err) { if (!onProblem) throw err; onProblem(err.message); }
  };
  for (const [id, dir] of libraryItems(path.join(content, 'shared', 'zones'), isZone, p => path.relative(root, p))) add(null, id, path.join(dir, 'zone.geojson'), SharedZone, null);
  for (const [story, storyDir] of storyFolders(content, p => path.relative(root, p))) {
    for (const f of fs.readdirSync(storyDir, { recursive: true }).sort()) {
      const parts = f.split(path.sep), at = parts.indexOf('zones');
      if (!f.endsWith('.geojson') || at < 0 || parts.some(p => p.startsWith('.'))) continue;
      // a zones/ folder in shared/ or in a page folder, in subfolders that order its files too
      const place = path.join(storyDir, ...parts.slice(0, at));
      if (place !== path.join(storyDir, 'shared') && !fs.existsSync(path.join(place, 'page.yaml'))) continue;
      const file = path.join(storyDir, f);
      let id;
      try { id = readJson(root, file).properties?.id ?? idOf(path.basename(f, '.geojson')); } catch (err) { if (!onProblem) throw err; onProblem(err.message); continue; }
      add(story, id, file, Zone, place);
    }
  }
  return index;
}

// The same hash for the same drawing: coordinates to about 10 m without repeated points, a hole that collapses at
// that size dropped, the outer ring counterclockwise and the holes clockwise, each starting at its lowest point. A
// MultiPolygon is its polygons in a fixed order, so the same parts listed in another order are the same drawing.
function fingerprint(geometry) {
  const round = ([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];
  const twice = r => r.reduce((sum, p, i) => { const q = r[(i + 1) % r.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
  const polygon = coordinates => {
    const rings = coordinates.map((ring, k) => {
      let open = [];
      for (const c of ring.map(round)) if (!open.length || open.at(-1)[0] !== c[0] || open.at(-1)[1] !== c[1]) open.push(c);
      if (open.length > 1 && open[0][0] === open.at(-1)[0] && open[0][1] === open.at(-1)[1]) open.pop();
      if (open.length < 3) return null;
      if (k === 0 ? twice(open) < 0 : twice(open) > 0) open.reverse();
      const low = open.reduce((best, p, i) => p[0] < open[best][0] || p[0] === open[best][0] && p[1] < open[best][1] ? i : best, 0);
      return [...open.slice(low), ...open.slice(0, low)];
    });
    return [rings[0], ...rings.slice(1).filter(Boolean).map(r => JSON.stringify(r)).sort()];
  };
  if (geometry.type === 'Polygon') return sha(polygon(geometry.coordinates));
  return sha(geometry.coordinates.map(polygon).filter(p => p[0]).map(p => JSON.stringify(p)).sort());
}

// The land a zone covers: the zone cut to its clip countries, else to every country near it. Coasts then match, and
// only borders drawn across land tell two zones apart.
let countryBoxes = null;
function landOf(zone) {
  countryBoxes ??= world('50m').filter(f => f.geometry).map(f => ({ f, box: turf.bbox(f) }));
  const feat = turf.feature(zone.geometry), box = turf.bbox(feat), [w, s, e, n] = box;
  const polys = [];
  for (const c of countryBoxes) {
    if (zone.clip ? !zone.clip.includes(c.f.properties.name) : !boxesMeet(c.box, box)) continue;
    const g = turf.bboxClip(c.f, [w - 0.1, s - 0.1, e + 0.1, n + 0.1]).geometry;
    const parts = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).filter(p => p[0]?.length >= 4).map(p => p.filter(r => r.length >= 4));
    if (!parts.length) continue;
    const cut = turf.intersect(turf.featureCollection([feat, turf.multiPolygon(parts)]));
    if (cut) polys.push(...(cut.geometry.type === 'Polygon' ? [cut.geometry.coordinates] : cut.geometry.coordinates));
  }
  // countries do not overlap, so their pieces together are the land without a union, at about 500 m of detail
  const land = polys.length ? turf.simplify(turf.multiPolygon(polys), { tolerance: 0.005 }) : null;
  return land ? { land: land.geometry, area: turf.area(land) / 1e6, box: turf.bbox(land) } : null;
}

// The cache of land cuts, keyed by the drawing, its clip and this code, and of overlaps, keyed by two land cuts. A run
// measures only what changed and keeps what it used, a partial run such as --like everything else too.
function openCache(dir, { partial = false } = {}) {
  const file = dir && path.join(dir, 'zone-compare.json');
  let saved = { land: {}, overlap: {} };
  try { if (file) saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = { land: {}, overlap: {} }; }
  const used = { land: {}, overlap: {} };
  let changed = false;
  const get = (table, key, make) => {
    if (!(key in used[table])) { used[table][key] = key in saved[table] ? saved[table][key] : (changed = true, make()); }
    return used[table][key];
  };
  const save = () => {
    if (!file || !changed && Object.keys(saved.land).length === Object.keys(used.land).length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(partial ? { land: { ...saved.land, ...used.land }, overlap: { ...saved.overlap, ...used.overlap } } : used)); fs.renameSync(tmp, file);
  };
  return { get, save };
}

// Each zone with its land cut and the key of that cut.
function withLand(index, store) {
  return index.map(z => {
    const landKey = sha({ g: z.geometry, clip: z.clip, v: LAND_CODE });
    return { ...z, landKey, fingerprint: fingerprint(z.geometry), ...(store.get('land', landKey, () => landOf(z)) ?? { land: null, area: 0, box: null }) };
  });
}

// The widest gap between the two borders: from each point of one drawing that lies on land, the distance to the other
// drawing's outline, in km. A point at sea draws no border, so it does not count.
function widestGap(a, b) {
  let best = { km: 0, at: null, to: null };
  const outlines = g => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => turf.lineString(p[0]));
  for (const [from, other] of [[a, b], [b, a]]) {
    const lines = outlines(other.geometry), land = turf.feature(from.land);
    for (const pt of outlines(from.geometry).flatMap(l => l.geometry.coordinates.slice(0, -1))) {
      if (!turf.booleanPointInPolygon(pt, land)) continue;
      const [km, line] = lines.map(l => [turf.pointToLineDistance(pt, l, { units: 'kilometers' }), l]).reduce((m, x) => x[0] < m[0] ? x : m);
      if (km > best.km) best = { km, at: pt, to: turf.nearestPointOnLine(line, pt).geometry.coordinates };
    }
  }
  return { km: Math.round(best.km), at: best.at, to: best.to };
}

// The pairs of zones that look like one region, the closest first. sameStory adds pairs within one story, whose
// dated shapes of one family overlap on purpose. against limits the pairs to those with one of these zones.
function comparePairs(zones, { sameStory = false, against = null, store = openCache(null) } = {}) {
  const pairs = [], seen = new Set(), key = (a, b) => `${a.file}\n${b.file}`;
  const report = (a, b, overlap, exact) => {
    if (seen.has(key(a, b)) || seen.has(key(b, a))) return;
    seen.add(key(a, b));
    pairs.push({ a, b, overlap, exact, gap: exact ? { km: 0, at: null, to: null } : widestGap(a, b) });
  };
  const wanted = (a, b) => a !== b && (sameStory || a.story === null || a.story !== b.story) && (!against || against.includes(a) || against.includes(b));
  // copies: one map read each
  const byPrint = new Map();
  for (const z of zones) byPrint.set(z.fingerprint, [...(byPrint.get(z.fingerprint) ?? []), z]);
  for (const group of byPrint.values()) for (const a of group) for (const b of group) if (wanted(a, b)) report(a, b, 1, true);
  // near copies: the zones whose land boxes meet, then the overlap ratio, which cannot pass smaller area / larger area
  const tree = turf.geojsonRbush();
  const withLandOnly = zones.filter(z => z.land);
  tree.load(turf.featureCollection(withLandOnly.map((z, i) => turf.bboxPolygon(z.box, { properties: { i } }))));
  for (const a of against ?? withLandOnly) {
    if (!a.land) continue;
    for (const hit of tree.search(turf.bboxPolygon(a.box)).features) {
      const b = withLandOnly[hit.properties.i];
      // each pair once, from its first zone
      if (!against && hit.properties.i <= withLandOnly.indexOf(a)) continue;
      if (!wanted(a, b) || Math.min(a.area, b.area) / Math.max(a.area, b.area) < REPORT) continue;
      const overlap = store.get('overlap', [a.landKey, b.landKey].sort().join(' '), () => {
        const both = turf.intersect(turf.featureCollection([turf.feature(a.land), turf.feature(b.land)]));
        const shared = both ? turf.area(both) / 1e6 : 0;
        return shared / (a.area + b.area - shared);
      });
      if (overlap >= REPORT) report(a, b, overlap, false);
    }
  }
  return pairs.sort((x, y) => y.overlap - x.overlap);
}

const label = z => `${z.story ?? 'shared'}/${z.id}`;
export const describePair = p => `${label(p.a)} ~ ${label(p.b)}  ${p.redrawn ? 'redrawn since it was kept apart, ' : ''}${p.exact ? 'the same drawing' : `${Math.round(p.overlap * 100)}% overlap${p.overlap >= SAME ? ', the same land' : ''}${p.gap.km ? `, borders up to ${p.gap.km} km apart near ${p.gap.at.map(v => v.toFixed(2)).join(', ')}` : ''}`}, families ${p.a.family} / ${p.b.family}`;

// The review page: the pairs on the left, the two zones over the land on the right, the widest gap marked.
function reviewPage(pairs) {
  const countries = world('50m').filter(f => f.geometry);
  const data = pairs.map(p => {
    const box = turf.bbox(turf.featureCollection([turf.feature(p.a.geometry), turf.feature(p.b.geometry)]));
    const [w, s, e, n] = box, around = [w - 1, s - 1, e + 1, n + 1];
    // the countries around the pair, without the empty parts a clip leaves, which the map refuses
    const land = countries.filter(c => boxesMeet(turf.bbox(c), around)).map(c => {
      const g = turf.bboxClip(c, around).geometry, polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).filter(p => p[0]?.length >= 4).map(p => p.filter(r => r.length >= 4));
      return polys.length ? turf.multiPolygon(polys) : null;
    }).filter(Boolean);
    return { title: describePair(p), a: label(p.a), b: label(p.b), names: [p.a.name, p.b.name], overlap: p.overlap, exact: p.exact, gap: p.gap, box, why: p.why ?? null,
      drawn: [p.a.geometry, p.b.geometry], cut: [p.a.land, p.b.land], land: turf.featureCollection(land) };
  });
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zone pairs</title>
<link rel="stylesheet" href="${MAPLIBRE}.css">
<style>
:root{--paper:#f6f3ea;--ink:#222;--rule:#d8d2c2;--a:#c62828;--b:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--paper:#1c1c1a;--ink:#eee;--rule:#3a3a36}}
body{margin:0;display:grid;grid-template-columns:22rem 1fr;height:100vh;font:14px system-ui,sans-serif;background:var(--paper);color:var(--ink)}
nav{overflow:auto;border-right:1px solid var(--rule)}nav button{display:block;width:100%;text-align:left;padding:.6rem .8rem;border:0;border-bottom:1px solid var(--rule);background:none;color:inherit;font:inherit;cursor:pointer}
nav button[aria-current]{background:var(--rule)}nav small{display:block;opacity:.75}#map{height:100vh}
.bar{position:absolute;top:.6rem;right:.6rem;z-index:2;background:var(--paper);border:1px solid var(--rule);padding:.4rem .6rem;border-radius:4px}
.a{color:var(--a)}.b{color:var(--b)}
@media (max-width:700px){body{grid-template-columns:1fr;grid-template-rows:40vh 60vh}#map{height:60vh}}
</style></head><body>
<nav id="list"></nav><div id="map"></div>
<div class="bar"><span class="a" id="la"></span><br><span class="b" id="lb"></span><br><label><input type="checkbox" id="cut" checked> cut to land</label></div>
<script src="${MAPLIBRE}.js"></script>
<script>
const PAIRS = ${json};
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const map = new maplibregl.Map({ container: 'map', style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#b9d3e6' } }] } });
let cur = 0;
const fc = gs => ({ type: 'FeatureCollection', features: gs.map((g, i) => ({ type: 'Feature', properties: { i }, geometry: g })).filter(f => f.geometry) });
function show(i) {
  cur = i; const p = PAIRS[i], cut = document.getElementById('cut').checked;
  document.querySelectorAll('nav button').forEach((b, j) => j === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current'));
  document.getElementById('la').textContent = p.a + ': ' + p.names[0];
  document.getElementById('lb').textContent = p.b + ': ' + p.names[1];
  map.getSource('land').setData(p.land);
  map.getSource('zones').setData(fc(cut ? p.cut : p.drawn));
  map.getSource('drawn').setData(fc(p.drawn));
  map.getSource('gap').setData(p.gap.at ? { type: 'Feature', properties: { km: p.gap.km + ' km' }, geometry: { type: 'LineString', coordinates: [p.gap.at, p.gap.to] } } : fc([]));
  map.fitBounds([[p.box[0], p.box[1]], [p.box[2], p.box[3]]], { padding: 40, duration: 0 });
}
map.on('load', () => {
  for (const id of ['land', 'zones', 'drawn', 'gap']) map.addSource(id, { type: 'geojson', data: fc([]) });
  const color = ['match', ['get', 'i'], 0, css('--a'), css('--b')];
  map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#ece6d6', 'fill-outline-color': '#9a937f' } });
  map.addLayer({ id: 'zones', type: 'fill', source: 'zones', paint: { 'fill-color': color, 'fill-opacity': 0.35 } });
  map.addLayer({ id: 'drawn', type: 'line', source: 'drawn', paint: { 'line-color': color, 'line-width': 2 } });
  map.addLayer({ id: 'gap', type: 'line', source: 'gap', paint: { 'line-color': '#000', 'line-width': 2, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'gap-label', type: 'symbol', source: 'gap', layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'km'], 'text-size': 13 }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2 } });
  if (PAIRS.length) show(0);
});
const list = document.getElementById('list');
if (!PAIRS.length) list.textContent = 'No zones of different stories look like one region.';
PAIRS.forEach((p, i) => { const b = document.createElement('button'); b.innerHTML = '<b></b><small></small>'; b.querySelector('b').textContent = p.a + ' ~ ' + p.b;
  b.querySelector('small').textContent = (p.why ? 'kept apart: ' + p.why + '. ' : '') + (p.exact ? 'the same drawing' : Math.round(p.overlap * 100) + '% overlap' + (p.gap.km ? ', borders up to ' + p.gap.km + ' km apart' : '')); if (p.why) b.style.opacity = 0.6; b.onclick = () => show(i); list.appendChild(b); });
document.getElementById('cut').onchange = () => show(cur);
</script></body></html>
`;
}

// a catalogue without some keys: each key line, the source comment above it and one blank line after
function dropKeys(text, keys) {
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].match(/^([^#\s][^:]*):\s/)?.[1];
    if (key && keys.includes(key)) { if (out.length && out.at(-1).startsWith('# ')) out.pop(); if (lines[i + 1] === '') i++; continue; }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// One story zone becomes the shared zone content/shared/zones/<id>/ with its translated name. Each --replace zone keeps
// its id, name and family in a zones.yaml beside it and takes the shared outline. Every check runs before a write.
function share({ root, index, from, replace, log }) {
  const rel = p => path.relative(root, p);
  const find = ref => {
    const [story, id] = ref.split('/');
    if (story === 'shared') throw new Error(`${ref} is shared already: name it in place of the other zone, or give that one a zones.yaml entry { zone: ${id} }`);
    return index.find(z => z.story === story && z.id === id) ?? (() => { throw new Error(`no zone ${ref}, name it as <story>/<zone id>`); })();
  };
  const src = find(from), olds = [...new Set(replace.map(find))], dir = path.join(root, 'content', 'shared', 'zones', src.id);
  if (fs.existsSync(dir) || index.some(z => z.story === null && z.id === src.id)) throw new Error(`a shared zone is named ${src.id} already`);
  if (olds.includes(src)) throw new Error(`${from} cannot replace itself`);
  // a story with its own zone of this id would see the id twice once it is shared
  const clash = index.filter(z => z.story && z.story !== src.story && z.id === src.id && !olds.includes(z)).map(z => `${z.story}/${z.id}`);
  if (clash.length) throw new Error(`${clash.join(', ')} draw${clash.length === 1 ? 's' : ''} a zone of the id ${src.id} too: add each with --replace, or rename it first`);
  for (const o of olds) {
    const uses = path.join(o.place, 'zones.yaml');
    if (fs.existsSync(uses) && Object.hasOwn(yaml.load(fs.readFileSync(uses, 'utf8')) ?? {}, o.id)) throw new Error(`${rel(uses)} has an entry ${o.id} already`);
  }
  const dirs = storyFolders(path.join(root, 'content'), rel), storyFile = s => path.join(dirs.get(s), 'story.yaml'), storyOf = s => { const st = check(Story, liftStory(yaml.load(fs.readFileSync(storyFile(s), 'utf8'))), rel(storyFile(s))); return { ...st, ...st.harita }; };
  const meta = storyOf(src.story), def = meta.default_language ?? meta.languages[0];
  const feat = JSON.parse(fs.readFileSync(src.file, 'utf8')), { id: _, ...props } = feat.properties;
  // the story's catalogues, read before the first write so a broken one changes nothing
  const catalogues = s => { const d = path.join(dirs.get(s), 'i18n'); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.yaml')).map(f => path.join(d, f)) : []; };
  const cats = catalogues(src.story).map(cat => {
    const text = fs.readFileSync(cat, 'utf8');
    try { return { cat, text, values: flatten(yaml.load(text) ?? {}) }; } catch (err) { throw new Error(`${rel(cat)}: ${err.message}`); }
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'zone.geojson'), JSON.stringify({ ...feat, properties: { ...props, ...(def !== 'en' ? { default_language: def } : {}) } }) + '\n');
  fs.rmSync(src.file);
  // the zone's names in other languages move from the story's catalogues into the folder
  for (const { cat, text, values } of cats) {
    const lang = path.basename(cat, '.yaml'), value = values[`zones.${src.id}.name`];
    const entry = { key: 'zone.name', source: String(english(props.name)), shared: false, inline: null };
    fs.mkdirSync(path.join(dir, 'i18n'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'i18n', `${lang}.yaml`), catalogueText(lang, [entry], value ? { 'zone.name': value } : {}, `${lang} strings for the zone "${src.id}".`).text);
    fs.writeFileSync(cat, dropKeys(text, [`zones.${src.id}.name`]));
  }
  log(`moved ${rel(src.file)} to ${rel(path.join(dir, 'zone.geojson'))}`);
  for (const old of olds) {
    const uses = path.join(old.place, 'zones.yaml'), p = JSON.parse(fs.readFileSync(old.file, 'utf8')).properties;
    const entry = { zone: src.id, name: p.name, family: p.family, ...(p.clip ? { clip: p.clip } : {}) };
    const text = fs.existsSync(uses) ? fs.readFileSync(uses, 'utf8') : '# zones that take their outline from another zone, with their own name and family\n';
    fs.writeFileSync(uses, text.replace(/\n?$/, '\n') + yaml.dump({ [old.id]: entry }, { flowLevel: 1, lineWidth: -1 }));
    fs.rmSync(old.file);
    log(`${old.story}/${old.id} takes its outline from ${src.id}, in ${rel(uses)}`);
  }
}

// The pairs someone checked and kept apart, in content/shared/zones/apart.yaml.
const apartFile = root => path.join(root, 'content', 'shared', 'zones', 'apart.yaml');
const readApart = root => { const f = apartFile(root); return fs.existsSync(f) ? check(Apart, yaml.load(fs.readFileSync(f, 'utf8')) ?? [], path.relative(root, f)) : []; };
const pairKey = (x, y) => [x, y].sort().join(' ');

// harita zones --apart <zone> <zone> --why <text>: the pair goes on the list with both drawings as they are now, so a
// later drawing brings it back. A copy is not kept apart: one outline with two names is --share and zones.yaml.
function addApart({ root, index, pair: [x, y], why, log }) {
  if (!x || !y || !why) throw new Error('usage: harita zones --apart <story>/<zone id> <story>/<zone id> --why <text>');
  const find = ref => index.find(z => label(z) === ref) ?? (() => { throw new Error(`no zone ${ref}, name it as <story>/<zone id> or shared/<zone id>`); })();
  const [a, b] = [find(x), find(y)], drawings = [fingerprint(a.geometry), fingerprint(b.geometry)];
  if (drawings[0] === drawings[1]) throw new Error(`${x} and ${y} are the same drawing: harita zones --share ${x} --replace ${y} keeps one outline, and each story its own name and family`);
  const entries = [...readApart(root).filter(e => pairKey(...e.zones) !== pairKey(x, y)), { zones: [x, y], why, drawings }];
  const file = apartFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Zones of different stories that cover the same land and stay apart, checked by hand. A pair comes back\n'
    + '# when either zone is redrawn. harita zones --apart <zone> <zone> --why <text> adds one.\n' + yaml.dump(entries, { flowLevel: 2, lineWidth: -1 }));
  log(`kept ${x} and ${y} apart in ${path.relative(root, file)}`);
}

// The pairs on the list with both drawings as they were checked, the others, and the entries whose zones are gone.
// A listed pair redrawn since comes back, marked.
function sortApart(pairs, entries, index) {
  const byKey = new Map(entries.map(e => [pairKey(...e.zones), e])), kept = [], rest = [];
  for (const p of pairs) {
    const e = byKey.get(pairKey(label(p.a), label(p.b)));
    if (!e) { rest.push(p); continue; }
    const now = { [label(p.a)]: p.a.fingerprint, [label(p.b)]: p.b.fingerprint };
    if (e.zones.every((z, i) => now[z] === e.drawings[i]) && !p.exact) kept.push({ ...p, why: e.why }); else rest.push({ ...p, redrawn: true });
  }
  const labels = new Set(index.map(label));
  return { kept, rest, stale: entries.filter(e => !e.zones.every(z => labels.has(z))) };
}
const staleLine = e => `content/shared/zones/apart.yaml: ${e.zones.join(' ~ ')} names a zone that is gone, remove the entry`;

// harita zones [--like <file>] [--same-story] [--share <story>/<id> [--replace <story>/<id> ...]] [--apart <zone> <zone>
// --why <text>]: prints the pairs of zones that look like one region and writes .cache/harita/zones.html. Returns them.
export function zones({ root = process.cwd(), like = null, sameStory = false, share: from = null, replace = [], apart = null, why = null, cache = path.join(root, '.cache', 'kitap'), log = console.log } = {}) {
  const index = zoneIndex({ root });
  if (from) { share({ root, index, from, replace, log }); return []; }
  if (replace.length) throw new Error('--replace goes with --share <story>/<zone id>');
  if (apart) { addApart({ root, index, pair: apart, why, log }); return []; }
  const store = openCache(cache, { partial: !!like });
  let all = withLand(index, store), against = null;
  if (like) {
    const feat = check(Zone, JSON.parse(fs.readFileSync(like, 'utf8')), like);
    const [z] = withLand([{ story: '(new)', id: path.basename(like, '.geojson'), file: path.resolve(like), family: feat.properties.family, name: english(feat.properties.name), clip: feat.properties.clip ?? null, geometry: feat.geometry }], store);
    all = [...all, z]; against = [z];
  }
  const found = comparePairs(all, { sameStory, against, store });
  store.save();
  const { kept, rest, stale } = sortApart(found, readApart(root), index);
  for (const p of rest) log(describePair(p));
  for (const e of stale) log(staleLine(e));
  const page = path.join(cache, 'zones.html');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(page, reviewPage([...rest, ...kept]));
  log(`${rest.length ? `${rest.length} pair${rest.length === 1 ? '' : 's'}` : 'no pairs'}${kept.length ? `, ${kept.length} kept apart` : ''}, see ${path.relative(root, page)}`);
  return rest;
}

// For every build: the pairs that involve the stories built, without the pairs kept apart, the entries of apart.yaml
// whose zones are gone, and the zone files that do not read, which the build of their own story reports. The review
// page shows every pair.
export function zonePairs({ root, cache, stories }) {
  const unread = [], index = zoneIndex({ root, onProblem: msg => unread.push(msg) });
  const store = openCache(cache), found = comparePairs(withLand(index, store), { store });
  store.save();
  const { kept, rest, stale } = sortApart(found, readApart(root), index);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'zones.html'), reviewPage([...rest, ...kept]));
  return { pairs: rest.filter(p => !stories || stories.includes(p.a.story) || stories.includes(p.b.story)), stale: stale.map(staleLine), unread };
}
