// The map engine as kitap loads it: its fields of story.yaml and page.yaml under the harita key, its files under
// shared/ and in the page folders, the battles it includes, the map bundle the viewport receives, and the
// elevation tiles it keeps in the store. The hooks follow kitap's README.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as turf from '@turf/turf';
import * as tc from 'topojson-client';
import * as ts from 'topojson-server';
import polylabel from 'polylabel';
import { check, StoryMap, PageMap, Camera, Markers, Battle, Include, Zone, SharedZone, ZoneUses, Route, BattlePlan } from './schema.mjs';
import { alikePairs, describe } from './palette.mjs';
import { coverage, packZones } from './coverage.mjs';
import { terrainPlan, tileKeys, tileKey, cutTiles, openZoom } from './terrain.mjs';
import { isBattle, isZone } from './folders.mjs';
import { boxesMeet } from './util.mjs';
import { world } from './world.mjs';
import { zonePairs, describePair } from './zones.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const exists = p => fs.existsSync(p);
const listFiles = (p, ext) => exists(p) ? fs.readdirSync(p).filter(f => f.endsWith(ext)).sort() : [];
// the .geojson files of a zones/ folder, in its subfolders too, which only order them
const geojsonIn = p => exists(p) ? fs.readdirSync(p, { recursive: true }).filter(f => f.endsWith('.geojson') && !f.split(path.sep).some(x => x.startsWith('.'))).sort() : [];
const km2 = f => turf.area(f) / 1e6;
const intersect = (a, b) => turf.intersect(turf.featureCollection([a, b]));
const difference = (a, b) => turf.difference(turf.featureCollection([a, b]));
const idOf = name => name.replace(/^\d+-/, '');
const ID = /^[a-z0-9][a-z0-9-]*$/;
const LAND_SLOTS = 8;
// the code and libraries the cleaned zones come from, part of each story's zone cache key
const GEOMETRY_CODE = (() => { const crypto = require('crypto'); return crypto.createHash('sha256').update(['engine.mjs', 'coverage.mjs', 'world.mjs'].map(f => fs.readFileSync(path.join(PKG, 'src', f), 'utf8')).concat(['@turf/turf', 'world-atlas', 'topojson-server', 'topojson-client'].map(m => require(m + '/package.json').version)).join('\n')).digest('hex'); })();
// Marker icons come from Lucide; the names the first stories used before map onto it
const LEGACY_ICONS = { congress: 'users', scroll: 'scroll-text', building: 'landmark' };

// An emblem kind is plugins/emblems/<kind>.mjs in the content project, else src/emblems/<kind>.mjs here, so a story
// can replace a built-in kind. The file exports a function (params, { turf, families }) => GeoJSON FeatureCollection,
// drawn as a fill layer: a feature takes its "family" colour for the theme, else its "color". Features that share an
// "id" highlight together, and a "name" shows when the reader points at one. Node 22.12+ loads an ES module through
// require synchronously, which keeps the build synchronous.
const EMBLEM_DIR = path.join(PKG, 'src', 'emblems');
const BUILT_IN_EMBLEMS = { 'battle-plan': BattlePlan }; // each built-in kind with the schema of its parameters
// fam renames a family the plugin returns into the bundle's, which a battle's page needs.
function emblemFor(root, spec, where, { families, fam = f => f, T, pid, fail }) {
  const own = path.join(root, 'plugins', 'emblems', spec.kind + '.mjs'), builtIn = path.join(EMBLEM_DIR, spec.kind + '.mjs');
  const file = exists(own) ? own : exists(builtIn) ? builtIn
    : fail(where, `unknown emblem kind "${spec.kind}", add plugins/emblems/${spec.kind}.mjs or use one harita ships: ${Object.keys(BUILT_IN_EMBLEMS).join(', ')}`);
  const plugin = require(file).default;
  if (typeof plugin !== 'function') fail(where, `plugins/emblems/${spec.kind}.mjs must export a default function`);
  const params = file === builtIn && BUILT_IN_EMBLEMS[spec.kind] ? check(BUILT_IN_EMBLEMS[spec.kind], spec, where) : spec;
  let fc;
  try { fc = plugin(params, { turf, families }); } catch (err) { fail(where, err.message); }
  if (fc?.type !== 'FeatureCollection') fail(where, `emblem plugin "${spec.kind}" must return a FeatureCollection`);
  // one translated name per id, kept beside the geometry, since map features hold plain values only
  const names = {};
  for (const f of fc.features) {
    const p = f.properties ??= {};
    if (p.family && !families[p.family]) fail(where, `emblem feature uses unknown family "${p.family}"`);
    if (p.family) p.family = fam(p.family);
    if (p.name == null) continue;
    if (p.id == null) fail(where, `emblem feature named "${typeof p.name === 'string' ? p.name : Object.values(p.name)[0]}" needs an id`);
    names[p.id] ??= T(p.name, `emblems.${pid}.${p.id}`);
    delete p.name;
  }
  return { fc, names };
}

// Zones as drawn into the shapes the map shows: trimmed, rounded, clipped to land, checked for overlaps between
// families that share a page. Returns { id: Feature } and the lines it logged.
function cleanZones({ ordered, prio, together, smoothing, where, log, fail }) {
  const shapes = coverage({ zones: ordered, prio, together, smoothing, fail, where, intersect, difference });
  const lines = [], say = l => { lines.push(l); log(l); };
  const box = Object.fromEntries(ordered.map(z => [z.id, turf.bbox(shapes[z.id])]));
  for (const z of ordered) {
    for (const h of ordered) {
      if (h.family === z.family || h.id <= z.id || !together(z.id, h.id) || !boxesMeet(box[z.id], box[h.id])) continue;
      const o = intersect(shapes[z.id], shapes[h.id]);
      if (o && km2(o) > 1) fail(where, `zones "${z.id}" and "${h.id}" overlap by ${km2(o).toFixed(1)} km2`);
    }
    // pieces under 1 km2 are clip noise and go; small islands remain and are listed so a sliver stands out
    if (shapes[z.id].geometry.type === 'MultiPolygon') {
      const kept = shapes[z.id].geometry.coordinates.filter(c => km2(turf.polygon(c)) >= 1);
      shapes[z.id] = kept.length === 1 ? turf.polygon(kept[0]) : turf.multiPolygon(kept);
      const small = kept.map(c => km2(turf.polygon(c))).filter(a => a < 50).map(a => a.toFixed(0));
      if (small.length) say(`  zone ${z.id}: small pieces of ${small.join(', ')} km2, islands or slivers`);
    }
    say(`  zone ${z.id}: ${Math.round(km2(shapes[z.id])).toLocaleString('en')} km2`);
  }
  return { shapes, lines };
}

// --- reading a story: the map's tables, filled as kitap walks the story's folders and pages ---
function readStory(story, ctx) {
  const { fail, rel, storyFile, log, where, T, langs, content } = ctx;
  const M = story.harita;
  if (M.hillshade) log(`  ${where}/story.yaml: the relief comes from elevation tiles now, remove the hillshade line and geo/${M.hillshade}`);
  // a battle family takes the colours of the story family with its id, or with its id among the aliases
  const aliasOf = {};
  for (const [f, fam] of Object.entries(M.families)) for (const a of fam.aliases ?? []) {
    if (M.families[a]) fail(storyFile, `family "${f}" has the alias "${a}", which is the id of another family`);
    if (aliasOf[a]) fail(storyFile, `the alias "${a}" is on both "${aliasOf[a]}" and "${f}", keep it on one`);
    aliasOf[a] = f;
  }
  const E = { map: M, zones: {}, routes: {}, markers: {}, battles: {}, definedIn: {}, families: { ...M.families }, aliasOf, zoneFiles: new Set(), zoneUses: [], zoneFolders: {}, battleCtx: {}, includes: [], pages: [] };
  E.storyFamily = f => M.families[f] ? f : aliasOf[f] ?? null;
  const define = (table, id, value, file, kind, dir) => { if (table[id]) fail(file, `${kind} "${id}" is defined twice`); table[id] = value; E.definedIn[`${kind} ${id}`] = dir; };
  const battleLib = dir => ctx.library(dir, isBattle, ID, 'a battle folder is named in lowercase letters, digits and dashes, such as ankara-1402');
  const zoneLib = dir => ctx.library(dir, isZone, ID, 'a zone folder is named in lowercase letters, digits and dashes, such as ottoman-1402');
  // the story scope's map side: no battle, the story's families and ids as they are
  Object.assign(ctx.storyScope, { battle: null, families: M.families, fam: f => f, maxZoom: M.max_zoom });

  // --- shared zones: content/shared/zones/<id>/zone.geojson, read when a story first names one ---
  const commonZones = path.join(content, 'shared', 'zones');
  const sharedIds = () => zoneLib(commonZones);
  const checkClip = (clip, at) => { for (const n of clip ?? []) if (!M.countries.includes(n)) fail(at, `clip country "${n}" is not in the countries of ${storyFile}`); };
  // the folder as written: its outline, its name and its family before the story's aliases
  const sharedZone = (id, at) => {
    if (E.zoneFolders[id]) return E.zoneFolders[id].data;
    if (!sharedIds().has(id)) fail(at, `unknown zone "${id}"`);
    const dir = sharedIds().get(id), file = path.join(dir, 'zone.geojson'), feat = ctx.readJson(file, SharedZone);
    const t = ctx.translatorFor({ defaultLang: feat.properties.default_language, dir, where: rel(file) });
    const data = { family: feat.properties.family, name: t.tr(feat.properties.name, 'zone.name'), geometry: feat.geometry, clipNames: feat.properties.clip ?? null, file: rel(file), dir };
    E.zoneFolders[id] = { id, dir: rel(dir), defaultLang: feat.properties.default_language, translator: t, data, used: false, kind: 'zone' };
    return data;
  };
  // a shared zone's family is the story's family of that id or alias, for its colour and its place among the zones
  const sharedFamily = d => E.storyFamily(d.family) ?? fail(d.file, `family "${d.family}" is not in ${storyFile}, give a family there the id or alias "${d.family}", or the zone a family of the story in zones.yaml`);
  // a zone a page or an include names: the story's, else a shared one as it is
  E.resolveZone = (id, at) => {
    if (E.zoneFiles.has(id) && sharedIds().has(id)) fail(at, `zone "${id}" is in ${rel(E.definedIn[`zone ${id}`])} and in ${rel(sharedIds().get(id))}, keep one`);
    if (E.zones[id]) return id;
    const d = sharedZone(id, at);
    checkClip(d.clipNames, d.file);
    define(E.zones, id, { id, family: sharedFamily(d), name: d.name, geometry: d.geometry, clipNames: d.clipNames }, d.file, 'zone', d.dir);
    E.zoneFolders[id].used = true;
    return id;
  };
  // a zones.yaml entry: the outline of the zone it names, its own name and family where it gives them, and the clip
  // the story chose for it, else the story's land
  const resolving = [];
  E.useZone = u => {
    if (u.done) return E.zones[u.id];
    if (resolving.includes(u.id)) fail(u.file, `zone "${u.id}" takes its outline from itself, through ${resolving.join(', ')}`);
    resolving.push(u.id);
    try {
      const entry = u.zone !== u.id && E.zoneUses.find(x => x.id === u.zone);
      const other = u.zone !== u.id && (entry ? E.useZone(entry) : E.zones[u.zone]);
      const base = other || sharedZone(u.zone, u.file), shared = !other;
      const family = u.family ? E.storyFamily(u.family) ?? fail(u.file, `zone "${u.id}" uses unknown family "${u.family}"`) : shared ? sharedFamily(base) : base.family;
      checkClip(u.clip, u.file);
      // a zone file or another entry of this id makes define report it twice
      define(E.zones, u.id, { id: u.id, family, name: u.name ? T(u.name, `zones.${u.id}.name`) : base.name, geometry: base.geometry, clipNames: u.clip ?? null }, u.file, 'zone', u.dir);
      if (shared && !u.name) E.zoneFolders[u.zone].used = true;
      u.done = true;
      return E.zones[u.id];
    } finally { resolving.pop(); }
  };

  // --- zones, routes and markers one folder defines ---
  E.defineIn = (dir, s) => {
    const { attempt } = ctx;
    const zoneDir = path.join(dir, 'zones');
    if (!s.battle) for (const f of geojsonIn(zoneDir)) attempt(dir, () => {
      const file = path.join(zoneDir, f), feat = ctx.readJson(file, Zone), id = feat.properties.id ?? idOf(path.basename(f, '.geojson'));
      if (!M.families[feat.properties.family]) fail(rel(file), `unknown family "${feat.properties.family}"`);
      for (const n of feat.properties.clip ?? []) if (!M.countries.includes(n)) fail(rel(file), `clip country "${n}" is not in the story's countries`);
      define(E.zones, id, { id, family: feat.properties.family, name: T(feat.properties.name, `zones.${id}.name`), geometry: feat.geometry, clipNames: feat.properties.clip ?? null }, rel(file), 'zone', dir);
      E.zoneFiles.add(id);
    });
    const usesFile = path.join(dir, 'zones.yaml');
    if (!s.battle && exists(usesFile)) attempt(dir, () => {
      for (const [id, u] of Object.entries(ctx.readYaml(usesFile, ZoneUses))) E.zoneUses.push({ id, ...u, file: rel(usesFile), dir });
    });
    for (const f of listFiles(path.join(dir, 'routes'), '.geojson')) attempt(dir, () => {
      const file = path.join(dir, 'routes', f), feat = ctx.readJson(file, Route), p = feat.properties, own = p.id ?? idOf(f.replace('.geojson', '')), id = s.ns(own);
      if (p.color && !s.families[p.color]) fail(rel(file), `route "${own}" uses unknown family "${p.color}"${s.battle ? ', add it to families in battle.yaml' : ''}`);
      define(E.routes, id, { id, name: s.T(p.name, `routes.${own}.name`), style: p.style, arrows: p.arrows, offset: p.offset, color: p.color ? s.fam(p.color) : null, coordinates: feat.geometry.coordinates }, rel(file), 'route', dir);
    });
    const markerFile = path.join(dir, 'markers.yaml');
    if (exists(markerFile)) attempt(dir, () => {
      for (const [own, m] of Object.entries(ctx.readYaml(markerFile, Markers))) attempt(dir, () => {
        if (m.color && !s.families[m.color]) fail(rel(markerFile), `marker "${own}" uses unknown family "${m.color}"${s.battle ? ', add it to families in battle.yaml' : ''}`);
        const name = LEGACY_ICONS[m.icon] ?? m.icon, id = s.ns(own);
        ctx.icon(name, `${rel(markerFile)} marker "${own}"`);
        define(E.markers, id, { id, lnglat: m.lnglat, icon: name, color: m.color ? s.fam(m.color) : null, image: m.image ? ctx.resolveImage(s, m.image, rel(markerFile)) : null,
          label: s.T(m.label, `markers.${own}.label`, { shared: true }), note: m.note ? s.T(m.note, `markers.${own}.note`) : ctx.emptyText() }, rel(markerFile), 'marker', dir);
      });
    });
    if (exists(path.join(dir, 'images.yaml'))) attempt(dir, () => fail(rel(path.join(dir, 'images.yaml')), 'images live in image folders, content/<story>/shared/images/<name>-<six hex digits>/, and kitap image <file> <name> makes one'));
    if (exists(path.join(dir, 'battles.yaml'))) fail(rel(path.join(dir, 'battles.yaml')), 'battles live in folders now, one per battle: content/<story>/shared/battles/<id>/battle.yaml, or content/shared/battles/<id>/battle.yaml for a battle several stories share');
  };

  // --- battles: a folder each, in this story's shared/battles/ or in content/shared/battles/ for every story ---
  E.useBattle = (id, at) => {
    if (id in E.battleCtx) return E.battleCtx[id];
    E.battleCtx[id] = null; // a battle that does not read reports once
    return E.battleCtx[id] = loadBattle(id, at);
  };
  // the whole folder, pages included, also for a story that shows the card alone: its catalogues keep every key
  function loadBattle(id, at) {
    const shared = path.join(ctx.root, where, 'shared');
    const ownLib = path.join(shared, 'battles'), commonLib = path.join(content, 'shared', 'battles');
    const own = battleLib(ownLib).get(id), found = [own, battleLib(commonLib).get(id)].filter(Boolean);
    if (found.length > 1) fail(at, `battle "${id}" is in both ${rel(found[0])} and ${rel(found[1])}, keep one`);
    const dir = found[0] ?? fail(at, `unknown battle "${id}", add ${rel(path.join(ownLib, id))}/battle.yaml or ${rel(path.join(commonLib, id))}/battle.yaml`);
    const file = path.join(dir, 'battle.yaml');
    if (!exists(file)) fail(rel(dir), 'battle.yaml is missing');
    const b = ctx.readYaml(file, Battle);
    ctx.icon('swords', rel(file)); // the card and its map marker draw swords, also where no marker of the story does
    const t = ctx.translatorFor({ defaultLang: b.default_language, dir, where: rel(file) });
    // a story's own battle sees the story's image folders, a shared battle the shared ones alone
    const s = ctx.scope({ kind: 'battle', battle: id, T: t.tr, defaultLang: b.default_language, families: b.families, ns: x => `${id}/${x}`, fam: f => `${id}_${f}`,
      pageId: x => `${id}-${x}`, maxZoom: Math.max(M.max_zoom, b.max_zoom ?? 0), textFallback: true, texts: {}, firstImages: {},
      imageDirs: dir === own ? [ctx.storyImages, ctx.commonImages] : [ctx.commonImages] });
    for (const [f, c] of Object.entries(b.families)) {
      const sf = E.storyFamily(f);
      if (!sf) ctx.warn(`battle "${id}" draws "${f}" in its own colour, give a family in ${storyFile} the id or alias "${f}" to use the story's`);
      const { color, color_dark } = sf ? M.families[sf] : c;
      E.families[s.fam(f)] = color_dark ? { color, color_dark } : { color };
    }
    const sides = b.sides.map((side, i) => {
      const hex = side.color?.startsWith('#'), known = !side.color || hex || b.families[side.color];
      if (!known) ctx.attempt(dir, () => fail(rel(file), `side ${i + 1} uses "${side.color}", which is not in the battle's families`));
      const k = `battle.sides.${i}`;
      return { name: s.T(side.name, `${k}.name`), color: !known || !side.color ? null : hex ? side.color : s.fam(side.color), commanders: side.commanders.map((c, j) => s.T(c, `${k}.commanders.${j}`, { shared: true })),
        strength: side.strength ? s.T(side.strength, `${k}.strength`) : null, casualties: side.casualties ? s.T(side.casualties, `${k}.casualties`) : null };
    });
    E.battles[id] = { id, lnglat: b.lnglat, name: s.T(b.name, 'battle.name'), date: s.T(b.date, 'battle.date'), result: b.result ? s.T(b.result, 'battle.result') : null,
      sides, images: [], source: b.source ?? null, front: b.front ?? null };
    for (const f of fs.readdirSync(dir, { recursive: true })) if (['zones', 'zones.yaml'].includes(path.basename(f))) ctx.attempt(dir, () => fail(rel(path.join(dir, f)), 'a battle holds no zones, the story that includes it shows its own with zones in include.yaml'));
    const tree = ctx.walk(path.join(dir, 'pages'), s), nodes = ctx.pagesIn(tree);
    let done = false;
    // the battle's files, read where the battle sits in the story, so problems come in reading order
    const prepare = () => {
      if (done) return;
      done = true;
      E.defineIn(dir, s);
      for (const n of nodes) E.defineIn(n.dir, s);
      E.battles[id].images = b.images.map(ref => ctx.attempt(dir, () => ctx.resolveImage(s, ref, rel(file)))).filter(Boolean);
    };
    s.prepare = prepare;
    const b2 = { id, dir: rel(dir), defaultLang: s.defaultLang, tree, nodes, scope: s, translator: t, fallbacks: s.fallbacks, include: null, kind: 'battle', pages: true,
      // a battle the story only names keeps its pages' texts to itself, so a story page of the same id keeps its own
      read() { prepare(); if (!b2.include) for (const n of nodes) ctx.attempt(n.dir, () => ctx.readPage(n.dir, s)); return b2; } };
    return b2;
  }
  return E;
}

// include.yaml in the story's page tree: a battle's pages placed there, under a header when it has several
function include(dir, s, ctx) {
  const E = ctx.state, { fail, rel } = ctx;
  const file = path.join(dir, 'include.yaml'), at = rel(file);
  if (s.battle) fail(at, 'a battle includes no other battle, the story includes each battle it shows');
  const extra = fs.readdirSync(dir).filter(f => f !== 'include.yaml' && !f.startsWith('.')); // .DS_Store and the like
  if (extra.length) fail(rel(dir), `an include folder holds include.yaml alone, move ${extra.join(', ')} into the battle's folder or a page`);
  const inc = ctx.readYaml(file, Include);
  if (E.includes.some(i => i.battle === inc.battle)) fail(at, `battle "${inc.battle}" is included twice, a story includes a battle once`);
  const b = E.useBattle(inc.battle, at);
  if (!b) return null;
  if (!b.nodes.length) fail(at, `battle "${inc.battle}" has no pages to include, a page that writes battle: ${inc.battle} shows its card`);
  E.includes.push({ ...inc, dir, file: at });
  b.include = { zones: inc.zones, markers: inc.markers, dir: rel(dir) };
  // an included battle's texts and images join the story's, and its pages show the include's zones and markers
  Object.assign(b.scope, { texts: ctx.texts, firstImages: ctx.firstImages, include: rel(dir),
    decorate: pg => ({ ...pg, harita: { ...pg.harita, zones: inc.zones, markers: [...inc.markers, ...pg.harita.markers] } }) });
  // one page stands alone, more go under a header with the battle's name
  return b.tree.length === 1 && b.tree[0].type === 'page' ? b.tree[0] : { type: 'group', id: b.id, title: E.battles[b.id].name, children: b.tree };
}

// zones.yaml entries once every zone file is read, since an entry may take the outline of one read later; then the
// includes' zones and markers
function prepare(ctx) {
  const E = ctx.state, { attempt, fail } = ctx;
  for (const u of E.zoneUses) attempt(u.dir, () => E.useZone(u));
  for (const inc of E.includes) attempt(inc.dir, () => {
    for (const z of inc.zones) E.resolveZone(z, inc.file);
    for (const m of inc.markers) if (!E.markers[m]) fail(inc.file, `unknown marker "${m}"`);
  });
}

// the map fields of a page, checked against what the story and the scope define
function readPage(mp, { dir, at, own, pid, scope: s }, ctx) {
  const E = ctx.state, { fail, attempt, rel } = ctx;
  const pg = check(PageMap, mp, at);
  // routes in a list of their own were travelled at the same time, such as the columns of one army
  const groups = pg.routes.filter(Array.isArray); pg.routes = pg.routes.flat();
  const need = (ok, msg) => attempt(dir, () => ok || fail(at, msg));
  if (s.battle && pg.zones.length) need(false, 'a battle page has no zones, the story that includes the battle shows its own with zones in include.yaml');
  for (const z of pg.zones) attempt(dir, () => E.resolveZone(z, at));
  for (const r of pg.routes) need(E.routes[s.ns(r)], `unknown route "${r}"`);
  for (const m of pg.markers) need(E.markers[s.ns(m)], `unknown marker "${m}"`);
  let battle = null;
  if (s.battle) {
    if (typeof pg.battle === 'string') need(false, 'a battle page opens its own card with battle: true');
    else if (pg.battle) battle = s.battle;
  } else if (pg.battle === true) need(false, "battle: true opens the card on a battle's own page, a story page names the battle: battle: <id>");
  else if (pg.battle) { attempt(dir, () => E.useBattle(pg.battle, at)); battle = E.battles[pg.battle] ? pg.battle : null; }
  const emblem = pg.emblem ? attempt(dir, () => emblemFor(ctx.root, pg.emblem, `${at} emblem`, { families: s.families, fam: s.fam, T: s.T, pid: own, fail })) : null;
  const markers = pg.markers;
  return {
    data: { bbox: pg.bbox, camera: pg.camera ?? null, maxZoom: s.maxZoom, zones: pg.zones, routes: pg.routes.map(s.ns), ...(groups.length ? { groups: groups.map(g => g.map(s.ns)) } : {}), markers: markers.map(s.ns), battle,
      emblem: emblem?.fc ?? null, emblemNames: emblem?.names ?? {} },
    credits: pg.map_sources, creditsKey: 'map_sources',
    // a place the text links is a marker the page shows
    links: { has: id => markers.includes(id), attr: id => ` data-marker="${esc(s.ns(id))}"`, missing: (name, id) => `[${name}](@${id}) links to the marker "${id}", add it to the markers of page.yaml or link one the page shows`,
      names: lang => markers.filter(m => E.markers[s.ns(m)]).map(m => [m, E.markers[s.ns(m)].label[lang]]) },
  };
}

// after the pages: the battles only named read their files, the tables keep what the pages show, and a family with
// two zones on a page is reported
function finish({ story, pages }, ctx) {
  const E = ctx.state, { fail, onProblem, strict, root } = ctx;
  const battleList = Object.values(E.battleCtx).filter(Boolean);
  for (const b of battleList) b.read(); // a battle the story only names: its files are checked, and its catalogues keep every key
  const shownRoutes = new Set(pages.flatMap(pg => pg.harita.routes)), shownMarkers = new Set(pages.flatMap(pg => pg.harita.markers));
  for (const [table, shown] of [[E.routes, shownRoutes], [E.markers, shownMarkers]]) for (const id of Object.keys(table)) if (!shown.has(id)) delete table[id];
  const images = [...pages.flatMap(pg => pg.harita.battle ? E.battles[pg.harita.battle]?.images ?? [] : []), ...[...shownMarkers].map(m => E.markers[m]?.image).filter(Boolean)];
  // A family is one state, so a page shows each family in one zone: two states of one family read as one state divided.
  // check reports it, the build warns, and with --strict the build stops. A set of zones is named once, at its first page.
  const warnings = [], named = new Set();
  for (const pg of pages) {
    const byFamily = {};
    for (const z of pg.harita.zones) if (E.zones[z]) (byFamily[E.zones[z].family] ??= []).push(z);
    for (const [f, zs] of Object.entries(byFamily)) {
      const at = pg.include ?? pg.dir, key = f + ' ' + [...zs].sort().join(' ');
      if (zs.length < 2 || named.has(key)) continue;
      named.add(key);
      const msg = `${at}: family "${f}" has ${zs.length} zones on this page, ${zs.join(', ')}. A family is one state: give each state a family `
        + 'of its own, and draw a state that shows as two zones as one zone';
      if (onProblem) onProblem(path.join(root, at), msg, pg.id); else if (strict) fail(at, msg.slice(at.length + 2)); else warnings.push(msg);
    }
  }
  E.pages = pages;
  const folders = [...battleList, ...Object.values(E.zoneFolders)];
  return { images, warnings, folders };
}

// --- the map bundle: borders, land, labels, the cleaned zones and the terrain plan ---
function bundle(content, ctx) {
  const E = content.state, M = E.map, { pages, langs, T } = content, { log, fail, where, cache, hash, readCache, writeCache } = ctx;
  // borders are cut to the extent plus a margin, so a country with a long coastline elsewhere stays out of the bundle
  const [ew, es, ee, en] = M.extent, margin = 5;
  const clipBox = [Math.max(-180, ew - margin), Math.max(-90, es - margin), Math.min(180, ee + margin), Math.min(90, en + margin)];
  // bboxClip leaves an empty polygon for every piece outside the box, which the geometry library refuses
  const clip = f => { const g = turf.bboxClip(f, clipBox).geometry, polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).filter(p => p.length && p[0].length >= 4); return polys.length === 1 ? turf.polygon(polys[0]).geometry : turf.multiPolygon(polys).geometry; };
  const countries = world().filter(f => M.countries.includes(f.properties.name))
    .map(f => ({ type: 'Feature', id: f.id, properties: { name: f.properties.name }, geometry: clip(f) }));
  for (const n of M.countries) if (!countries.find(f => f.properties.name === n)) fail(where, `country "${n}" not in Natural Earth`);
  for (const f of countries) if (!f.geometry.coordinates.length) fail(where, `country "${f.properties.name}" lies outside the extent`);
  const landParts = M.land.map(n => countries.find(f => f.properties.name === n) || fail(where, `land "${n}" is not in countries`));
  const land = landParts.length > 1 ? turf.union(turf.featureCollection(landParts)) : landParts[0];
  const topo = ts.topology({ countries: { type: 'FeatureCollection', features: countries } }, 1e5);
  // tint: an index into the theme's land tints such that no two neighbours share one; most connected countries first
  const geoms = topo.objects.countries.geometries, near = tc.neighbors(geoms);
  for (const i of geoms.map((_, i) => i).sort((a, b) => near[b].length - near[a].length)) {
    const taken = new Set(near[i].map(j => geoms[j].properties.tint));
    let t = 0; while (taken.has(t)) t++;
    geoms[i].properties.tint = t % LAND_SLOTS;
  }
  // land in a battle plan takes the tint of the country it lies on, or of the nearest one where the coast misses it
  const tintOf = Object.fromEntries(geoms.map(g => [g.properties.name, g.properties.tint]));
  for (const pg of pages) for (const f of pg.harita.emblem?.features ?? []) if (f.properties.land) {
    const pt = f.geometry.coordinates[0][0];
    const { c } = countries.reduce((best, c) => { const d = turf.pointToPolygonDistance(pt, c); return d < best.d ? { c, d } : best; }, { d: Infinity });
    f.properties.tint = tintOf[c.properties.name];
  }

  // --- country labels: one point per country at the pole of inaccessibility of its largest visible piece ---
  // The text per language is the override from story.yaml, else the Natural Earth name. rank orders collisions, big first.
  let labels = null;
  if (M.labels?.countries) {
    for (const n of [...Object.keys(M.labels.names), ...M.labels.hide]) if (!M.countries.includes(n)) fail(where, `labels name "${n}" is not in countries`);
    labels = countries.filter(f => !M.labels.hide.includes(f.properties.name)).map(f => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const biggest = polys.map(c => turf.polygon(c)).sort((a, b) => turf.area(b) - turf.area(a))[0];
      const [x, y] = polylabel(biggest.geometry.coordinates, 0.01);
      const text = M.labels.names[f.properties.name] ? T(M.labels.names[f.properties.name], `labels.${f.properties.name}`) : Object.fromEntries(langs.map(l => [l, f.properties.name]));
      return { type: 'Feature', properties: { ...text, rank: -Math.round(km2(f)) }, geometry: { type: 'Point', coordinates: [+x.toFixed(3), +y.toFixed(3)] } };
    });
  }

  // each zone is clipped to the land, or to the countries its clip names
  for (const z of Object.values(E.zones)) {
    const parts = (z.clipNames ?? []).map(n => countries.find(f => f.properties.name === n));
    z.clip = !parts.length ? land : parts.length > 1 ? turf.union(turf.featureCollection(parts)) : parts[0];
  }

  // --- clean zones: trim by family priority, round the shared boundaries once, clip to land, validate ---
  // zones only trim and overlap check against zones that share a page with them, so a 1915 beachhead
  // never cuts a hole in a 1919 occupation zone
  const pageZones = pages.map(pg => pg.harita.zones);
  const pairs = new Set(pageZones.flatMap(zs => zs.flatMap(a => zs.map(b => a + ' ' + b))));
  const together = (a, b) => pairs.has(a + ' ' + b);
  const prio = f => M.families[f].priority;
  const ordered = Object.values(E.zones).sort((a, b) => prio(a.family) - prio(b.family));
  // the cleaned shapes follow from these inputs alone, so a build that leaves them as they were reads the cache
  const zoneKey = hash({ code: GEOMETRY_CODE, extent: M.extent, land: M.land, smoothing: M.smoothing, pages: pageZones,
    prio: Object.fromEntries(Object.keys(M.families).map(f => [f, prio(f)])), zones: ordered.map(z => [z.id, z.family, z.clipNames, z.geometry]) });
  const zoneFile = path.join(cache, 'stories', path.basename(where), 'zones.json');
  const cached = readCache(zoneFile);
  let shapes, zoneLines;
  if (cached?.key === zoneKey) {
    ({ shapes, lines: zoneLines } = cached);
    for (const l of zoneLines) log(l);
  } else {
    ({ shapes, lines: zoneLines } = cleanZones({ ordered, prio, together, smoothing: M.smoothing, where, log, fail }));
    writeCache(zoneFile, { key: zoneKey, shapes, lines: zoneLines });
  }
  const zones = Object.fromEntries(ordered.map(z => [z.id, { ...z, feature: shapes[z.id] }]));
  // the closest view each zone opens at sets the detail its outline keeps
  const zoneZoom = {};
  for (const pg of pages) for (const z of pg.harita.zones) zoneZoom[z] = Math.max(zoneZoom[z] ?? 0, openZoom(pg.harita.bbox));

  // --- families shown on the same page must differ in colour or in pattern ---
  const warnings = alikePairs(M.families, pages.map(p => ({ dir: p.dir, families: [...new Set(p.harita.zones.map(z => zones[z].family))] }))).map(describe);
  // --- elevation: the tiles this story needs, in the store or with --local-assets copied to dist/assets/ ---
  const terrain = { tiles: ctx.objectLink(tileKey('{z}/{x}/{y}')), ranges: ctx.objects.own.plan.ranges, maxzoom: ctx.objects.own.plan.maxzoom };
  const data = {
    extent: M.extent, maxZoom: M.max_zoom, camera: Camera.parse({}), topo, land: { type: 'Feature', properties: {}, geometry: land.geometry }, terrain, labels,
    zones: Object.fromEntries(Object.values(zones).map(z => [z.id, { family: z.family, name: z.name, area: Math.round(km2(z.feature)) }])),
    zoneShapes: packZones(shapes, zoneZoom), routes: E.routes, markers: E.markers, battles: E.battles,
  };
  return { data, families: E.families, credits: ctx.objects.own.plan.credits, warnings };
}

// the story's elevation tiles: the extent to the base zoom, and each page's area at the zooms it opens at
function objects(content) {
  const E = content.state, plan = terrainPlan(E.map.extent, content.pages.map(pg => ({ bbox: pg.harita.bbox, maxZoom: pg.harita.maxZoom })));
  const groups = {};
  for (const t of tileKeys([plan])) (groups[`terrain/${t.split('/')[0]}`] ??= []).push(tileKey(t));
  return { groups, plan };
}

// cuts the tiles the stories' groups name into the cache, then copies each to its key under out
async function make({ stories, cache, out, log, options = {} }) {
  const keys = [...new Set(stories.flatMap(s => Object.values(s.groups).flat()))].map(k => k.match(/^terrain\/v\d+\/(.+)\.png$/)?.[1]).filter(Boolean);
  if (!keys.length) return;
  const dir = await cutTiles({ keys, cache, elevation: options.elevation, log });
  let bytes = 0;
  for (const k of keys) {
    const from = path.join(dir, k + '.png'), to = path.join(out, tileKey(k)), size = fs.statSync(from).size;
    bytes += size;
    if (fs.existsSync(to) && fs.statSync(to).size === size) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  log(`wrote ${keys.length} elevation tiles (${(bytes / 1e6).toFixed(1)} MB) into ${path.join(path.basename(path.dirname(out)), path.basename(out))}/terrain`);
}

// every build compares the zones: a pair that looks alike is a warning, and with --strict a copy stops the build
function site({ root, cache, strict, log, stories, fail }) {
  if (exists(path.join(root, 'content', 'shared', 'battles.yaml'))) fail('content/shared/battles.yaml', 'battles live in folders now, one per battle: content/shared/battles/<id>/battle.yaml');
  const { pairs, stale, unread } = zonePairs({ root, cache, stories });
  // a zone file that does not read stops the build of its own story, not of the others
  for (const line of unread) log(`warning: ${line}, left out of the zone comparison`);
  const page = path.relative(root, path.join(cache, 'zones.html'));
  for (const pair of pairs.filter(x => !x.exact || !strict)) log(`warning: ${describePair(pair)}, see ${page}`);
  for (const line of stale) log(`warning: ${line}`);
  // the way out of a copy depends on where the two zones are
  const fix = ({ a, b }) => {
    const [own, common] = a.story ? [a, b] : [b, a], at = z => `${z.story}/${z.id}`;
    if (!a.story && !b.story) return `keep one of the shared zones ${a.id} and ${b.id}`;
    if (!common.story) return `name the shared zone ${common.id} in place of ${at(own)}, or give ${at(own)} a zones.yaml entry { zone: ${common.id} }, and remove its file`;
    return `harita zones --share ${at(a)} --replace ${at(b)} keeps one outline, and each story its name and family`;
  };
  const copies = pairs.filter(x => x.exact);
  if (strict && copies.length) fail('content/', `zones that copy another one: ${copies.map(c => `${describePair(c)}: ${fix(c)}`).join('. ')}`);
}

export default {
  id: 'harita',
  dir: PKG,
  schemas: { story: StoryMap, page: PageMap },
  ui: new URL('./i18n/', import.meta.url),
  client: { script: new URL('./map.js', import.meta.url), libraries: [['maplibre-gl', 'dist/maplibre-gl.js'], ['topojson-client', 'dist/topojson-client.min.js'], ['@turf/turf', 'turf.min.js']] },
  // the label font for the map, in harita's glyphs/ folder: Noto Sans from the Protomaps basemaps assets
  vendor: out => fs.cpSync(path.join(PKG, 'glyphs', 'noto-sans'), path.join(out, 'glyphs', 'noto-sans'), { recursive: true }),
  read: { story: readStory, folder: (dir, s, ctx) => ctx.state.defineIn(dir, s), include, prepare, page: readPage, finish },
  bundle, objects, make, site,
  describeObjects: keys => `${keys.length} elevation tile${keys.length === 1 ? '' : 's'}`,
};
