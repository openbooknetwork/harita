// Walk content/<story>/, clean the geometry, render the texts, and write dist/.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml from 'js-yaml';
import { marked } from 'marked';
import * as turf from '@turf/turf';
import * as tc from 'topojson-client';
import * as ts from 'topojson-server';
import polylabel from 'polylabel';
import { check, Site, Story, Group, Page, Camera, Markers, Battle, Include, ImageFolder, Zone, SharedZone, ZoneUses, Route, Themes, BattlePlan } from './schema.mjs';
import { alikePairs, describe } from './palette.mjs';
import { loadCatalogues, translator, flatten, unflatten } from './i18n.mjs';
import { coverage, packZones } from './coverage.mjs';
import { terrainPlan, tileKeys, tileKey, terrainTiles, openZoom } from './terrain.mjs';
import { esc, ordinals, siteContext, storyFiles, siteFiles } from './pages.mjs';
import { libraryItems, storyFolders, isImage, isBattle, isZone } from './folders.mjs';
import { world } from './world.mjs';
import { hash, listDirs, idOf, boxesMeet } from './util.mjs';
import { zonePairs, describePair } from './zones.mjs';
import { sha256, imageKeys } from './image.mjs';
import { storyTree, checkStore } from './store.mjs';

// PKG is this package. The content project comes in as the root of each build.
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const REPO = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const COMMON = fs.readFileSync(path.join(PKG, 'src', 'common.js'), 'utf8').replace('/*__REPO__*/', REPO);
// the story page shell, and the script every story page shares as dist/harita.js
const APP = fs.readFileSync(path.join(PKG, 'src', 'app.html'), 'utf8');
const APP_JS = COMMON + '\n' + fs.readFileSync(path.join(PKG, 'src', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PKG, 'src', 'index.html'), 'utf8').replace('/*__COMMON__*/', COMMON);
// a script's version in its URL, so a browser holding the last release's copy fetches the new one
const version = text => hash(text).slice(0, 10);
// the shape of the main page card kept in the cache. A card of another shape counts as no cache.
const CARD_FORMAT = 5;
// Cache files are written whole and renamed into place, so a build running at the same time reads the old file or
// the new one. A file that is missing or does not parse counts as no cache.
const readCache = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// Copies an original unless dest already holds it, through a temporary file, so a build running beside reads it whole.
const copyFresh = (file, dest) => {
  const from = fs.statSync(file), to = fs.existsSync(dest) && fs.statSync(dest);
  if (to && to.size === from.size && to.mtimeMs >= from.mtimeMs) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}`;
  fs.copyFileSync(file, tmp); fs.renameSync(tmp, dest);
};
const writeCache = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); };
// the code and libraries the cleaned zones come from, part of each story's zone cache key
const GEOMETRY_CODE = hash(['build.mjs', 'coverage.mjs', 'world.mjs', 'util.mjs'].map(f => fs.readFileSync(path.join(PKG, 'src', f), 'utf8'))
  .concat(['@turf/turf', 'world-atlas', 'topojson-server', 'topojson-client'].map(m => require(m + '/package.json').version)));
const UI_DIR = path.join(PKG, 'src', 'i18n');
const UI = Object.fromEntries(fs.readdirSync(UI_DIR).filter(f => f.endsWith('.yaml')).map(f => [f.replace(/\.yaml$/, ''), yaml.load(fs.readFileSync(path.join(UI_DIR, f), 'utf8'))]));
// Marker icons come from Lucide; the names the first stories used before map onto it
const ICON_DIR = path.dirname(require.resolve('lucide-static/icons/flag.svg'));
const LEGACY_ICONS = { congress: 'users', scroll: 'scroll-text', building: 'landmark' };
function iconSvg(name, where) {
  const file = path.join(ICON_DIR, name + '.svg');
  if (!exists(file)) fail(where, `unknown icon "${name}", pick a name from https://lucide.dev/icons`);
  return fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\s*class="[^"]*"/, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
}

const fail = (where, msg) => { throw new Error(`${where}: ${msg}`); };
const exists = p => fs.existsSync(p);
const listFiles = (p, ext) => exists(p) ? fs.readdirSync(p).filter(f => f.endsWith(ext)).sort() : [];
// the .geojson files of a zones/ folder, in its subfolders too, which only order them
const geojsonIn = p => exists(p) ? fs.readdirSync(p, { recursive: true }).filter(f => f.endsWith('.geojson') && !f.split(path.sep).some(x => x.startsWith('.'))).sort() : [];
const km2 = f => turf.area(f) / 1e6;
const intersect = (a, b) => turf.intersect(turf.featureCollection([a, b]));
const difference = (a, b) => turf.difference(turf.featureCollection([a, b]));
const writeFile = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const emptyText = langs => Object.fromEntries(langs.map(l => [l, '']));
// A when value with the missing parts rounded down for from and up for to.
const whenEdge = (s, isEnd) => { const [y, m, d] = s.split('-'); return `${y}-${m ?? (isEnd ? '12' : '01')}-${d ?? (isEnd ? '31' : '01')}`; };
// Interface strings for a language: the package file, else English, with the project's i18n/ui/<lang>.yaml laid over it.
// Interface keys: every string harita ships in English, plus a name for each theme the site offers.
const uiOwn = (root, l) => { const f = path.join(root, 'i18n', 'ui', l + '.yaml'); return exists(f) ? flatten(yaml.load(fs.readFileSync(f, 'utf8')) ?? {}) : {}; };
export function uiCatalogue(root, lang, themes) {
  const en = flatten(UI.en);
  const entries = Object.keys(en).filter(k => !k.startsWith('themes.')).map(key => ({ key, source: en[key], shared: false, inline: null }))
    .concat(Object.entries(themes).map(([id, t]) => ({ key: `themes.${id}`, source: en[`themes.${id}`] ?? (typeof t.name === 'string' ? t.name : t.name?.en) ?? id, shared: false, inline: null })));
  // a theme that still carries an inline name for this language counts as translated
  const inlineNames = Object.fromEntries(Object.entries(themes).filter(([, t]) => typeof t.name === 'object' && t.name?.[lang]).map(([id, t]) => [`themes.${id}`, t.name[lang]]));
  const have = { ...inlineNames, ...flatten(UI[lang] ?? {}), ...uiOwn(root, lang) };
  return { entries, existing: have, missing: entries.filter(e => !have[e.key]).map(e => e.key), shipped: Object.keys(flatten(UI[lang] ?? {})).length > 0 };
}
// dir is the language's writing direction, from ICU; Node before 23 has textInfo, later ones getTextInfo()
const textDir = l => { const loc = new Intl.Locale(l); return (loc.getTextInfo?.() ?? loc.textInfo).direction; };
function uiFor(langs, root) {
  // a missing key falls back to English alone
  return Object.fromEntries(langs.map(l => [l, { ...unflatten({ ...flatten(UI.en), ...flatten(UI[l] ?? {}), ...uiOwn(root, l) }), dir: textDir(l) }]));
}
const themeList = (themes, ui, langs) => Object.entries(themes).map(([id, t]) => ({ id, name: Object.fromEntries(langs.map(l => [l, ui[l].themes?.[id] ?? (typeof t.name === 'string' ? t.name : t.name?.[l] ?? t.name?.en) ?? id])) }));

// The content project of one build: its folders, its logger, and readers that name files relative to it.
function project(root, log) {
  const rel = p => path.relative(root, p);
  const loadYaml = p => { try { return yaml.load(fs.readFileSync(p, 'utf8')) ?? {}; } catch (e) { fail(rel(p), e.message); } };
  const readYaml = (p, schema) => check(schema, loadYaml(p), rel(p));
  const readJson = (p, schema) => { let data; try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { fail(rel(p), e.message); } return check(schema, data, rel(p)); };
  // the links of an image's objects, from the site root or absolute. buildPages sets them for its assets mode.
  const imageLinks = ({ keys }) => ({ original: `assets/${keys.original}`, large: `assets/${keys.large}`, small: `assets/${keys.small}` });
  return { root, content: path.join(root, 'content'), dist: path.join(root, 'dist'), log, rel, loadYaml, readYaml, readJson, imageLinks };
}
// a link from the site root as a story page uses it, below its story folder
const fromStory = u => /^https?:/.test(u) ? u : `../${u}`;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|svg)$/i;

const LAND_SLOTS = 8;
// CSS for every theme: tokens on :root[data-palette=id], light and dark; the default theme also on bare :root
function themeCss(themes, defaultId) {
  const TOKEN = { paper: '--paper', paper2: '--paper-2', sea: '--sea', ink: '--ink', ink2: '--ink-2', rule: '--rule', accent: '--accent', panel: '--panel', route: '--route', border: '--border' };
  const lum = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  // eight land slots always, filled up from paper2, so a theme without tints paints one colour and never inherits another theme's
  const land = set => [...Array(LAND_SLOTS)].map((_, i) => `--land-${i}:${set.land?.[i % set.land.length] ?? set.paper2};`).join('');
  const decl = set => Object.entries(set).filter(([k]) => TOKEN[k]).map(([k, v]) => `${TOKEN[k]}:${v};`).join('') + land(set) + (lum(set.paper) < 0.5 ? 'color-scheme:dark;' : 'color-scheme:light;');
  const block = (sel, t) => `${sel}{${decl(t.light)}}@media (prefers-color-scheme: dark){${sel}:not([data-theme="light"]){${decl(t.dark)}}}${sel}[data-theme="dark"]{${decl(t.dark)}}`;
  return block(':root', themes[defaultId]) + Object.entries(themes).map(([id, t]) => block(`:root[data-palette="${id}"]`, t)).join('');
}

// An emblem kind is plugins/emblems/<kind>.mjs in the content project, else src/emblems/<kind>.mjs here, so a story
// can replace a built-in kind. The file exports a function (params, { turf, families }) => GeoJSON FeatureCollection,
// drawn as a fill layer: a feature takes its "family" colour for the theme, else its "color". Features that share an
// "id" highlight together, and a "name" shows when the reader points at one. Node 22.12+ loads an ES module through
// require synchronously, which keeps the build synchronous.
const EMBLEM_DIR = path.join(PKG, 'src', 'emblems');
const BUILT_IN_EMBLEMS = { 'battle-plan': BattlePlan }; // each built-in kind with the schema of its parameters
// fam renames a family the plugin returns into the bundle's, which a battle's page needs.
function emblemFor(root, spec, where, { families, fam = f => f, T, pid }) {
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
function cleanZones({ ordered, prio, together, smoothing, where, log }) {
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

// The story's content as text, without geometry: story.yaml, the page tree with each page's text and emblem, and the
// files they use, battles included. onProblem(folder, message, page id) takes each problem, else the first throws.
function readContent(p, storyDir, onProblem = null) {
  const { rel, readYaml, readJson, log, root } = p;
  const where = rel(storyDir), shared = path.join(storyDir, 'shared'), storyFile = path.join(storyDir, 'story.yaml');
  const pageIdOf = new Map(); // a page folder's page id, so check can keep to the pages it was given
  const attempt = (dir, fn) => { if (!onProblem) return fn(); try { return fn(); } catch (err) { onProblem(dir, err.message, pageIdOf.get(dir)); } };
  const warnings = [];
  const story = readYaml(storyFile, Story);
  if (story.hillshade) log(`  ${where}/story.yaml: the relief comes from elevation tiles now, remove the hillshade line and geo/${story.hillshade}`);
  const langs = story.languages;
  const defaultLang = story.default_language ?? langs[0];
  // strings: the default language inline, the others from i18n/<lang>.yaml catalogues
  const { tr: T, entries, report } = translator({ langs, defaultLang, catalogues: loadCatalogues(path.join(storyDir, 'i18n'), langs, p.loadYaml), where: `${where}/i18n`, fail });
  // a battle family takes the colours of the story family with its id, or with its id among the aliases
  const aliasOf = {};
  for (const [f, fam] of Object.entries(story.families)) for (const a of fam.aliases ?? []) {
    if (story.families[a]) fail(rel(storyFile), `family "${f}" has the alias "${a}", which is the id of another family`);
    if (aliasOf[a]) fail(rel(storyFile), `the alias "${a}" is on both "${aliasOf[a]}" and "${f}", keep it on one`);
    aliasOf[a] = f;
  }
  const storyFamily = f => story.families[f] ? f : aliasOf[f] ?? null;

  const zones = {}, routes = {}, markers = {}, battles = {}, images = {}, definedIn = {};
  const define = (table, id, value, file, kind, dir) => { if (table[id]) fail(file, `${kind} "${id}" is defined twice`); table[id] = value; definedIn[`${kind} ${id}`] = dir; };
  const icons = {}, icon = (name, at) => icons[name] ??= iconSvg(name, at);
  for (const n of ['swords', 'x', 'external-link', 'chevron-left', 'chevron-right', 'list', 'info', 'settings']) icon(n, where);
  // the bundle's colour table: the story's families, then each battle's as <battle>_<family>
  const families = { ...story.families };
  const texts = {}, firstImages = {};

  // the items of a library at any depth, by their folder names as written, so a reference finds the same folder on
  // every file system
  const libraries = new Map();
  const library = (dir, isItem, pattern, rule) => {
    if (!libraries.has(dir)) {
      let items;
      try { items = libraryItems(dir, isItem, rel); } catch (err) { fail(rel(dir), err.message); }
      for (const [name, full] of items) if (!pattern.test(name)) fail(rel(full), rule);
      libraries.set(dir, items);
    }
    return libraries.get(dir);
  };
  const ID = /^[a-z0-9][a-z0-9-]*$/;
  const imageLib = dir => library(dir, isImage, /^[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/, 'an image folder is named <name>-<six hex digits>, such as hastings-knights-3f9a1c, and harita image <file> <name> makes one');
  const battleLib = dir => library(dir, isBattle, ID, 'a battle folder is named in lowercase letters, digits and dashes, such as ankara-1402');
  const zoneLib = dir => library(dir, isZone, ID, 'a zone folder is named in lowercase letters, digits and dashes, such as ottoman-1402');
  const storyImages = path.join(shared, 'images'), commonImages = path.join(p.content, 'shared', 'images');
  // A scope is the story's files or one battle folder's. ns turns an id its files use into the bundle's id, fam a
  // family they name into the bundle's family, and pageId a page folder's id into the page's id in the story.
  const storyScope = { battle: null, T, defaultLang, families: story.families, ns: id => id, fam: f => f, pageId: id => id, maxZoom: story.max_zoom,
    imageDirs: [storyImages, commonImages], texts, firstImages };

  // --- image folders: <id>/image.yaml, and the original where this machine has it, read when a text, marker or card
  // first names one. Its objects are in the asset store, or with --local-assets the original is copied to dist/assets/.
  const folderImages = {};
  const loadImageFolder = (dir, id) => {
    if (folderImages[id]) return id;
    const meta = path.join(dir, 'image.yaml'), files = fs.readdirSync(dir).filter(f => /^image\.\w+$/.test(f) && f !== 'image.yaml');
    if (!exists(meta)) fail(rel(dir), 'image.yaml is missing');
    if (files.length > 1) fail(rel(dir), `keep one image file of ${files.join(', ')}`);
    const m = readYaml(meta, ImageFolder);
    if (files.length && files[0] !== m.file) fail(rel(meta), `file names ${m.file} and the folder holds ${files[0]}, harita rehash writes the file it holds`);
    const t = translator({ langs, defaultLang: m.default_language, catalogues: loadCatalogues(path.join(dir, 'i18n'), langs, p.loadYaml), where: rel(meta), fail });
    const keys = imageKeys(id, m), file = files.length ? path.join(dir, files[0]) : null;
    const links = p.imageLinks({ keys, file, url: m.url ?? null, at: rel(dir) });
    define(images, id, { id, src: fromStory(links.large), thumb: fromStory(links.small), caption: t.tr(m.caption, 'image.caption'), credit: m.credit ? t.tr(m.credit, 'image.credit', { shared: true }) : emptyText(langs) }, rel(meta), 'image', dir);
    // social sites read no SVG, so og:image takes the 1280 px WebP of one
    const og = path.extname(m.file) === '.svg' ? links.large : links.original;
    folderImages[id] = { id, dir: rel(dir), meta: rel(meta), file, url: m.url ?? null, sha256: m.sha256, keys, links: { ...links, og }, defaultLang: m.default_language, translator: t };
    return id;
  };
  // an image a text, marker or card names: the image folder the scope sees by that id
  const resolveImage = (s, ref, at) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(ref)) fail(at, `unknown image "${ref}", an image id is lowercase letters, digits and dashes`);
    const dirs = s.imageDirs.map(d => imageLib(d).get(ref)).filter(Boolean);
    if (dirs.length > 1) fail(at, `image "${ref}" is in ${dirs.map(rel).join(' and ')}, keep one`);
    if (dirs.length) return loadImageFolder(dirs[0], ref);
    fail(at, `unknown image "${ref}"`);
  };

  // --- shared zones: content/shared/zones/<id>/zone.geojson, read when a story first names one ---
  const commonZones = path.join(p.content, 'shared', 'zones'), zoneFolders = {}, zoneFiles = new Set(), zoneUses = [];
  const sharedIds = () => zoneLib(commonZones);
  const checkClip = (clip, at) => { for (const n of clip ?? []) if (!story.countries.includes(n)) fail(at, `clip country "${n}" is not in the countries of ${rel(storyFile)}`); };
  // the folder as written: its outline, its name and its family before the story's aliases
  const sharedZone = (id, at) => {
    if (zoneFolders[id]) return zoneFolders[id].data;
    if (!sharedIds().has(id)) fail(at, `unknown zone "${id}"`);
    const dir = sharedIds().get(id), file = path.join(dir, 'zone.geojson'), feat = readJson(file, SharedZone);
    const t = translator({ langs, defaultLang: feat.properties.default_language, catalogues: loadCatalogues(path.join(dir, 'i18n'), langs, p.loadYaml), where: rel(file), fail });
    const data = { family: feat.properties.family, name: t.tr(feat.properties.name, 'zone.name'), geometry: feat.geometry, clipNames: feat.properties.clip ?? null, file: rel(file), dir };
    zoneFolders[id] = { id, dir: rel(dir), defaultLang: feat.properties.default_language, translator: t, data, used: false };
    return data;
  };
  // a shared zone's family is the story's family of that id or alias, for its colour and its place among the zones
  const sharedFamily = d => storyFamily(d.family) ?? fail(d.file, `family "${d.family}" is not in ${rel(storyFile)}, give a family there the id or alias "${d.family}", or the zone a family of the story in zones.yaml`);
  // a zone a page or an include names: the story's, else a shared one as it is
  const resolveZone = (id, at) => {
    if (zoneFiles.has(id) && sharedIds().has(id)) fail(at, `zone "${id}" is in ${rel(definedIn[`zone ${id}`])} and in ${rel(sharedIds().get(id))}, keep one`);
    if (zones[id]) return id;
    const d = sharedZone(id, at);
    checkClip(d.clipNames, d.file);
    define(zones, id, { id, family: sharedFamily(d), name: d.name, geometry: d.geometry, clipNames: d.clipNames }, d.file, 'zone', d.dir);
    zoneFolders[id].used = true;
    return id;
  };
  // a zones.yaml entry: the outline of the zone it names, its own name and family where it gives them, and the clip
  // the story chose for it, else the story's land
  const resolving = [];
  const useZone = u => {
    if (u.done) return zones[u.id];
    if (resolving.includes(u.id)) fail(u.file, `zone "${u.id}" takes its outline from itself, through ${resolving.join(', ')}`);
    resolving.push(u.id);
    try {
      const entry = u.zone !== u.id && zoneUses.find(x => x.id === u.zone);
      const other = u.zone !== u.id && (entry ? useZone(entry) : zones[u.zone]);
      const base = other || sharedZone(u.zone, u.file), shared = !other;
      const family = u.family ? storyFamily(u.family) ?? fail(u.file, `zone "${u.id}" uses unknown family "${u.family}"`) : shared ? sharedFamily(base) : base.family;
      checkClip(u.clip, u.file);
      // a zone file or another entry of this id makes define report it twice
      define(zones, u.id, { id: u.id, family, name: u.name ? T(u.name, `zones.${u.id}.name`) : base.name, geometry: base.geometry, clipNames: u.clip ?? null }, u.file, 'zone', u.dir);
      if (shared && !u.name) zoneFolders[u.zone].used = true;
      u.done = true;
      return zones[u.id];
    } finally { resolving.pop(); }
  };

  // --- zones, routes and markers one folder defines ---
  const defineIn = (dir, s) => {
    const zoneDir = path.join(dir, 'zones');
    if (!s.battle) for (const f of geojsonIn(zoneDir)) attempt(dir, () => {
      const file = path.join(zoneDir, f), feat = readJson(file, Zone), id = feat.properties.id ?? idOf(path.basename(f, '.geojson'));
      if (!story.families[feat.properties.family]) fail(rel(file), `unknown family "${feat.properties.family}"`);
      for (const n of feat.properties.clip ?? []) if (!story.countries.includes(n)) fail(rel(file), `clip country "${n}" is not in the story's countries`);
      define(zones, id, { id, family: feat.properties.family, name: T(feat.properties.name, `zones.${id}.name`), geometry: feat.geometry, clipNames: feat.properties.clip ?? null }, rel(file), 'zone', dir);
      zoneFiles.add(id);
    });
    const usesFile = path.join(dir, 'zones.yaml');
    if (!s.battle && exists(usesFile)) attempt(dir, () => {
      for (const [id, u] of Object.entries(readYaml(usesFile, ZoneUses))) zoneUses.push({ id, ...u, file: rel(usesFile), dir });
    });
    for (const f of listFiles(path.join(dir, 'routes'), '.geojson')) attempt(dir, () => {
      const file = path.join(dir, 'routes', f), feat = readJson(file, Route), own = feat.properties.id ?? idOf(f.replace('.geojson', '')), id = s.ns(own);
      define(routes, id, { id, name: s.T(feat.properties.name, `routes.${own}.name`), style: feat.properties.style, arrows: feat.properties.arrows, offset: feat.properties.offset, coordinates: feat.geometry.coordinates }, rel(file), 'route', dir);
    });
    const markerFile = path.join(dir, 'markers.yaml');
    if (exists(markerFile)) attempt(dir, () => {
      for (const [own, m] of Object.entries(readYaml(markerFile, Markers))) attempt(dir, () => {
        if (m.color && !s.families[m.color]) fail(rel(markerFile), `marker "${own}" uses unknown family "${m.color}"${s.battle ? ', add it to families in battle.yaml' : ''}`);
        const name = LEGACY_ICONS[m.icon] ?? m.icon, id = s.ns(own);
        icon(name, `${rel(markerFile)} marker "${own}"`);
        define(markers, id, { id, lnglat: m.lnglat, icon: name, color: m.color ? s.fam(m.color) : null, image: m.image ? resolveImage(s, m.image, rel(markerFile)) : null,
          label: s.T(m.label, `markers.${own}.label`, { shared: true }), note: m.note ? s.T(m.note, `markers.${own}.note`) : emptyText(langs) }, rel(markerFile), 'marker', dir);
      });
    });
    if (exists(path.join(dir, 'images.yaml'))) attempt(dir, () => fail(rel(path.join(dir, 'images.yaml')), 'images live in image folders, content/<story>/shared/images/<name>-<six hex digits>/, and harita image <file> <name> makes one'));
  };

  // --- pages/ is a tree: a folder with page.yaml is a page, one with include.yaml places a battle's pages, any other
  // folder is a header for what it holds ---
  const includes = [];
  const walk = (dir, s) => listDirs(dir).map(name => {
    const full = path.join(dir, name), id = idOf(name);
    if (exists(path.join(full, 'page.yaml')) && exists(path.join(full, 'include.yaml'))) return attempt(full, () => fail(rel(full), 'holds page.yaml and include.yaml, keep one: a folder is a page or the place of a battle'));
    if (exists(path.join(full, 'page.yaml'))) { pageIdOf.set(full, s.pageId(id)); return { type: 'page', id: s.pageId(id), dir: full, scope: s }; }
    if (exists(path.join(full, 'include.yaml'))) return attempt(full, () => s.battle ? fail(rel(path.join(full, 'include.yaml')), 'a battle includes no other battle, the story includes each battle it shows') : include(full));
    const g = exists(path.join(full, 'group.yaml')) ? attempt(full, () => readYaml(path.join(full, 'group.yaml'), Group)) ?? {} : {};
    return { type: 'group', id, title: s.T(g.title ?? id, `groups.${id}.title`), children: walk(full, s) };
  }).filter(Boolean);
  const pagesIn = nodes => nodes.flatMap(n => n.type === 'page' ? [n] : pagesIn(n.children));
  const include = dir => {
    const file = path.join(dir, 'include.yaml'), at = rel(file);
    const extra = fs.readdirSync(dir).filter(f => f !== 'include.yaml' && !f.startsWith('.')); // .DS_Store and the like
    if (extra.length) fail(rel(dir), `an include folder holds include.yaml alone, move ${extra.join(', ')} into the battle's folder or a page`);
    const inc = readYaml(file, Include);
    if (includes.some(i => i.battle === inc.battle)) fail(at, `battle "${inc.battle}" is included twice, a story includes a battle once`);
    const b = useBattle(inc.battle, at);
    if (!b) return null;
    if (!pagesIn(b.tree).length) fail(at, `battle "${inc.battle}" has no pages to include, a page that writes battle: ${inc.battle} shows its card`);
    includes.push({ ...inc, dir, file: at });
    b.include = { zones: inc.zones, markers: inc.markers, dir: rel(dir) };
    // one page stands alone, more go under a header with the battle's name
    return b.tree.length === 1 && b.tree[0].type === 'page' ? b.tree[0] : { type: 'group', id: b.id, title: battles[b.id].name, children: b.tree };
  };

  // --- battles: a folder each, in this story's shared/battles/ or in content/shared/battles/ for every story ---
  const battleCtx = {};
  const useBattle = (id, at) => {
    if (id in battleCtx) return battleCtx[id];
    battleCtx[id] = null; // a battle that does not read reports once
    return battleCtx[id] = loadBattle(id, at);
  };
  // the whole folder, pages included, also for a story that shows the card alone: its catalogues keep every key
  function loadBattle(id, at) {
    const ownLib = path.join(shared, 'battles'), commonLib = path.join(p.content, 'shared', 'battles');
    const own = battleLib(ownLib).get(id), found = [own, battleLib(commonLib).get(id)].filter(Boolean);
    if (found.length > 1) fail(at, `battle "${id}" is in both ${rel(found[0])} and ${rel(found[1])}, keep one`);
    const dir = found[0] ?? fail(at, `unknown battle "${id}", add ${rel(path.join(ownLib, id))}/battle.yaml or ${rel(path.join(commonLib, id))}/battle.yaml`);
    const file = path.join(dir, 'battle.yaml');
    if (!exists(file)) fail(rel(dir), 'battle.yaml is missing');
    const b = readYaml(file, Battle);
    const t = translator({ langs, defaultLang: b.default_language, catalogues: loadCatalogues(path.join(dir, 'i18n'), langs, p.loadYaml), where: rel(file), fail });
    const s = { battle: id, T: t.tr, defaultLang: b.default_language, families: b.families, ns: x => `${id}/${x}`, fam: f => `${id}_${f}`,
      pageId: x => `${id}-${x}`, maxZoom: Math.max(story.max_zoom, b.max_zoom ?? 0), fallbacks: {},
      // a story's own battle sees the story's image folders, a shared battle the shared ones alone
      imageDirs: dir === own ? [storyImages, commonImages] : [commonImages] };
    for (const [f, c] of Object.entries(b.families)) {
      const sf = storyFamily(f);
      if (!sf) warnings.push(`battle "${id}" draws "${f}" in its own colour, give a family in ${rel(storyFile)} the id or alias "${f}" to use the story's`);
      const { color, color_dark } = sf ? story.families[sf] : c;
      families[s.fam(f)] = color_dark ? { color, color_dark } : { color };
    }
    const sides = b.sides.map((side, i) => {
      const hex = side.color?.startsWith('#'), known = !side.color || hex || b.families[side.color];
      if (!known) attempt(dir, () => fail(rel(file), `side ${i + 1} uses "${side.color}", which is not in the battle's families`));
      const k = `battle.sides.${i}`;
      return { name: s.T(side.name, `${k}.name`), color: !known || !side.color ? null : hex ? side.color : s.fam(side.color), commanders: side.commanders.map((c, j) => s.T(c, `${k}.commanders.${j}`, { shared: true })),
        strength: side.strength ? s.T(side.strength, `${k}.strength`) : null, casualties: side.casualties ? s.T(side.casualties, `${k}.casualties`) : null };
    });
    battles[id] = { id, lnglat: b.lnglat, name: s.T(b.name, 'battle.name'), date: s.T(b.date, 'battle.date'), result: b.result ? s.T(b.result, 'battle.result') : null,
      sides, images: [], source: b.source ?? null, front: b.front ?? null };
    for (const f of fs.readdirSync(dir, { recursive: true })) if (['zones', 'zones.yaml'].includes(path.basename(f))) attempt(dir, () => fail(rel(path.join(dir, f)), 'a battle holds no zones, the story that includes it shows its own with zones in include.yaml'));
    const tree = walk(path.join(dir, 'pages'), s), nodes = pagesIn(tree);
    let done = false;
    const ctx = { id, dir: rel(dir), defaultLang: s.defaultLang, tree, pages: {}, translator: t, fallbacks: s.fallbacks, include: null,
      // the battle's files, read where the battle sits in the story, so problems come in reading order
      read() {
        if (done) return ctx;
        done = true;
        // a battle the story only names keeps its pages' texts to itself, so a story page of the same id keeps its own
        Object.assign(s, ctx.include ? { texts, firstImages } : { texts: {}, firstImages: {} });
        defineIn(dir, s);
        for (const n of nodes) defineIn(n.dir, s);
        battles[id].images = b.images.map(ref => attempt(dir, () => resolveImage(s, ref, rel(file)))).filter(Boolean);
        for (const n of nodes) ctx.pages[n.id] = attempt(n.dir, () => readPage(n.dir, s));
        for (const [lang, ids] of Object.entries(s.fallbacks)) warnings.push(`battle "${id}" has no ${lang} text on ${ids.join(', ')}, they show the ${s.defaultLang} text`);
        return ctx;
      } };
    return ctx;
  }

  // --- pages ---
  const figure = (id, lang) => {
    const im = images[id];
    return `<figure><img src="${esc(im.src)}" alt="${esc(im.caption[lang])}" data-img="${esc(id)}"><figcaption>${esc(im.caption[lang])}<small>${esc(im.credit[lang])}</small></figcaption></figure>`;
  };
  // per page and language: the Markdown source, and the first image the text shows, for the static pages
  function readPage(dir, s) {
    const file = path.join(dir, 'page.yaml'), at = rel(file), own = idOf(path.basename(dir)), pid = s.pageId(own);
    const pg = readYaml(file, Page);
    const texts = s.texts[pid] = {}, firstImages = s.firstImages[pid] = {};
    const need = (ok, msg) => attempt(dir, () => ok || fail(at, msg));
    if (s.battle && pg.zones.length) need(false, 'a battle page has no zones, the story that includes the battle shows its own with zones in include.yaml');
    for (const z of pg.zones) attempt(dir, () => resolveZone(z, at));
    for (const r of pg.routes) need(routes[s.ns(r)], `unknown route "${r}"`);
    for (const m of pg.markers) need(markers[s.ns(m)], `unknown marker "${m}"`);
    let battle = null;
    if (s.battle) {
      if (typeof pg.battle === 'string') need(false, 'a battle page opens its own card with battle: true');
      else if (pg.battle) battle = s.battle;
    } else if (pg.battle === true) need(false, "battle: true opens the card on a battle's own page, a story page names the battle: battle: <id>");
    else if (pg.battle) { attempt(dir, () => useBattle(pg.battle, at)); battle = battles[pg.battle] ? pg.battle : null; }
    const w = pg.when == null ? null : typeof pg.when === 'string' ? { from: pg.when } : pg.when;
    const when = w && { from: whenEdge(w.from, false), to: whenEdge(w.to ?? w.from, true) };
    if (when) need(when.to >= when.from, 'when.to is before when.from');
    const textOf = lang => { const f = path.join(dir, 'text', lang + '.md'); return exists(f) ? [f, fs.readFileSync(f, 'utf8')] : null; };
    const html = {};
    for (const lang of langs) attempt(dir, () => {
      // a battle page without a text in this language shows its default language text
      let found = textOf(lang), fallback = false;
      if (!found && s.battle && lang !== s.defaultLang) {
        found = textOf(s.defaultLang);
        if (!found) fail(rel(dir), `text/${s.defaultLang}.md is missing`);
        fallback = true; (s.fallbacks[lang] ??= []).push(pid);
      }
      if (!found) fail(rel(dir), `text/${lang}.md is missing`);
      const [textFile, source] = found;
      // the image ids become the bundle's, so the Markdown export and og:image find a battle's images
      texts[lang] = source.replace(/^(@image\s+)(\S+)(\s*)$/gm, (_, head, imgId, tail) => {
        const id = resolveImage(s, imgId, rel(textFile));
        firstImages[lang] ??= id;
        return head + id + tail;
      });
      const md = texts[lang].replace(/^@image\s+(\S+)\s*$/gm, (_, imgId) => `\n${figure(imgId, lang)}\n`);
      const out = marked.parse(ordinals(md));
      html[lang] = fallback ? `<div lang="${s.defaultLang}" dir="${textDir(s.defaultLang)}">${out}</div>` : out;
    });
    const camera = pg.camera ?? null;
    const sourceTexts = pg.sources.map((x, i) => s.T(x, `pages.${own}.sources.${i}`, { shared: true }));
    const sources = Object.fromEntries(langs.map(l => [l, sourceTexts.map(x => x[l])]));
    const mapSourceTexts = pg.map_sources.map((x, i) => s.T(x.text, `pages.${own}.map_sources.${i}`, { shared: true }));
    const mapSources = Object.fromEntries(langs.map(l => [l, pg.map_sources.map((x, i) => ({ text: mapSourceTexts[i][l], url: x.url ?? null }))]));
    const emblem = pg.emblem ? attempt(dir, () => emblemFor(root, pg.emblem, `${at} emblem`, { families: s.families, fam: s.fam, T: s.T, pid: own })) : null;
    return { id: pid, dir: rel(dir), when, date: s.T(pg.date, `pages.${own}.date`), title: s.T(pg.title, `pages.${own}.title`),
      bbox: pg.bbox, camera, maxZoom: s.maxZoom, zones: pg.zones, routes: pg.routes.map(s.ns), markers: pg.markers.map(s.ns), battle, html, sources, mapSources,
      emblem: emblem?.fc ?? null, emblemNames: emblem?.names ?? {} };
  }

  // the story's pages and the pages of the battles it includes, in reading order
  const tree = walk(path.join(storyDir, 'pages'), storyScope), nodes = pagesIn(tree);
  if (!nodes.length) fail(where, 'no pages');
  const storyDirs = [shared, ...nodes.filter(n => n.scope === storyScope).map(n => n.dir)];
  for (const dir of storyDirs) if (exists(path.join(dir, 'battles.yaml')))
    fail(rel(path.join(dir, 'battles.yaml')), 'battles live in folders now, one per battle: content/<story>/shared/battles/<id>/battle.yaml, or content/shared/battles/<id>/battle.yaml for a battle several stories share');
  for (const dir of storyDirs) defineIn(dir, storyScope);
  // zones.yaml entries once every zone file is read, since an entry may take the outline of one read later
  for (const u of zoneUses) attempt(u.dir, () => useZone(u));
  for (const inc of includes) attempt(inc.dir, () => {
    for (const z of inc.zones) resolveZone(z, inc.file);
    for (const m of inc.markers) if (!markers[m]) fail(inc.file, `unknown marker "${m}"`);
  });
  const pages = nodes.map(n => {
    if (n.scope === storyScope) return attempt(n.dir, () => readPage(n.dir, storyScope));
    const b = battleCtx[n.scope.battle].read(), pg = b.pages[n.id];
    // an included battle's page shows the zones and markers of include.yaml, then its own markers
    return pg && { ...pg, zones: b.include.zones, markers: [...b.include.markers, ...pg.markers], include: b.include.dir };
  }).filter(Boolean);
  const battleList = Object.values(battleCtx).filter(Boolean);
  for (const b of battleList) b.read(); // a battle the story only names: its files are checked, and its catalogues keep every key
  const coverImage = story.cover ? attempt(storyDir, () => resolveImage(storyScope, story.cover, `${rel(storyFile)} cover`)) ?? null : null;
  // the bundle and dist/ hold what the pages show: their routes and markers, and the images of their texts, markers
  // and battle cards
  const shownRoutes = new Set(pages.flatMap(pg => pg.routes)), shownMarkers = new Set(pages.flatMap(pg => pg.markers));
  const shownImages = new Set([...pages.flatMap(pg => [...langs.flatMap(l => [...(texts[pg.id]?.[l] ?? '').matchAll(/^@image\s+(\S+)\s*$/gm)].map(m => m[1])), ...(pg.battle ? battles[pg.battle]?.images ?? [] : [])]),
    ...[...shownMarkers].map(m => markers[m]?.image).filter(Boolean), ...(coverImage ? [coverImage] : [])]);
  for (const [table, shown] of [[routes, shownRoutes], [markers, shownMarkers], [images, shownImages]]) for (const id of Object.keys(table)) if (!shown.has(id)) delete table[id];
  // --strict holds each original on this machine to the sha256 its image.yaml records, which names its objects
  const shipped = Object.values(folderImages).filter(f => shownImages.has(f.id));
  if (p.strict) for (const f of shipped) if (f.file && f.sha256 !== sha256(f.file)) fail(f.meta, `${path.basename(f.file)} changed after its sha256 was written, harita rehash writes the new one`);
  for (let i = 1; i < pages.length; i++) attempt(path.join(root, pages[i].dir), () => {
    if (pages.find((q, j) => j < i && q.id === pages[i].id)) fail(where, `two pages share the id "${pages[i].id}"`);
    const prev = pages.slice(0, i).reverse().find(q => q.when);
    if (!prev || !pages[i].when || pages[i].when.from >= prev.when.from) return;
    // a battle moves by its include folder, since the numbers in its own folder count in every story
    const moved = pages[i].include !== prev.include ? pages[i].include ?? prev.include : null;
    fail(where, `${pages[i].dir} starts ${pages[i].when.from}, before ${prev.dir} which starts ${prev.when.from}; ${moved ? `renumber ${moved} to move the battle` : 'fix the folder numbers or the when fields'}`);
  });
  // A family is one state, so a page shows each family in one zone: two states of one family read as one state divided.
  // check reports it, the build warns, and with --strict the build stops. A set of zones is named once, at its first page.
  const named = new Set();
  for (const pg of pages) {
    const byFamily = {};
    for (const z of pg.zones) if (zones[z]) (byFamily[zones[z].family] ??= []).push(z);
    for (const [f, zs] of Object.entries(byFamily)) {
      const at = pg.include ?? pg.dir, key = f + ' ' + [...zs].sort().join(' ');
      if (zs.length < 2 || named.has(key)) continue;
      named.add(key);
      const msg = `${at}: family "${f}" has ${zs.length} zones on this page, ${zs.join(', ')}. A family is one state: give each state a family `
        + 'of its own, and draw a state that shows as two zones as one zone';
      if (onProblem) onProblem(path.join(root, at), msg, pg.id); else if (p.strict) fail(at, msg.slice(at.length + 2)); else warnings.push(msg);
    }
  }
  return { story, langs, defaultLang, T, entries, translations: report, tree, zones, routes, markers, battles, images, icons, pages, texts, firstImages, families, warnings, battleList,
    imageFolders: Object.values(folderImages), shippedImages: shipped, zoneFolders: Object.values(zoneFolders), coverImage };
}

// The objects a story links to: its images with their keys and where their originals are, its elevation tiles as
// "z/x/y", and the hash tree of both, under the story's folder name.
function storyObjects(name, { story, pages, shippedImages }) {
  const plan = terrainPlan(story.extent, pages.map(pg => ({ bbox: pg.bbox, maxZoom: pg.maxZoom })));
  const images = shippedImages.map(f => ({ id: f.id, dir: f.dir.split(path.sep).join('/'), keys: f.keys, file: f.file, url: f.url, sha256: f.sha256 }));
  const tiles = tileKeys([plan]);
  return { plan, images, tiles, tree: storyTree(name, images, tiles) };
}

function buildStory(p, storyDir, site) {
  const { log, root } = p;
  const where = p.rel(storyDir);
  const content = readContent(p, storyDir);
  const { story, langs, defaultLang, T, entries, translations, tree, zones: rawZones, routes, markers, battles, images, icons, pages, texts, firstImages, families, warnings, battleList, imageFolders, shippedImages, zoneFolders, coverImage } = content;
  for (const w of warnings) log(`  warning: ${w}`);
  const ui = uiFor(langs, root);
  const { tr: siteT } = translator({ langs, defaultLang: site.default_language ?? defaultLang, catalogues: loadCatalogues(path.join(root, 'i18n'), langs, p.loadYaml), where: 'i18n', fail });
  if (story.theme && !site.themes[story.theme]) fail(where, `unknown theme "${story.theme}"`);
  // the story is written to a fresh folder and swapped in once it built, so a failed build keeps the last good one
  // and a page that went leaves no file behind
  const final = path.join(p.dist, story.id), out = path.join(p.dist, `.${story.id}.next`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // with --local-assets each original here is copied to dist/assets/<key>, once for every story that shows it
  const localKeys = [];
  if (p.local) for (const f of shippedImages.filter(f => f.file)) {
    copyFresh(f.file, path.join(p.dist, 'assets', f.keys.original));
    localKeys.push(f.keys.original);
  }
  const objects = storyObjects(path.basename(storyDir), content);

  // --- borders and land ---
  // borders are cut to the extent plus a margin, so a country with a long coastline elsewhere stays out of the bundle
  const [ew, es, ee, en] = story.extent, margin = 5;
  const clipBox = [Math.max(-180, ew - margin), Math.max(-90, es - margin), Math.min(180, ee + margin), Math.min(90, en + margin)];
  // bboxClip leaves an empty polygon for every piece outside the box, which the geometry library refuses
  const clip = f => { const g = turf.bboxClip(f, clipBox).geometry, polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).filter(p => p.length && p[0].length >= 4); return polys.length === 1 ? turf.polygon(polys[0]).geometry : turf.multiPolygon(polys).geometry; };
  const countries = world().filter(f => story.countries.includes(f.properties.name))
    .map(f => ({ type: 'Feature', id: f.id, properties: { name: f.properties.name }, geometry: clip(f) }));
  for (const n of story.countries) if (!countries.find(f => f.properties.name === n)) fail(where, `country "${n}" not in Natural Earth`);
  for (const f of countries) if (!f.geometry.coordinates.length) fail(where, `country "${f.properties.name}" lies outside the extent`);
  const landParts = story.land.map(n => countries.find(f => f.properties.name === n) || fail(where, `land "${n}" is not in countries`));
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
  for (const pg of pages) for (const f of pg.emblem?.features ?? []) if (f.properties.land) {
    const pt = f.geometry.coordinates[0][0];
    const { c } = countries.reduce((best, c) => { const d = turf.pointToPolygonDistance(pt, c); return d < best.d ? { c, d } : best; }, { d: Infinity });
    f.properties.tint = tintOf[c.properties.name];
  }

  // --- country labels: one point per country at the pole of inaccessibility of its largest visible piece ---
  // The text per language is the override from story.yaml, else the Natural Earth name. rank orders collisions, big first.
  let labels = null;
  if (story.labels?.countries) {
    for (const n of [...Object.keys(story.labels.names), ...story.labels.hide]) if (!story.countries.includes(n)) fail(where, `labels name "${n}" is not in countries`);
    labels = countries.filter(f => !story.labels.hide.includes(f.properties.name)).map(f => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const biggest = polys.map(c => turf.polygon(c)).sort((a, b) => turf.area(b) - turf.area(a))[0];
      const [x, y] = polylabel(biggest.geometry.coordinates, 0.01);
      const text = story.labels.names[f.properties.name] ? T(story.labels.names[f.properties.name], `labels.${f.properties.name}`) : Object.fromEntries(langs.map(l => [l, f.properties.name]));
      return { type: 'Feature', properties: { ...text, rank: -Math.round(km2(f)) }, geometry: { type: 'Point', coordinates: [+x.toFixed(3), +y.toFixed(3)] } };
    });
  }

  // each zone is clipped to the land, or to the countries its clip names
  for (const z of Object.values(rawZones)) {
    const parts = (z.clipNames ?? []).map(n => countries.find(f => f.properties.name === n));
    z.clip = !parts.length ? land : parts.length > 1 ? turf.union(turf.featureCollection(parts)) : parts[0];
  }

  // --- clean zones: trim by family priority, round the shared boundaries once, clip to land, validate ---
  // zones only trim and overlap check against zones that share a page with them, so a 1915 beachhead
  // never cuts a hole in a 1919 occupation zone
  const pageZones = pages.map(pg => pg.zones);
  const pairs = new Set(pageZones.flatMap(zs => zs.flatMap(a => zs.map(b => a + ' ' + b))));
  const together = (a, b) => pairs.has(a + ' ' + b);
  const prio = f => story.families[f].priority;
  const ordered = Object.values(rawZones).sort((a, b) => prio(a.family) - prio(b.family));
  // the cleaned shapes follow from these inputs alone, so a build that leaves them as they were reads the cache
  const zoneKey = hash({ code: GEOMETRY_CODE, extent: story.extent, land: story.land, smoothing: story.smoothing, pages: pageZones,
    prio: Object.fromEntries(Object.keys(story.families).map(f => [f, prio(f)])), zones: ordered.map(z => [z.id, z.family, z.clipNames, z.geometry]) });
  const zoneFile = path.join(p.cache, 'stories', path.basename(storyDir), 'zones.json');
  const cached = readCache(zoneFile);
  let shapes, zoneLines;
  if (cached?.key === zoneKey) {
    ({ shapes, lines: zoneLines } = cached);
    for (const l of zoneLines) log(l);
  } else {
    ({ shapes, lines: zoneLines } = cleanZones({ ordered, prio, together, smoothing: story.smoothing, where, log }));
    writeCache(zoneFile, { key: zoneKey, shapes, lines: zoneLines });
  }
  const zones = Object.fromEntries(ordered.map(z => [z.id, { ...z, feature: shapes[z.id] }]));
  // the closest view each zone opens at sets the detail its outline keeps
  const zoneZoom = {};
  for (const pg of pages) for (const z of pg.zones) zoneZoom[z] = Math.max(zoneZoom[z] ?? 0, openZoom(pg.bbox));

  // --- families shown on the same page must differ in colour or in pattern ---
  for (const f of alikePairs(story.families, pages.map(p => ({ dir: p.dir, families: [...new Set(p.zones.map(z => zones[z].family))] })))) log(`  warning: ${describe(f)}`);
  const pageIndex = Object.fromEntries(pages.map((p, i) => [p.id, i]));
  const navTree = nodes => nodes.map(n => n.type === 'page' ? { type: 'page', index: pageIndex[n.id] } : { type: 'group', id: n.id, title: n.title, children: navTree(n.children) });

  // --- the cover on the site index, an image the story can show ---
  const cover = coverImage ? images[coverImage].src : null;
  const coverLinks = coverImage ? shippedImages.find(f => f.id === coverImage).links : null;
  // the paths harita 0.4 served each image at, from the site root, to its original: dist/redirects.json
  const redirects = {};
  for (const f of shippedImages) {
    const ext = path.extname(f.keys.original), to = /^[a-z]+:/i.test(f.links.original) ? f.links.original : '/' + f.links.original;
    redirects[`/images/${f.id}${ext}`] = to; redirects[`/${story.id}/images/${f.id}${ext}`] = to;
  }

  // --- elevation: the tiles this story needs, in the store or with --local-assets copied to dist/assets/ ---
  const terrain = { tiles: p.tileLink(tileKey('{z}/{x}/{y}')), ...objects.plan };

  // span is story.span, else the years from the pages' when fields, else the first page's date
  const dated = pages.filter(p => p.when);
  const years = dated.length ? [...new Set([dated[0].when.from.slice(0, 4), dated[dated.length - 1].when.to.slice(0, 4)])].join(' – ') : null;
  const span = story.span ? T(story.span, 'story.span') : Object.fromEntries(langs.map(l => [l, years ?? pages[0].date[l]]));
  const summary = story.summary ? T(story.summary, 'story.summary') : {};

  // --- bundle and pages ---
  const bundle = {
    id: story.id, title: T(story.title, 'story.title'), summary, span, cover, languages: langs, defaultLanguage: defaultLang,
    extent: story.extent, maxZoom: story.max_zoom, camera: Camera.parse({}), ui, families,
    site: { title: siteT(site.title, 'site.title'), languages: site.langs, defaultLanguage: site.defaultLang,
      source: site.repository ? `${site.repository.replace(/\/$/, '')}/tree/${site.branch}/${where.split(path.sep).join('/')}` : null },
    themes: themeList(site.themes, ui, langs), defaultTheme: story.theme ?? site.theme,
    topo, land: { type: 'Feature', properties: {}, geometry: land.geometry }, terrain, labels,
    zones: Object.fromEntries(Object.values(zones).map(z => [z.id, { family: z.family, name: z.name, area: Math.round(km2(z.feature)) }])),
    zoneShapes: packZones(shapes, zoneZoom),
    routes, markers, battles, images, icons, pages: pages.map(({ dir, include, ...p }) => p), tree: navTree(tree),
  };
  const familyCss = Object.entries(families).map(([f, c]) => `--z-${f}:${c.color};`).join('');
  const familyCssDark = Object.entries(families).map(([f, c]) => `--z-${f}:${c.color_dark ?? c.color};`).join('');
  const shell = APP.replace('/*__FAMILY_CSS__*/', () => familyCss).replaceAll('/*__FAMILY_CSS_DARK__*/', () => familyCssDark)
    .replace('/*__THEMES_CSS__*/', () => themeCss(site.themes, bundle.defaultTheme));
  const storyJs = `const BUNDLE = ${JSON.stringify(bundle)};\n`;
  writeFile(path.join(out, 'story.js'), storyJs);
  const links = Object.fromEntries(shippedImages.map(f => [f.id, f.links]));
  const files = storyFiles({ shell, bundle, texts, firstImages, links, coverImage, site: site.context, versions: { story: version(storyJs), app: version(APP_JS) } });
  for (const [f, text] of Object.entries(files)) writeFile(path.join(out, f), text);
  log(`  wrote dist/${story.id}/ (story.js ${(Buffer.byteLength(storyJs) / 1e6).toFixed(1)} MB, ${pages.length} pages in ${langs.join('/')})`);

  // translation coverage per catalogue and language, and with --strict a gap stops the build
  const covered = (label, lang, total, missing, at, extra = '') => {
    log(`  ${label}${lang}: ${total - missing.length} of ${total} strings translated${missing.length ? `, ${missing.length} missing (harita i18n ${lang})` : ''}${extra}`);
    if (p.strict && missing.length) fail(at, `${lang}: ${missing.length} strings missing, first: ${missing.slice(0, 8).join(', ')}`);
  };
  for (const [lang, r] of Object.entries(translations())) covered('', lang, r.total, r.missing, where);
  // a battle page without a text in the language counts as a gap too
  for (const b of battleList) for (const [lang, r] of Object.entries(b.translator.report())) {
    const noText = b.fallbacks[lang] ?? [];
    covered(`battle ${b.id} `, lang, r.total, r.missing, b.dir, noText.length ? `, ${noText.length} pages without text/${lang}.md` : '');
    if (p.strict && noText.length) fail(b.dir, `${lang}: no text/${lang}.md on ${noText.join(', ')}`);
  }
  // the image folders the story ships and the zone folders whose names it shows count together, one line each
  for (const [label, folders] of [['image folders ', shippedImages], ['zone folders ', zoneFolders.filter(f => f.used)]]) for (const lang of langs) {
    const reports = folders.map(f => [f, f.translator.report()[lang]]).filter(([, r]) => r);
    if (reports.length) covered(label, lang, reports.reduce((n, [, r]) => n + r.total, 0), reports.flatMap(([f, r]) => r.missing.map(k => `${f.id} ${k}`)), where);
  }
  for (const lang of langs.filter(l => l !== 'en')) {
    const u = uiCatalogue(root, lang, site.themes);
    if (u.missing.length) log(`  ${lang} interface: ${u.entries.length - u.missing.length} of ${u.entries.length} strings translated, ${u.missing.length} missing (harita i18n ${lang})`);
    if (p.strict && u.missing.length) fail(where, `${lang} interface: ${u.missing.length} strings missing, first: ${u.missing.slice(0, 8).join(', ')}`);
  }
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(out, final);
  // harita i18n writes the catalogues of each battle, image and zone folder in that folder
  const folderI18n = Object.fromEntries([...battleList.map(b => [b.dir, { kind: 'battle', ...b }]), ...imageFolders.map(f => [f.dir, { kind: 'image', ...f }]), ...zoneFolders.map(f => [f.dir, { kind: 'zone', ...f }])]
    .map(([dir, f]) => [dir, { kind: f.kind, id: f.id, defaultLang: f.defaultLang, langs, entries: [...f.translator.entries.values()] }]));
  return { format: CARD_FORMAT, id: story.id, dir: where, title: bundle.title, summary, span, languages: langs, defaultLanguage: defaultLang, pages: pages.length,
    cover: coverLinks?.large ?? null, coverOg: coverLinks?.og ?? null, i18n: [...entries.values()], terrain, folderI18n, localKeys, redirects, tree: objects.tree };
}

// The names of the story folders below content/, in groups too, with each one's folder in p.storyDirs. content/shared/
// holds the battles, images and zones stories share.
function storyNames(p) {
  if (exists(path.join(p.content, 'shared', 'story.yaml'))) fail('content/shared/story.yaml', 'content/shared/ holds the battles, images and zones stories share, move this story to a folder of another name');
  if (exists(path.join(p.content, 'shared', 'battles.yaml'))) fail('content/shared/battles.yaml', 'battles live in folders now, one per battle: content/shared/battles/<id>/battle.yaml');
  try { p.storyDirs = storyFolders(p.content, p.rel); } catch (err) { fail('content/', err.message); }
  return [...p.storyDirs.keys()];
}

// The site index. site.yaml is optional: the folder name, alphabetical order and the cool theme stand in.
function buildIndex(p, cards, site) {
  const langs = site.langs, defaultLang = site.defaultLang;
  const order = site.stories ?? cards.map(c => c.id);
  for (const id of order) if (!cards.find(c => c.id === id)) fail('site.yaml', `unknown story "${id}"`);
  const { tr: T, entries, report } = translator({ langs, defaultLang, catalogues: loadCatalogues(path.join(p.root, 'i18n'), langs, p.loadYaml), where: 'i18n', fail });
  const ui = uiFor(langs, p.root);
  const data = {
    title: T(site.title, 'site.title'), intro: site.intro ? T(site.intro, 'site.intro') : {},
    languages: langs, defaultLanguage: defaultLang, ui, repository: site.repository ?? null, icons: { settings: iconSvg('settings', 'site.yaml') },
    stories: order.map(id => { const { dir, i18n, terrain, folderI18n, localKeys, redirects, tree, coverOg, ...card } = cards.find(c => c.id === id); return card; }),
    themes: themeList(site.themes, ui, langs), defaultTheme: site.theme,
  };
  for (const [lang, r] of Object.entries(report())) {
    if (r.missing.length) p.log(`site ${lang}: ${r.missing.length} of ${r.total} strings missing (harita i18n ${lang})`);
    if (p.strict && r.missing.length) fail('site.yaml', `${lang}: missing ${r.missing.join(', ')}`);
  }
  p.siteEntries = [...entries.values()];
  const css = themeCss(site.themes, site.theme);
  // the 404 page speaks every language a site or story page does
  const notFoundUi = uiFor([...new Set([...langs, ...cards.flatMap(c => c.languages)])], p.root);
  const image = order.map(id => cards.find(c => c.id === id).coverOg).find(Boolean) ?? null;
  const files = siteFiles({ shell: INDEX.replace('/*__THEMES_CSS__*/', () => css), data, image, site: site.context, common: COMMON, themeCss: css, ui: notFoundUi });
  for (const [f, text] of Object.entries(files)) writeFile(path.join(p.dist, f), text);
  p.log(`wrote dist/index.html (${data.stories.length} stories)`);
}

// The families of the zones each page shows, for harita patterns, read as the build reads the story. A page of an
// included battle counts at the folder of its include.
export function pageZoneFamilies({ root, storyDir }) {
  const { pages, zones } = readContent(project(root, () => {}), storyDir);
  return pages.map(pg => ({ dir: pg.include ?? pg.dir, families: [...new Set(pg.zones.map(z => zones[z].family))] }));
}

// Every problem in one story's content, without the geometry: the pages, their texts and emblems, and the files
// they use. pages limits the check to those page ids and to the files outside any page. Returns the problems, [] when
// there are none.
export function checkStory({ root = process.cwd(), story, pages = [], log = console.log } = {}) {
  const p = project(root, log);
  const stories = storyNames(p);
  if (!stories.includes(story)) fail('content/', `"${story}" is not a story folder, the stories are ${stories.join(', ')}`);
  const storyDir = p.storyDirs.get(story);
  // a problem outside any page, in shared/ or a battle's own files, is always in scope
  const inScope = pageId => !pages.length || pageId == null || pages.includes(pageId);
  const problems = [];
  try {
    const { tree } = readContent(p, storyDir, (dir, msg, pageId) => { if (inScope(pageId)) problems.push(msg); });
    const ids = new Set(), collect = nodes => { for (const n of nodes) n.type === 'page' ? ids.add(n.id) : collect(n.children); };
    collect(tree);
    for (const id of pages) if (!ids.has(id)) problems.push(`${p.rel(storyDir)}/pages: no page "${id}"`);
  } catch (err) { problems.push(err.message); } // story.yaml itself or an empty pages/ stops the reading
  return problems;
}

// The image files git tracks under content/, which belong in the asset store. A folder outside git has none.
function trackedImages(root) {
  try { return execFileSync('git', ['ls-files', '-z', '--', 'content'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(f => IMAGE_FILE.test(f)); }
  catch { return []; }
}

// site.yaml with the built-in themes and the defaults that stand in for what it leaves out
function readSite(p) {
  const siteFile = path.join(p.root, 'site.yaml');
  const siteMeta = exists(siteFile) ? p.readYaml(siteFile, Site) : {};
  const builtIn = check(Themes, p.loadYaml(path.join(PKG, 'src', 'themes.yaml')), 'src/themes.yaml');
  return { ...siteMeta, title: siteMeta.title ?? path.basename(p.root), theme: siteMeta.theme ?? 'cool', themes: { ...builtIn, ...(siteMeta.themes ?? {}) } };
}

// The objects each story links to and its hash tree, read as the build reads the stories, with the store of
// site.yaml. story limits it to that story folder. harita upload puts these objects in the store.
export function storyAssets({ root = process.cwd(), story = null, log = console.log } = {}) {
  const p = project(root, log), stories = storyNames(p);
  if (!stories.length) fail('content/', 'no story.yaml found, run this from a content project');
  if (story && !stories.includes(story)) fail('content/', `"${story}" is not a story folder, the stories are ${stories.join(', ')}`);
  const { assets } = readSite(p);
  if (!assets) fail('site.yaml', 'add an assets block with the url, bucket and endpoint of the store for the images and elevation tiles');
  return { assets, stories: (story ? [story] : stories).map(s => ({ story: s, ...storyObjects(s, readContent(p, p.storyDirs.get(s))) })) };
}

// Every story under root/content into root/dist, without the elevation tiles. harita i18n reads its strings.
// only names story folders to build; the others keep their last build, and their main page cards come from the cache.
// story builds that one story folder into a site of its own, its main page listing it alone. out replaces dist/.
// Pages link the images and tiles in the store of site.yaml's assets, or with localAssets copies in dist/assets/.
export function buildPages({ root = process.cwd(), log = console.log, strict = false, cache = path.join(root, '.cache', 'harita'), only = null, story = null, out = null, localAssets = false } = {}) {
  const p = project(root, log);
  p.strict = strict; p.cache = cache; p.local = localAssets;
  if (out) p.dist = path.resolve(root, out);
  const stories = storyNames(p);
  if (!stories.length) fail('content/', 'no story.yaml found, run this from a content project');
  for (const s of [...(only ?? []), ...(story ? [story] : [])]) if (!stories.includes(s)) fail('content/', `"${s}" is not a story folder, the stories are ${stories.join(', ')}`);
  if (strict) {
    const tracked = trackedImages(root);
    if (tracked.length) fail('content/', `git tracks ${tracked.length} image file${tracked.length === 1 ? '' : 's'}, which belong in the asset store: ${tracked.slice(0, 5).join(', ')}${tracked.length > 5 ? ', …' : ''}. Add the .gitignore lines for image files and git rm --cached them`);
  }
  const cardFile = s => path.join(cache, 'stories', s, 'card.json');
  // a card from the last build of the same assets mode, while that build's page is still in dist/
  const lastCard = s => { const c = readCache(cardFile(s)); return c?.format === CARD_FORMAT && c.local === localAssets && exists(path.join(p.dist, c.id, 'index.html')) ? c : null; };
  const site = readSite(p);
  if (!site.themes[site.theme]) fail('site.yaml', `unknown theme "${site.theme}"`);
  const store = site.assets?.url ?? null;
  if (!store && !localAssets) fail('site.yaml', 'add an assets block with the url, bucket and endpoint of the store for the images and elevation tiles, or build with --local-assets to show the files on this machine');
  // an image links its objects in the store, or with --local-assets its original: the copy in dist/assets/, else its
  // url, else the one in the store
  p.imageLinks = ({ keys, file, url, at }) => {
    if (!localAssets) return { original: store + keys.original, large: store + keys.large, small: store + keys.small };
    const one = file ? `assets/${keys.original}` : url ?? (store ? store + keys.original
      : fail(at, 'the original is not on this machine and image.yaml has no url, add the original to the folder or give it a url'));
    return { original: one, large: one, small: one };
  };
  p.tileLink = key => store && !localAssets ? store + key : `../assets/${key}`;
  // story ids and language codes both name folders at the top of dist/
  // building one story, another story's story.yaml that does not read yet is left out of the checks
  const storyFile = s => path.join(p.storyDirs.get(s), 'story.yaml'), meta = s => [s, p.readYaml(storyFile(s), Story)];
  const metas = stories.flatMap(s => { if (!story || s === story) return [meta(s)]; try { return [meta(s)]; } catch { return []; } });
  site.langs = site.languages ?? [...new Set(metas.flatMap(([, m]) => m.languages))];
  site.defaultLang = site.default_language ?? site.langs[0];
  const codes = new Set([...site.langs, ...metas.flatMap(([, m]) => m.languages)]);
  for (const [s, m] of metas) if (codes.has(m.id)) fail(p.rel(storyFile(s)), `the story id "${m.id}" is also a language code, and both would be the folder dist/${m.id}/, so give the story another id`);
  // dist/assets/ holds the images and tiles of a --local-assets build
  for (const [s, m] of metas) if (m.id === 'assets') fail(p.rel(storyFile(s)), `the story id "${m.id}" names the folder dist/${m.id}/ that holds the images and tiles of a --local-assets build, so give the story another id`);
  site.context = siteContext({ url: site.url, languages: site.langs, defaultLanguage: site.defaultLang });
  if (story) site.stories = [metas.find(([s]) => s === story)[1].id];
  // every build compares the zones: a pair that looks alike is a warning, and with --strict a copy stops the build
  {
    const { pairs, stale, unread } = zonePairs({ root, cache, stories: story ? [story] : only });
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
  writeFile(path.join(p.dist, 'harita.js'), APP_JS);
  const cards = [];
  for (const s of story ? [story] : stories) {
    const kept = only && !only.includes(s) && lastCard(s);
    if (kept) { cards.push(kept); continue; }
    log(`story ${s}`);
    const card = buildStory(p, p.storyDirs.get(s), site);
    const { i18n, terrain, folderI18n, tree, ...saved } = card;
    writeCache(cardFile(s), { ...saved, local: localAssets });
    cards.push(card);
  }
  buildIndex(p, cards, site);
  // the Worker and harita dev redirect the image paths of harita 0.4 to the originals, see routes.mjs
  const redirects = Object.fromEntries(cards.flatMap(c => Object.entries(c.redirects ?? {})).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  writeFile(path.join(p.dist, 'redirects.json'), JSON.stringify(redirects, null, 1) + '\n');
  // dist/ holds no objects of the store, and dist/images/ and dist/terrain/ of harita 0.4 go unless a story is named so
  const taken = new Set(metas.map(([, m]) => m.id));
  for (const d of [...(localAssets ? [] : ['assets']), 'images', 'terrain']) if (!taken.has(d)) fs.rmSync(path.join(p.dist, d), { recursive: true, force: true });
  // dist/assets/images/ keeps the originals a story in dist/ shows: the built ones, and the others from their cached cards
  const others = story ? stories.filter(s => s !== story).map(lastCard).filter(Boolean) : [];
  const imagesDir = path.join(p.dist, 'assets', 'images'), shown = new Set([...cards, ...others].flatMap(c => c.localKeys ?? []));
  for (const f of localAssets && exists(imagesDir) ? fs.readdirSync(imagesDir, { recursive: true }).sort().reverse() : []) {
    const full = path.join(imagesDir, f);
    if (fs.statSync(full).isDirectory()) { if (!fs.readdirSync(full).length) fs.rmdirSync(full); }
    else if (!shown.has(`images/${f.split(path.sep).join('/')}`)) fs.rmSync(full);
  }
  const built = cards.filter(c => c.terrain);
  // a folder several stories use has one catalogue: its keys from every story, and the languages of all of them
  const merged = {};
  for (const c of built) for (const [dir, b] of Object.entries(c.folderI18n)) {
    const into = merged[dir] ??= { kind: b.kind, id: b.id, defaultLang: b.defaultLang, langs: new Set(), entries: new Map() };
    for (const l of b.langs) into.langs.add(l);
    for (const e of b.entries) if (!into.entries.has(e.key)) into.entries.set(e.key, e);
  }
  const folders = Object.fromEntries(Object.entries(merged).map(([dir, f]) => [dir, { ...f, langs: [...f.langs], entries: [...f.entries.values()] }]));
  return { dist: p.dist, themes: site.themes, stories: cards.map(({ i18n, terrain, folderI18n, localKeys, redirects, tree, coverOg, local, ...card }) => card), i18n: { stories: Object.fromEntries(built.map(c => [c.id, { dir: c.dir, entries: c.i18n }])), site: p.siteEntries, folders },
    terrain: tileKeys(built.map(c => c.terrain)), trees: built.map(c => ({ ...c.tree, dir: c.dir })), assets: site.assets ?? null };
}

// Build every story under root/content into root/dist. Returns the dist folder and one card per story. Pages link
// the images and tiles in the asset store, and with strict the store must hold each of them. With localAssets the
// originals here and the elevation tiles are copied to dist/assets/. Tiles and each story's cleaned zones are kept in
// cache, so only the first build of an area downloads tiles, and a build that leaves a story's zones as they were
// skips their geometry.
export async function build({ root = process.cwd(), log = console.log, strict = false, cache = path.join(root, '.cache', 'harita'), elevation, only = null, story = null, out = null, localAssets = false } = {}) {
  const { terrain, trees, assets, ...r } = buildPages({ root, log, strict, cache, only, story, out, localAssets });
  if (localAssets) await terrainTiles({ keys: terrain, cache, out: path.join(r.dist, 'assets'), elevation, log });
  else if (strict) await checkStore({ url: assets.url, trees, log });
  return r;
}
