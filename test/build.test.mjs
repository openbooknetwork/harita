// Builds a copy of example/ and checks the output, then breaks the copy in the ways the build must catch.
import { test } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import * as turf from '@turf/turf';
import { build, check, i18n, image, patterns, rehash, schema, zones, describe, flat } from './_kitap.mjs';
import { cut, terrainPlan, BASE_ZOOM } from '../src/terrain.mjs';
import * as tc from 'topojson-client';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const STORY = 'content/settlement-of-iceland';
// the example's shared battle, its battle plan page, and the story's include of it
const BATTLE = 'content/shared/battles/althing-1012';
const PLAN = `${BATTLE}/pages/020-fight/page.yaml`;
const INCLUDE = `${STORY}/pages/040-althing-battle/include.yaml`;
const quiet = () => {};
function copy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  return root;
}
// a stand-in for the elevation download: the same tile everywhere, a slope from 200 m below the sea to 820 m
const terrarium = h => { const png = new PNG({ width: 256, height: 256 }); for (let k = 0; k < 256 * 256; k++) { const v = h(k % 256, k >> 8) + 32768; png.data.set([Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256), 255], k * 4); } return PNG.sync.write(png); };
const TILE = terrarium(x => x * 4 - 200);
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cache-'));
let fetched = 0;
const elevation = async () => { fetched++; return TILE; };
const make = (root, opts = {}) => build({ root, log: quiet, cache: CACHE, elevation, localAssets: true, ...opts });
const bundleOf = (root, id = 'settlement-of-iceland') => { const js = fs.readFileSync(path.join(root, 'dist', id, 'story.js'), 'utf8'); return flat(JSON.parse(js.slice('const BUNDLE = '.length, js.lastIndexOf(';')))); };
// a zone's outline, decoded from the story's zone topology
const zoneGeometry = (B, id) => tc.feature(B.zoneShapes, B.zoneShapes.objects.zones.geometries.find(g => g.id === id)).geometry;
const append = (root, file, text) => fs.appendFileSync(path.join(root, file), '\n' + text + '\n');
const edit = (root, file, from, to) => fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(root, file), 'utf8').replace(from, to));
// a language in the story, with a copy of the English text on every page, the battle's pages included
function addLanguage(root, lang, story = STORY) {
  edit(root, `${story}/story.yaml`, /languages: \[([^\]]*)\]/, (_, l) => `languages: [${l}, ${lang}]`);
  for (const dir of [path.join(root, story, 'pages'), path.join(root, BATTLE, 'pages')])
    for (const f of fs.readdirSync(dir, { recursive: true })) if (f.endsWith('en.md')) fs.copyFileSync(path.join(dir, f), path.join(dir, f.replace(/en\.md$/, `${lang}.md`)));
}
// every string of the catalogues filled in
const fillCatalogue = (root, file) => fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(root, file), 'utf8').replace(/: ""$/gm, ': "x"'));
// the key of an image's original in the store, which a --local-assets build copies to dist/assets/<key>
function originalKey(root, id) {
  const meta = fs.readdirSync(path.join(root, 'content'), { recursive: true }).find(f => f.endsWith(path.join(id, 'image.yaml')));
  const text = fs.readFileSync(path.join(root, 'content', meta), 'utf8');
  return `images/${text.match(/^sha256: (\w+)$/m)[1]}/${id}${path.extname(text.match(/^file: (\S+)$/m)[1])}`;
}
// an svg file whose bytes differ by its text, so harita image sees distinct images
const svgFile = (root, text) => { const f = path.join(root, `${text}.svg`); fs.writeFileSync(f, `<svg xmlns="http://www.w3.org/2000/svg"><title>${text}</title></svg>`); return f; };
// a battle of the story's own with a card and no pages
function skirmish(root, side = '{ name: Settlers }') {
  fs.mkdirSync(path.join(root, STORY, 'shared/battles/skirmish-900'), { recursive: true });
  fs.writeFileSync(path.join(root, STORY, 'shared/battles/skirmish-900/battle.yaml'), `lnglat: [-21.9, 64.1]\nname: A skirmish\ndate: "900"\nsides: [${side}]\n`);
}

test('build writes the site index and one page per story', async () => {
  const root = copy(), lines = [];
  const r = await make(root, { log: l => lines.push(l) });
  assert.equal(r.dist, path.join(root, 'dist'));
  assert.deepEqual(r.stories.map(s => [s.id, s.pages]), [['settlement-of-iceland', 5]]);
  const page = fs.readFileSync(path.join(root, 'dist/settlement-of-iceland/story.js'), 'utf8');
  assert.ok(page.startsWith('const BUNDLE = {"id":"settlement-of-iceland"'));
  assert.ok(page.includes('Þingvellir'));
  assert.match(fs.readFileSync(path.join(root, 'dist/settlement-of-iceland/en/landnam/index.html'), 'utf8'), /--land-0:#[0-9a-f]{6};--land-1:#[0-9a-f]{6};/);
  assert.ok(page.includes('"name":"Iceland","tint":0'));
  assert.match(page, /"labels":\[\{"type":"Feature","properties":\{"en":"Ísland","rank":-\d+\},"geometry":\{"type":"Point","coordinates":\[-1\d\.\d+,6[45]\.\d+\]/);
  assert.ok(page.includes('"emblem":{"type":"FeatureCollection","features":[{"type":"Feature"'));
  assert.ok(page.includes('"properties":{"color":"#c62828"}'));
  assert.ok(fs.existsSync(path.join(root, 'dist/assets/terrain/v1/0/0/0.png')));
  assert.ok(page.includes('"tiles":"../assets/terrain/v1/{z}/{x}/{y}.png"'));
  assert.ok(Object.values(bundleOf(root).zones).every(z => Number.isInteger(z.area) && z.area > 0), 'each zone ships its area in km2');
  const index = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  assert.ok(index.includes('const SITE = {"title":{"en":"Example histories"}'));
  const app = fs.readFileSync(path.join(root, 'dist/kitap.js'), 'utf8');
  for (const html of [app, index]) assert.ok(html.includes("const REPO = 'https://github.com/openbooknetwork/kitap';"));
  assert.ok(lines.includes('wrote dist/index.html (1 stories)'));
});

test('a misspelt key names the file and the field', async () => {
  const root = copy();
  append(root, `${STORY}/pages/010-landnam/page.yaml`, 'markres: []');
  await assert.rejects(make(root), /010-landnam\/page\.yaml:\n\s+\(root\): Unrecognized key: "markres"/);
});

test('a reference to a zone no file defines fails', async () => {
  const root = copy();
  edit(root, `${STORY}/pages/020-althing/page.yaml`, 'zones: [island]', 'zones: [mainland]');
  await assert.rejects(make(root), /020-althing\/page\.yaml: unknown zone "mainland"/);
});

test('a page dated after the page that follows it fails', async () => {
  const root = copy();
  append(root, `${STORY}/pages/020-althing/page.yaml`, 'when: 1100');
  await assert.rejects(make(root), /030-kristnitaka starts 1000-01-01, before .*020-althing which starts 1100-01-01/);
});

test('a story with a battle ships the swords icon, though no marker uses it', async () => {
  const root = copy();
  await make(root);
  assert.match(bundleOf(root).icons.swords, /^<svg/);
});

test('emblem features are coloured by family and named for the hover label', async () => {
  const root = copy(), plugin = path.join(root, 'plugins/emblems/ring.mjs');
  fs.writeFileSync(plugin, fs.readFileSync(plugin, 'utf8').replace("properties: { color }", "properties: { color, family: 'settled', id: 'ring', name: 'The Althing' }"));
  await make(root);
  const page = bundleOf(root).pages.find(p => p.emblem);
  assert.deepEqual(page.emblem.features[0].properties, { color: '#c62828', family: 'settled', id: 'ring' });
  assert.deepEqual(page.emblemNames, { ring: { en: 'The Althing' } });
});

test('land in a battle plan takes the tint of the nearest country and draws first', async () => {
  const root = copy();
  edit(root, PLAN, '  kind: battle-plan\n', '  kind: battle-plan\n  land:\n    - { area: [[-21.14, 64.25], [-21.13, 64.25], [-21.13, 64.255]] }\n');
  await make(root);
  const b = bundleOf(root), iceland = b.topo.objects.countries.geometries.find(g => g.properties.name === 'Iceland').properties.tint;
  const plan = b.pages.find(p => p.emblem?.features.some(f => f.properties.land));
  assert.deepEqual(plan.emblem.features[0].properties, { land: true, tint: iceland });
});

test('a paragraph opening with an ordinal stays a paragraph', async () => {
  const root = copy();
  fs.writeFileSync(path.join(root, `${STORY}/pages/010-landnam/text/en.md`), '21. yüzyılda the farm is a museum.\n');
  await make(root);
  const html = bundleOf(root).pages.find(p => p.id === 'landnam').html.en;
  assert.match(html, /<p>21\. yüzyılda the farm is a museum\.<\/p>/);
  assert.ok(!html.includes('<ol'));
  assert.match(fs.readFileSync(path.join(root, 'dist/settlement-of-iceland/en.md'), 'utf8'), /^21\\\. yüzyılda/m);
});

test("a story sets how close the map zooms, 11 by default, and a battle's pages zoom as close as the battle sets", async () => {
  const root = copy();
  await make(root);
  const B = bundleOf(root);
  assert.equal(B.maxZoom, 11);
  assert.deepEqual(B.pages.map(p => p.maxZoom), [11, 11, 11, 13, 13]);
  assert.equal(B.terrain.maxzoom, 14, 'the relief follows the battle plan to one zoom past the battle');
  append(root, `${STORY}/story.yaml`, 'max_zoom: 14');
  await make(root);
  assert.equal(bundleOf(root).maxZoom, 14);
  assert.deepEqual(bundleOf(root).pages.map(p => p.maxZoom), [14, 14, 14, 14, 14]);
});

test('a named emblem feature without an id fails', async () => {
  const root = copy(), plugin = path.join(root, 'plugins/emblems/ring.mjs');
  fs.writeFileSync(plugin, fs.readFileSync(plugin, 'utf8').replace("properties: { color }", "properties: { color, name: 'The Althing' }"));
  await assert.rejects(make(root), /emblem feature named "The Althing" needs an id/);
});

test('an emblem kind without a plugin file fails', async () => {
  const root = copy();
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'kind: ring', 'kind: halo');
  await assert.rejects(make(root), /030-kristnitaka\/page\.yaml emblem: unknown emblem kind "halo", add plugins\/emblems\/halo\.mjs/);
});

test('a plugin that rejects its parameters fails with its own message', async () => {
  const root = copy();
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'radius_km: 12', 'radius_km: 0');
  await assert.rejects(make(root), /ring needs center \[lon, lat\] and radius_km/);
});

test('a zone clip naming a country the story does not draw fails', async () => {
  const root = copy();
  edit(root, `${STORY}/pages/020-althing/zones/island.geojson`, '"clip": ["Iceland"]', '"clip": ["Greenland"]');
  await assert.rejects(make(root), /island\.geojson: clip country "Greenland" is not in the story's countries/);
});

test('a label override for a country the story does not draw fails', async () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'names: { Iceland:', 'names: { Greenland:');
  await assert.rejects(make(root), /labels name "Greenland" is not in countries/);
});

test('a folder without content is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-empty-'));
  await assert.rejects(make(root), /content\/: no story\.yaml found/);
});

test('patterns finds families that look alike and fixes one with a pattern', async () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'smoothing: 4', '  church: { priority: 1, color: "#2f6aa0", color_dark: "#6fa3d7" }\nsmoothing: 4');
  fs.mkdirSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones`));
  fs.writeFileSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones/church.geojson`), JSON.stringify({
    type: 'Feature', properties: { family: 'church', name: 'Church land' },
    geometry: { type: 'Polygon', coordinates: [[[-22, 64], [-21, 64], [-21, 64.5], [-22, 64.5], [-22, 64]]] },
  }));
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'zones: [island]', 'zones: [island, church]');
  const before = patterns({ root, log: quiet });
  assert.equal(before.length, 1);
  assert.equal(before[0].story, 'settlement-of-iceland');
  assert.deepEqual([before[0].a, before[0].b, before[0].fix, before[0].suggestion], ['church', 'settled', 'church', 'hatch']);
  assert.deepEqual(patterns({ root, fix: true, log: quiet }), []);
  assert.match(fs.readFileSync(path.join(root, `${STORY}/story.yaml`), 'utf8'), /church: \{ .*, pattern: hatch \}/);
  assert.deepEqual(patterns({ root, log: quiet }), []);
});

test('a place links to a marker the page shows, check lists the places named without a link, and the Markdown keeps the name', async () => {
  const root = copy(), text = `${STORY}/pages/020-althing/text/en.md`;
  await make(root);
  const html = bundleOf(root).pages.find(p => p.id === 'althing').html.en;
  assert.match(html, /<span class="place" data-marker="thingvellir" tabindex="0">Þingvellir<\/span>/);
  assert.match(fs.readFileSync(path.join(root, 'dist/settlement-of-iceland/en.md'), 'utf8'), /on the plain at Þingvellir, where/);
  const places = () => { const lines = []; check({ root, story: 'settlement-of-iceland', places: true, log: l => lines.push(l) }); return lines; };
  assert.deepEqual(places(), []);
  append(root, text, 'Chieftains rode in from Reykjavík.');
  assert.deepEqual(places(), [`${STORY}/pages/020-althing/text/en.md: Reykjavík (@reykjavik)`]);
  edit(root, text, 'from Reykjavík.', 'from [Reykjavík](@reykjavik) and [Borg](@borg).');
  assert.deepEqual(places(), []);
  assert.deepEqual(check({ root, story: 'settlement-of-iceland', log: quiet }),
    [`${STORY}/pages/020-althing/text/en.md: [Borg](@borg) links to the marker "borg", add it to the markers of page.yaml or link one the page shows`]);
});

test('a family with two zones on one page is a problem for check, a warning for the build, and --strict stops on it', async () => {
  const root = copy();
  fs.mkdirSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones`));
  fs.writeFileSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones/east.geojson`), JSON.stringify({
    type: 'Feature', properties: { family: 'settled', name: 'The east' },
    geometry: { type: 'Polygon', coordinates: [[[-16, 64], [-14, 64], [-14, 65], [-16, 65], [-16, 64]]] },
  }));
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'zones: [island]', 'zones: [island, east]');
  const problem = /030-kristnitaka: family "settled" has 2 zones on this page, island, east\. A family is one state/;
  assert.ok(check({ root, story: 'settlement-of-iceland', log: quiet }).some(l => problem.test(l)));
  const lines = [];
  await make(root, { log: l => lines.push(l) });
  assert.ok(lines.some(l => l.startsWith('  warning: ') && problem.test(l)), lines.join('\n'));
  await assert.rejects(make(root, { strict: true }), /030-kristnitaka: family "settled" has 2 zones on this page/);
});

test('a MultiPolygon zone holds a state whose land lies in parts, and each part keeps its land', async () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'smoothing: 4', '  church: { priority: -1, color: "#8a3b2f", color_dark: "#d0806f" }\nsmoothing: 4');
  fs.mkdirSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones`));
  fs.writeFileSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones/sees.geojson`), JSON.stringify({
    type: 'Feature', properties: { family: 'church', name: 'The two sees' },
    geometry: { type: 'MultiPolygon', coordinates: [[[[-21, 63.9], [-20.6, 63.9], [-20.6, 64.1], [-21, 64.1], [-21, 63.9]]],
      [[[-18.4, 65.6], [-18, 65.6], [-18, 65.8], [-18.4, 65.8], [-18.4, 65.6]]]] },
  }));
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'zones: [island]', 'zones: [island, sees]');
  await make(root);
  const g = zoneGeometry(bundleOf(root), 'sees');
  assert.equal(g.type, 'MultiPolygon');
  assert.equal(g.coordinates.length, 2);
});

test('schema fills defaults and lists every bad field at once', async () => {
  const page = schema.check(schema.PageMap, { bbox: [-25, 63, -13, 67] }, 'page.yaml');
  assert.deepEqual([page.zones, page.routes, page.markers, page.map_sources], [[], [], [], []]);
  assert.throws(() => schema.check(schema.Story, { id: 'Bad Id', title: 'x' }, 'story.yaml'), err => {
    assert.match(err.message, /^story\.yaml:\n/);
    assert.match(err.message, /\n  id: lowercase letters/);
    assert.match(err.message, /\n  languages: /);
    return true;
  });
});

test('a language harita does not ship gets an interface catalogue and counts its gaps', async () => {
  const { i18n } = await import('./_kitap.mjs');
  const root = copy();
  addLanguage(root, 'de');
  i18n({ root, lang: 'de', log: quiet });
  const ui = fs.readFileSync(path.join(root, 'i18n/ui/de.yaml'), 'utf8');
  assert.match(ui, /# Prev\nprev: ""/);
  assert.match(ui, /themes\.cool: ""/);
  const lines = [];
  await make(root, { log: l => lines.push(l) });
  assert.ok(lines.some(l => /de interface: 0 of \d+ strings translated/.test(l)));
  // with the content translated, the interface is what --strict still stops on
  fillCatalogue(root, `${STORY}/i18n/de.yaml`); fillCatalogue(root, `${BATTLE}/i18n/de.yaml`);
  await assert.rejects(make(root, { strict: true }), /de interface: \d+ strings missing/);
});

// zones meeting at one point: after rounding, no uncovered pocket at the junction and none along shared edges
async function junction(root, page, specs) {
  const dir = path.join(root, STORY, 'shared/zones');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, family, ring] of specs) fs.writeFileSync(path.join(dir, id + '.geojson'), JSON.stringify({ type: 'Feature', properties: { id, family, name: id }, geometry: { type: 'Polygon', coordinates: [ring] } }));
  edit(root, `${STORY}/pages/${page}/page.yaml`, 'zones: [island]', `zones: [${specs.map(s => s[0]).join(', ')}]`);
  await make(root);
  const B = bundleOf(root);
  return specs.map(s => zoneGeometry(B, s[0]));
}
const holes = async geoms => {
  const turf = await import('@turf/turf');
  const u = turf.union(turf.featureCollection(geoms.map(g => turf.feature(g))));
  return (u.geometry.type === 'Polygon' ? [u.geometry.coordinates] : u.geometry.coordinates).flatMap(r => r.slice(1)).length;
};
const covers = async (geoms, pt) => { const turf = await import('@turf/turf'); return geoms.some(g => turf.booleanPointInPolygon(turf.point(pt), turf.feature(g))); };

test('six zones meeting at a point keep one shared edge each after rounding', async () => {
  const root = copy(), c = [-18.5, 64.9];
  const p = k => [c[0] + 0.6 * Math.cos(k * Math.PI / 3), c[1] + 0.25 * Math.sin(k * Math.PI / 3)];
  const geoms = await junction(root, '030-kristnitaka', [0, 1, 2, 3, 4, 5].map(k => [`w${k}`, 'settled', [c, p(k), p(k + 1), c]]));
  assert.equal(geoms.length, 6);
  assert.equal(await holes(geoms), 0, 'a pocket is left between the zones');
  assert.ok(await covers(geoms, c), 'the junction itself is uncovered');
  assert.ok(await covers(geoms, [c[0] + 0.3, c[1] + 0.001]), 'a gap opened along a shared edge');
});

test('four zones of two families meeting at a point leave no gap and do not overlap', async () => {
  const root = copy(), [x, y] = [-18.5, 64.9], d = 0.05;
  edit(root, `${STORY}/story.yaml`, 'families:\n', 'families:\n  held: { priority: 1, color: "#c62828" }\n');
  const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
  // drawn the way content is drawn: each zone reaches a little past the centre into its neighbours
  const geoms = await junction(root, '030-kristnitaka', [
    ['ne', 'settled', box(x - d, y - d / 4, x + 0.6, y + 0.25)], ['sw', 'settled', box(x - 0.6, y - 0.25, x + d, y + d / 4)],
    ['nw', 'held', box(x - 0.6, y - d / 4, x + d, y + 0.25)], ['se', 'held', box(x - d, y - 0.25, x + 0.6, y + d / 4)],
  ]);
  assert.equal(await holes(geoms), 0, 'a pocket is left between the zones');
  assert.ok(await covers(geoms, [x, y]), 'the junction itself is uncovered');
});

test('a battle page has no camera of its own, the story carries the default one, and camera: false asks to go', async () => {
  const root = copy(), pages = `${STORY}/pages`;
  skirmish(root);
  append(root, `${pages}/010-landnam/page.yaml`, 'battle: skirmish-900');
  await make(root);
  assert.deepEqual(bundleOf(root).pages.map(p => p.camera), [null, null, { pitch: 55, bearing: 40, exaggeration: 2 }, null, null]);
  assert.deepEqual(bundleOf(root).camera, { pitch: 50, bearing: 0, exaggeration: 2 });
  append(root, `${pages}/010-landnam/page.yaml`, 'camera: false');
  await assert.rejects(make(root), /pages open flat until the reader picks 3D, so camera: false has no use: remove it/);
});

test('a page lists its other map sources with links, in every language', async () => {
  const root = copy();
  append(root, `${STORY}/pages/010-landnam/page.yaml`, 'map_sources:\n  - text: "Lake Þingvallavatn: © OpenStreetMap contributors"\n    url: https://www.openstreetmap.org/copyright');
  await make(root);
  const [first, second] = bundleOf(root).pages;
  assert.deepEqual(first.credits.en, [{ text: 'Lake Þingvallavatn: © OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }]);
  assert.deepEqual(Object.keys(first.credits), Object.keys(first.sources));
  assert.deepEqual(second.credits.en, []);
});

test('a language written right to left ships dir rtl, English ltr', async () => {
  const root = copy();
  addLanguage(root, 'ar');
  await make(root);
  const { ui } = bundleOf(root);
  assert.deepEqual([ui.en.dir, ui.ar.dir], ['ltr', 'rtl']);
});

test('neighbouring countries get different land tints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-tints-')), story = path.join(root, 'content/benelux');
  fs.mkdirSync(path.join(story, 'pages/010-start/text'), { recursive: true });
  fs.writeFileSync(path.join(story, 'story.yaml'), 'id: benelux\ntitle: Benelux\nlanguages: [en]\nextent: [2, 49, 8, 54]\nland: [Belgium]\ncountries: [Belgium, Netherlands, Luxembourg, Germany, France]\nfamilies: {}\n');
  fs.writeFileSync(path.join(story, 'pages/010-start/page.yaml'), 'date: "1830"\ntitle: Independence\nbbox: [2, 49, 8, 54]\n');
  fs.writeFileSync(path.join(story, 'pages/010-start/text/en.md'), 'Belgium breaks away from the Netherlands.\n');
  await make(root);
  const tint = Object.fromEntries(bundleOf(root, 'benelux').topo.objects.countries.geometries.map(g => [g.properties.name, g.properties.tint]));
  const borders = [['Belgium', 'Netherlands'], ['Belgium', 'Luxembourg'], ['Belgium', 'Germany'], ['Belgium', 'France'], ['Netherlands', 'Germany'], ['Luxembourg', 'Germany'], ['Luxembourg', 'France'], ['Germany', 'France']];
  for (const [a, b] of borders) assert.notEqual(tint[a], tint[b], `${a} and ${b} share tint ${tint[a]}`);
});

test('Russia across the antimeridian clips to its own coast in a northern extent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-north-')), story = path.join(root, 'content/north');
  fs.mkdirSync(path.join(story, 'pages/010-start/text'), { recursive: true });
  fs.writeFileSync(path.join(story, 'story.yaml'), 'id: north\ntitle: North\nlanguages: [en]\nextent: [-30, 55, 60, 71.5]\nland: [Norway, Russia]\ncountries: [Norway, Russia]\nfamilies: {}\n');
  fs.writeFileSync(path.join(story, 'pages/010-start/page.yaml'), 'date: "900"\ntitle: Start\nbbox: [-30, 55, 60, 71.5]\n');
  fs.writeFileSync(path.join(story, 'pages/010-start/text/en.md'), 'The north.\n');
  await make(root);
  const land = bundleOf(root, 'north').land;
  for (const sea of [[0, 67], [-30, 66], [38.5, 65.5]]) assert.ok(!turf.booleanPointInPolygon(sea, land), `sea at ${sea} is land`);
  for (const ground of [[37, 67.5], [50, 66.5], [10, 61]]) assert.ok(turf.booleanPointInPolygon(ground, land), `land at ${ground} is missing`);
});

test('elevation tiles keep land heights to the metre and flatten the sea', () => {
  const out = PNG.sync.read(cut(terrarium((x, y) => y < 128 ? -35.6 : 1234.4 + x / 256)));
  const at = (x, y) => { const k = (y * 256 + x) * 4; return out.data[k] * 256 + out.data[k + 1] + out.data[k + 2] / 256 - 32768; };
  assert.deepEqual([at(10, 10), at(10, 200), at(250, 200)], [0, 1234, 1235]);
});

test('relief tiles go one zoom past the map, at most to zoom 15 where the source ends', () => {
  const field = [[-71.235, 42.447, -71.225, 42.452]];
  for (const [maxZoom, top] of [[undefined, 12], [13, 14], [16, 15]]) assert.equal(terrainPlan([-72, 42, -70, 43], [{ bbox: field[0], maxZoom }]).maxzoom, top);
});

test('a page that zooms in gets elevation tiles above the base zoom, the rest of the extent does not', () => {
  const plan = terrainPlan([-25, 63, -13, 67], [{ bbox: [-25, 63, -13, 67] }, { bbox: [-21.3, 64.15, -20.9, 64.35] }]);
  const zooms = Object.keys(plan.ranges).map(Number);
  assert.equal(Math.min(...zooms), 0);
  assert.ok(plan.maxzoom > BASE_ZOOM + 1, `maxzoom ${plan.maxzoom}`);
  const [x0, y0, x1, y1] = plan.ranges[plan.maxzoom][0], n = 2 ** plan.maxzoom;
  assert.ok((x1 - x0 + 1) * (y1 - y0 + 1) < 50, 'the zoomed page asks for a small area');
  assert.ok(x0 / n * 360 - 180 > -21.5 && (x1 + 1) / n * 360 - 180 < -20.7);
  assert.match(plan.credits[0], /Natural Earth/);
  assert.ok(plan.credits.some(c => c.includes('U.S. Geological Survey')));
  assert.ok(!plan.credits.some(c => c.includes('INEGI')), 'Mexico is far from Iceland');
});

test('a page camera reaches the map, and a second build reads the tiles from the cache', async () => {
  const root = copy();
  await make(root);
  assert.deepEqual(bundleOf(root).pages.map(p => p.camera), [null, null, { pitch: 55, bearing: 40, exaggeration: 2 }, null, null]);
  const before = fetched;
  await make(root);
  assert.equal(fetched, before);
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'pitch: 55', 'pitch: 80');
  await assert.rejects(make(root), /camera\.pitch: Too big: expected number to be <=60/);
});

test('names, citations and credits show in the source language until a catalogue translates them', async () => {
  const { i18n } = await import('./_kitap.mjs');
  const root = copy();
  addLanguage(root, 'tr');
  skirmish(root, '{ name: Settlers, commanders: [Ingólfr Arnarson] }');
  append(root, `${STORY}/pages/010-landnam/page.yaml`, 'battle: skirmish-900');
  i18n({ root, lang: 'tr', log: quiet });
  const cat = path.join(root, STORY, 'i18n/tr.yaml'), text = fs.readFileSync(cat, 'utf8'), battleCat = `${STORY}/shared/battles/skirmish-900/i18n/tr.yaml`;
  assert.doesNotMatch(text, /markers\.reykjavik\.label/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, battleCat), 'utf8'), /commanders\.0/);
  fs.writeFileSync(cat, text.replace(/: ""$/gm, ': "x"') + '\nmarkers.thingvellir.label: "Thingvellir"\n');
  fillCatalogue(root, battleCat); fillCatalogue(root, `${BATTLE}/i18n/tr.yaml`);
  await make(root, { strict: true });
  const b = bundleOf(root);
  assert.equal(b.battles['skirmish-900'].sides[0].commanders[0].tr, 'Ingólfr Arnarson');
  assert.equal(b.markers.reykjavik.label.tr, 'Reykjavík');
  assert.equal(b.markers.thingvellir.label.tr, 'Thingvellir');
  // regenerating keeps the one name with its own form, at the end
  i18n({ root, lang: 'tr', log: quiet });
  assert.match(fs.readFileSync(cat, 'utf8'), /# Names, citations and credits[^\n]*\n\n# Þingvellir\nmarkers\.thingvellir\.label: "Thingvellir"/);
});

test('a build that leaves the zone inputs as they were takes the cleaned zones from the cache', async () => {
  const root = copy(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cache-'));
  await make(root, { cache });
  // a stand-in shape under the saved key shows whether the next build reads the cache
  const file = path.join(cache, 'stories/settlement-of-iceland/zones.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tiny = { type: 'Polygon', coordinates: [[[-20, 64], [-19.9, 64], [-20, 64.1], [-20, 64]]] };
  fs.writeFileSync(file, JSON.stringify({ ...saved, shapes: { ...saved.shapes, island: { type: 'Feature', properties: {}, geometry: tiny } } }));
  append(root, `${STORY}/pages/020-althing/text/en.md`, 'A text edit leaves the zones alone.');
  await make(root, { cache });
  const rounded = g => JSON.parse(JSON.stringify(g, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v));
  assert.deepEqual(rounded(zoneGeometry(bundleOf(root), 'island')), tiny);
  edit(root, `${STORY}/pages/020-althing/zones/island.geojson`, '[-13, 67]', '[-13.5, 67]');
  await make(root, { cache });
  assert.notDeepEqual(rounded(zoneGeometry(bundleOf(root), 'island')), tiny);
});

test('a zone keeps the detail of the closest page that shows it', async () => {
  const root = copy(), page = `${STORY}/pages/030-kristnitaka`;
  // an oval of 720 points inland, finer than any view needs
  const ring = [...Array(720)].map((_, k) => [-20.5 + 0.2 * Math.cos(k * Math.PI / 360), 64.3 + 0.1 * Math.sin(k * Math.PI / 360)]);
  fs.mkdirSync(path.join(root, page, 'zones'));
  fs.writeFileSync(path.join(root, page, 'zones/oval.geojson'), JSON.stringify({ type: 'Feature', properties: { family: 'settled', name: 'Oval' }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }));
  edit(root, `${page}/page.yaml`, 'zones: [island]', 'zones: [island, oval]');
  const points = () => zoneGeometry(bundleOf(root), 'oval').coordinates.flat().length;
  await make(root);
  const close = points();
  edit(root, `${page}/page.yaml`, 'bbox: [-22.5, 63.9, -19.5, 64.6]', 'bbox: [-25, 63, -13, 67]');
  await make(root);
  assert.ok(points() < close / 2, `${points()} points from afar, ${close} close up`);
});

test('only builds the named stories and keeps the others from the last build', async () => {
  const root = copy(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cache-'));
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
  await make(root, { cache });
  // a mark in the first story's page shows whether the next build writes it again
  fs.appendFileSync(path.join(root, 'dist/settlement-of-iceland/index.html'), '<!-- kept -->');
  edit(root, 'content/second-story/story.yaml', 'The Settlement of Iceland', 'A Second Story');
  const lines = [];
  const r = await make(root, { cache, only: ['second-story'], log: l => lines.push(l) });
  assert.ok(fs.readFileSync(path.join(root, 'dist/settlement-of-iceland/index.html'), 'utf8').endsWith('<!-- kept -->'));
  assert.deepEqual(lines.filter(l => l.startsWith('story ')), ['story second-story']);
  assert.deepEqual(r.stories.map(s => s.title.en), ['A Second Story', 'The Settlement of Iceland']);
  const index = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  assert.ok(index.includes('A Second Story') && index.includes('The Settlement of Iceland'));
  await assert.rejects(make(root, { cache, only: ['missing'] }), /"missing" is not a story folder, the stories are second-story, settlement-of-iceland/);
  // a card of another shape, such as the last release's, counts as no cache and the story builds again
  const card = path.join(cache, 'stories/settlement-of-iceland/card.json');
  fs.writeFileSync(card, JSON.stringify({ ...JSON.parse(fs.readFileSync(card, 'utf8')), format: 1 }));
  const again = [];
  await make(root, { cache, only: ['second-story'], log: l => again.push(l) });
  assert.deepEqual(again.filter(l => l.startsWith('story ')), ['story second-story', 'story settlement-of-iceland']);
});

// the example in three site languages, with the story in two of them and a site URL
function trilingual() {
  const root = copy();
  edit(root, 'site.yaml', 'languages: [en]', 'languages: [en, tr, de]');
  append(root, 'site.yaml', 'url: https://example.org/atlas');
  edit(root, `${STORY}/story.yaml`, 'languages: [en]', 'languages: [en, tr]');
  for (const pages of [path.join(root, STORY, 'pages'), path.join(root, BATTLE, 'pages')]) for (const d of fs.readdirSync(pages)) {
    const text = path.join(pages, d, 'text');
    if (fs.existsSync(text)) fs.writeFileSync(path.join(text, 'tr.md'), fs.readFileSync(path.join(text, 'en.md'), 'utf8') + `\nTürkçe metin ${d}.\n`);
  }
  return root;
}
const read = (root, file) => fs.readFileSync(path.join(root, 'dist', file), 'utf8');
// the dist/ file a URL of the example site names
const fileFor = url => url.replace('https://example.org/atlas/', '').replace(/\/$/, '/index.html');

test('every page gets a URL per language: main pages, story overviews and steps', async () => {
  const root = trilingual();
  await make(root);
  const story = 'settlement-of-iceland', steps = ['landnam', 'althing', 'kristnitaka', 'althing-1012-assembly', 'althing-1012-fight'];
  for (const l of ['en', 'tr', 'de']) assert.ok(fs.existsSync(path.join(root, 'dist', l, 'index.html')), `main page ${l}`);
  for (const l of ['en', 'tr']) {
    const overview = read(root, `${story}/${l}/index.html`);
    for (const s of steps) {
      assert.ok(overview.includes(`href="${l}/${s}/"`), `${l} overview links to ${s}`);
      const page = read(root, `${story}/${l}/${s}/index.html`);
      assert.ok(page.includes(`<html lang="${l}" dir="ltr">`) && page.includes('<base href="../../">'));
      assert.ok(page.includes(`const ROUTE = {"lang":"${l}","page":"${s}"};`));
      assert.equal(page.includes(`Türkçe metin`), l === 'tr', `${l} ${s} carries its own text`);
    }
  }
  assert.ok(!fs.existsSync(path.join(root, 'dist', story, 'de')));
  // the German main page sends readers to the story's default language, the Turkish one to Turkish
  assert.ok(read(root, 'de/index.html').includes(`href="${story}/en/"`));
  assert.ok(read(root, 'tr/index.html').includes(`href="${story}/tr/"`));
  assert.ok(fs.existsSync(path.join(root, 'dist/404.html')) && fs.existsSync(path.join(root, `dist/${story}/tr.md`)));
  // the same settings on every page, layout and theme, and the language beside them in the header
  for (const page of [`${story}/en/landnam/index.html`, 'en/index.html']) {
    const html = read(root, page);
    assert.ok(html.includes('<div class="group layout-group">'), page);
    assert.ok(html.indexOf('id="langpick"') < html.indexOf('id="settings"') && !html.includes('id="lang-label"'), page);
  }
  assert.equal(bundleOf(root).ui.tr.layout_left, 'Metin solda');
});

test('with a site URL each page names itself, its language versions and a short plain description', async () => {
  const root = trilingual();
  await make(root);
  const page = read(root, 'settlement-of-iceland/tr/althing/index.html');
  assert.ok(page.includes('<link rel="canonical" href="https://example.org/atlas/settlement-of-iceland/tr/althing/">'));
  assert.ok(page.includes('<title>The Althing meets at Þingvellir - The Settlement of Iceland</title>'));
  const alternates = [...page.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(alternates.map(a => a[0]), ['en', 'tr', 'x-default']);
  for (const [, url] of alternates) assert.ok(fs.existsSync(path.join(root, 'dist', fileFor(url))), url);
  const description = page.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.ok(description.length <= 160 && !description.includes('<'), description);
  assert.ok(page.includes('<meta property="og:locale" content="tr_TR">'));
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.deepEqual(ld.map(x => x['@type']), ['BreadcrumbList', 'Article']);
  assert.equal(ld[1].inLanguage, 'tr');
  // one URL per site language, then (overview + steps) per story language
  const locs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const index = locs(read(root, 'sitemap.xml'));
  const urls = index.flatMap(u => locs(read(root, u.replace('https://example.org/atlas/', ''))));
  assert.equal(urls.length, 3 + (1 + 5) * 2);
  for (const u of urls) assert.ok(fs.existsSync(path.join(root, 'dist', fileFor(u))), u);
  const llms = read(root, 'llms.txt');
  assert.ok(llms.startsWith('# Example histories\n'));
  for (const [, u] of llms.matchAll(/\]\((https:[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(root, 'dist', fileFor(u))), u);
  assert.match(read(root, 'robots.txt'), /Sitemap: https:\/\/example\.org\/atlas\/sitemap\.xml/);
});

test('without a site URL the pages carry no canonical links and the build writes no sitemap', async () => {
  const root = copy();
  await make(root);
  assert.ok(!read(root, 'settlement-of-iceland/en/althing/index.html').includes('rel="canonical"'));
  assert.ok(!fs.existsSync(path.join(root, 'dist/sitemap.xml')) && !fs.existsSync(path.join(root, 'dist/llms.txt')));
  assert.ok(read(root, 'settlement-of-iceland/en.md').startsWith('# The Settlement of Iceland\n'));
});

test('a story id equal to a language code stops the build', async () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'id: settlement-of-iceland', 'id: en');
  await assert.rejects(make(root), /the story id "en" is also a language code, and both would be the folder dist\/en\//);
});

test('a page that went leaves no page behind in dist/', async () => {
  const root = copy();
  await make(root);
  fs.renameSync(path.join(root, STORY, 'pages/030-kristnitaka'), path.join(root, STORY, 'pages/030-conversion'));
  await make(root);
  assert.ok(fs.existsSync(path.join(root, 'dist/settlement-of-iceland/en/conversion/index.html')));
  assert.ok(!fs.existsSync(path.join(root, 'dist/settlement-of-iceland/en/kristnitaka')));
});

test('a description stops at the last sentence that fits, else at a space with an ellipsis', () => {
  const s = 'The war began in c. 264 BC over Messana. ' + 'Rome and Carthage fought for Sicily for twenty-three years, '.repeat(2) + 'and Rome won.';
  assert.equal(describe('Short.'), 'Short.');
  const d = describe(s);
  assert.ok(d.length <= 160 && d.endsWith('…') && !d.includes('  '), d);
  const two = 'Rome and Carthage fought for Sicily for twenty-three years in all. ' + 'The fleets met off Mylae and Ecnomus, and Rome won both battles at sea. ' + 'Then came the long siege.';
  assert.equal(describe(two), two.slice(0, two.indexOf('sea.') + 4));
});

// --- the battle-plan emblem harita ships ---
const plan = root => bundleOf(root).pages.find(p => p.id === 'althing-1012-fight');

test('a story draws a battle plan with the emblem harita ships, and its own file replaces it', async () => {
  const root = copy();
  await make(root);
  const p = plan(root), colours = p.emblem.features.filter(f => !f.properties.hit).map(f => f.properties.family ?? f.properties.color);
  // the allies' side is the battle's family, the burners a hex colour, the river and the clash the built-in colours
  assert.ok(colours.includes('althing-1012_settled') && colours.includes('#6d4c8f') && colours.includes('#5b9bd5') && colours.includes('#f4c542'));
  assert.equal(p.emblemNames.allies.en, 'Ásgrímr Elliða-Grímsson, Kári Sölmundarson and their allies');
  fs.writeFileSync(path.join(root, 'plugins/emblems/battle-plan.mjs'), "export default () => ({ type: 'FeatureCollection', features: [] });\n");
  await make(root);
  assert.deepEqual(plan(root).emblem.features, []);
});

test('every unit type draws closed rings', async () => {
  const { default: battlePlan } = await import('../src/emblems/battle-plan.mjs');
  for (const type of schema.UNIT_TYPES) {
    const fc = battlePlan({ units: [{ side: 'neutral', type, at: [10, 45], width: 800, depth: 200, facing: 30, bow: 60, name: 'A unit' }] });
    assert.ok(fc.features.length, type);
    for (const f of fc.features) for (const ring of f.geometry.coordinates) {
      assert.ok(ring.length >= 4, `${type}: a ring of ${ring.length} points`);
      assert.deepEqual(ring[0], ring.at(-1), `${type}: an open ring`);
      assert.ok(ring.flat().every(Number.isFinite), `${type}: a coordinate that is not a number`);
    }
  }
});

test('a wagon fort draws its wagons round the ring, each a body, a board, two wheels and a chain', async () => {
  const { default: battlePlan } = await import('../src/emblems/battle-plan.mjs');
  const fc = battlePlan({ units: [{ side: 'neutral', type: 'wagon-fort', at: [10, 45], width: 400, count: 12, name: 'Wagon fort' }] });
  const pieces = fc.features.filter(f => !f.properties.hit), hit = fc.features.filter(f => f.properties.hit);
  assert.equal(pieces.length, 12 * 5);
  assert.equal(hit.length, 1);
  // the ring is 400 m along the front and 240 m deep by default
  const ys = pieces.flatMap(f => f.geometry.coordinates[0].map(([, lat]) => (lat - 45) * 110540)), xs = pieces.flatMap(f => f.geometry.coordinates[0].map(([lon]) => (lon - 10) * 111320 * Math.cos(Math.PI / 4)));
  assert.ok(Math.max(...xs) > 180 && Math.max(...xs) < 240, `east edge ${Math.max(...xs)}`);
  assert.ok(Math.max(...ys) > 100 && Math.max(...ys) < 150, `north edge ${Math.max(...ys)}`);
});

test('a gap leaves out the wagons nearest its bearing and the chains to them', async () => {
  const { default: battlePlan } = await import('../src/emblems/battle-plan.mjs');
  const fort = gaps => battlePlan({ units: [{ side: 'neutral', type: 'wagon-fort', at: [10, 45], width: 400, count: 12, facing: 90, gaps }] }).features;
  // a wagon is a body, a board and two wheels, and each chain joins two wagons
  assert.equal(fort([0]).length, 11 * 4 + 10);
  assert.equal(fort([{ bearing: 180, wagons: 3 }]).length, 9 * 4 + 8);
  // the wagons left out are the northernmost: two stand either side of the north end
  const north = feats => Math.max(...feats.flatMap(f => f.geometry.coordinates[0].map(([, lat]) => lat)));
  assert.ok(north(fort([{ bearing: 0, wagons: 2 }])) < north(fort([{ bearing: 180, wagons: 2 }])));
});

test('every arrow style draws closed rings on a casing each', async () => {
  const { default: battlePlan } = await import('../src/emblems/battle-plan.mjs');
  const drawn = arrow => battlePlan({ arrows: [{ side: 'neutral', path: [[10, 45], [10.01, 45.005], [10.02, 45.004]], ...arrow }] }).features;
  for (const style of ['solid', 'dashed', 'fire']) {
    const feats = drawn({ style }), casings = feats.filter(f => f.properties.casing);
    assert.equal(casings.length * 2, feats.length, `${style}: a piece without its casing`);
    for (const f of feats) for (const ring of f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat()) {
      assert.deepEqual(ring[0], ring.at(-1), `${style}: an open ring`);
      assert.ok(ring.flat().every(Number.isFinite), `${style}: a coordinate that is not a number`);
    }
  }
});

test('an unknown side or unit type in a battle plan fails, naming the page and the unit', async () => {
  const root = copy();
  edit(root, PLAN, 'side: "#6d4c8f"', 'side: vikings');
  await assert.rejects(make(root), /althing-1012\/pages\/020-fight\/page\.yaml emblem: battle-plan: unknown side "vikings", use a family \(settled\), neutral or a hex colour/);
  edit(root, PLAN, 'side: vikings, type: infantry', 'side: neutral, type: berserkers');
  await assert.rejects(make(root), /020-fight\/page\.yaml emblem:\n {2}units\.0\.type: /);
});

test('a trench zigzags across its line, a wall keeps to it', async () => {
  const { default: battlePlan } = await import('../src/emblems/battle-plan.mjs');
  // how far a work's outline strays north of its line, which runs due east along latitude 45, in metres
  const stray = style => Math.max(...battlePlan({ works: [{ path: [[10, 45], [10.05, 45]], width: 40, style }] }).features[0].geometry.coordinates[0].map(([, lat]) => (lat - 45) * 110540));
  assert.ok(stray('wall') <= 21, `wall ${stray('wall')}`);
  assert.ok(stray('trench') > 60, `trench ${stray('trench')}`);
});

test('check reports every problem in a story, and page ids limit it to those pages', () => {
  const root = copy(), story = 'settlement-of-iceland';
  edit(root, `${STORY}/pages/020-althing/page.yaml`, 'markers: [reykjavik, thingvellir]', 'markers: [reykjavik, hof]');
  fs.rmSync(path.join(root, STORY, 'pages/020-althing/text/en.md'));
  edit(root, PLAN, 'side: "#6d4c8f"', 'side: vikings');
  const all = check({ root, story, log: quiet });
  assert.equal(all.length, 3, all.join('\n'));
  assert.match(all[0], /020-althing\/page\.yaml: unknown marker "hof"/);
  assert.match(all[1], /020-althing: text\/en\.md is missing/);
  assert.match(all[2], /020-fight\/page\.yaml emblem: battle-plan: unknown side "vikings"/);
  assert.equal(check({ root, story, pages: ['althing-1012-fight'], log: quiet }).length, 1);
  assert.deepEqual(check({ root, story, pages: ['landnam'], log: quiet }), []);
  assert.deepEqual(check({ root, story, pages: ['nowhere'], log: quiet }), ['content/settlement-of-iceland/pages: no page "nowhere"']);
});

test('story builds one story into a site of its own, and out writes it elsewhere', async () => {
  const root = copy(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cache-'));
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
  // a half edited story elsewhere does not stop it
  edit(root, `${STORY}/pages/010-landnam/page.yaml`, 'zones: [southwest]', 'zones: [nowhere]');
  await make(root, { cache, story: 'second-story', out: 'one' });
  assert.ok(fs.existsSync(path.join(root, 'one/second-story/en/landnam/index.html')));
  assert.ok(!fs.existsSync(path.join(root, 'one/settlement-of-iceland')) && !fs.existsSync(path.join(root, 'dist')));
  const site = fs.readFileSync(path.join(root, 'one/index.html'), 'utf8');
  assert.deepEqual(JSON.parse(site.match(/const SITE = (.*);\n/)[1]).stories.map(s => s.id), ['second-story']);
  i18n({ root, lang: 'tr', story: 'second-story', log: quiet });
  assert.ok(fs.existsSync(path.join(root, 'content/second-story/i18n/tr.yaml')) && !fs.existsSync(path.join(root, 'dist')));
});

test('a story in a group folder builds, checks, translates and takes images by its folder name', async () => {
  const root = copy(), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cache-')), nested = 'content/north/isles/second-story';
  fs.cpSync(path.join(root, STORY), path.join(root, nested), { recursive: true });
  edit(root, `${nested}/story.yaml`, 'id: settlement-of-iceland', 'id: second-story');
  // a group holds other files and folders too
  fs.writeFileSync(path.join(root, 'content/north/notes.md'), 'Plans for the north.\n');
  fs.mkdirSync(path.join(root, 'content/north/drafts'));
  append(root, 'site.yaml', 'repository: https://example.org/atlas');
  await make(root, { cache });
  assert.ok(fs.existsSync(path.join(root, 'dist/second-story/en/landnam/index.html')));
  assert.equal(bundleOf(root, 'second-story').site.source, `https://example.org/atlas/tree/main/${nested}`);
  assert.deepEqual(check({ root, story: 'second-story', pages: ['nowhere'], log: quiet }), [`${nested}/pages: no page "nowhere"`]);
  i18n({ root, lang: 'tr', story: 'second-story', log: quiet });
  assert.ok(fs.existsSync(path.join(root, nested, 'i18n/tr.yaml')));
  const id = await image({ root, file: svgFile(root, 'nested'), name: 'nested', caption: 'A nested image', story: 'second-story', log: quiet });
  assert.ok(fs.existsSync(path.join(root, nested, 'shared/images', id, 'image.yaml')));
});

test('two story folders of one name fail, naming both', async () => {
  const root = copy();
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/north/settlement-of-iceland'), { recursive: true });
  await assert.rejects(make(root), /content\/north\/settlement-of-iceland and content\/settlement-of-iceland have one name, rename one/);
});

// --- battle folders: a battle's card, pages and catalogues, shared by the stories that include it ---
test('a shared battle builds in every story that includes it, and harita i18n writes its catalogue once', async () => {
  const root = copy();
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
  addLanguage(root, 'tr'); addLanguage(root, 'tr', 'content/second-story');
  fs.writeFileSync(path.join(root, BATTLE, 'markers.yaml'), 'lawrock:\n  lnglat: [-21.118, 64.259]\n  icon: landmark\n  label: Lögberg\n');
  append(root, PLAN, 'markers: [lawrock]');
  const lines = [];
  i18n({ root, lang: 'tr', log: l => lines.push(l) });
  assert.deepEqual(lines.filter(l => l.includes('althing-1012')), [`wrote ${BATTLE}/i18n/tr.yaml: 0 of 12 strings translated`]);
  await make(root);
  for (const id of ['settlement-of-iceland', 'second-story']) {
    const B = bundleOf(root, id), fight = B.pages.find(p => p.id === 'althing-1012-fight');
    // the include's story marker first, then the battle's own under the battle's id
    assert.deepEqual(fight.markers, ['thingvellir', 'althing-1012/lawrock']);
    assert.equal(B.markers['althing-1012/lawrock'].label.en, 'Lögberg');
    assert.equal(B.tree.at(-1).title.en, 'Fight at the Althing');
  }
});

test("check reports a battle's page problems beside a problem in its battle.yaml", () => {
  const root = copy();
  edit(root, `${BATTLE}/battle.yaml`, 'color: settled', 'color: allies');
  fs.rmSync(path.join(root, BATTLE, 'pages/020-fight/text/en.md'));
  const problems = check({ root, story: 'settlement-of-iceland', log: quiet });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /battle\.yaml: side 2 uses "allies"/);
  assert.match(problems[1], /020-fight: text\/en\.md is missing/);
});

test("a battle the story only names keeps its pages' texts and images out of the story", async () => {
  const root = copy();
  fs.rmSync(path.join(root, STORY, 'pages/040-althing-battle'), { recursive: true });
  // a story page with the id the battle's page has in a story that includes it
  fs.cpSync(path.join(root, STORY, 'pages/030-kristnitaka'), path.join(root, STORY, 'pages/040-althing-1012-fight'), { recursive: true });
  append(root, `${STORY}/pages/040-althing-1012-fight/page.yaml`, 'battle: althing-1012');
  const river = await image({ root, file: svgFile(root, 'oxara'), name: 'oxara', caption: 'The river', log: quiet });
  append(root, `${BATTLE}/pages/020-fight/text/en.md`, `@image ${river}`);
  await make(root);
  const B = bundleOf(root);
  assert.equal(B.pages.at(-1).id, 'althing-1012-fight');
  assert.doesNotMatch(read(root, 'settlement-of-iceland/en.md'), /Fighting broke out on the assembly plain/);
  assert.ok(!B.images[river] && !fs.existsSync(path.join(root, `dist/images/${river}.svg`)));
});

test('harita image writes the caption language of the story it is for', async () => {
  const root = copy(), svg = path.join(root, 'picture.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  edit(root, `${STORY}/story.yaml`, 'default_language: en', 'default_language: is');
  const id = await image({ root, file: svg, name: 'farm', caption: 'Bærinn', story: 'settlement-of-iceland', log: quiet });
  assert.match(fs.readFileSync(path.join(root, STORY, `shared/images/${id}/image.yaml`), 'utf8'), /^caption: Bærinn\ndefault_language: is\nfile: image\.svg\nsha256: [0-9a-f]{64}\n$/);
});

test('a story page that names a battle shows its card alone, and the catalogue keeps the battle pages', async () => {
  const root = copy();
  fs.rmSync(path.join(root, STORY, 'pages/040-althing-battle'), { recursive: true });
  append(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'battle: althing-1012');
  addLanguage(root, 'tr');
  await make(root);
  const B = bundleOf(root);
  assert.deepEqual(B.pages.map(p => [p.id, p.battle]), [['landnam', null], ['althing', null], ['kristnitaka', 'althing-1012']]);
  assert.equal(B.battles['althing-1012'].name.en, 'Fight at the Althing');
  i18n({ root, lang: 'tr', log: quiet });
  assert.match(fs.readFileSync(path.join(root, BATTLE, 'i18n/tr.yaml'), 'utf8'), /^pages\.fight\.title: ""$/m);
});

test('a battle placed out of date order names its include folder', async () => {
  const root = copy();
  fs.renameSync(path.join(root, STORY, 'pages/040-althing-battle'), path.join(root, STORY, 'pages/025-althing-battle'));
  await assert.rejects(make(root), /030-kristnitaka starts 1000-01-01, before content\/shared\/battles\/althing-1012\/pages\/020-fight which starts 1012-01-01; renumber content\/settlement-of-iceland\/pages\/025-althing-battle to move it/);
});

test('a battle colour takes the story family of its id or alias, else its own with a warning', async () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'settled: { priority: 0, color: "#2f6a9f"', 'settled: { priority: 0, color: "#123456"');
  await make(root);
  assert.deepEqual(bundleOf(root).families['althing-1012_settled'], { color: '#123456', color_dark: '#6fa3d6' });
  for (const f of [`${BATTLE}/battle.yaml`, PLAN]) edit(root, f, /\bsettled\b/g, 'kin');
  edit(root, `${STORY}/story.yaml`, 'color_dark: "#6fa3d6" }', 'color_dark: "#6fa3d6", aliases: [kin] }');
  const aliased = [];
  await make(root, { log: l => aliased.push(l) });
  assert.equal(bundleOf(root).families['althing-1012_kin'].color, '#123456');
  assert.ok(!aliased.some(l => l.includes('warning: battle')));
  edit(root, `${STORY}/story.yaml`, ', aliases: [kin]', '');
  const own = [];
  await make(root, { log: l => own.push(l) });
  const B = bundleOf(root);
  assert.equal(B.families['althing-1012_kin'].color, '#2f6a9f');
  assert.ok(own.includes(`  warning: battle "althing-1012" draws "kin" in its own colour, give a family in ${STORY}/story.yaml the id or alias "kin" to use the story's`));
  // the card's side and the plan's units carry the battle's family, which the page's colours define per theme
  assert.equal(B.battles['althing-1012'].sides[1].color, 'althing-1012_kin');
  assert.ok(plan(root).emblem.features.some(f => f.properties.family === 'althing-1012_kin'));
  assert.ok(read(root, 'settlement-of-iceland/en/landnam/index.html').includes('--z-althing-1012_kin:#2f6a9f;'));
});

test('a --local-assets build copies each original to dist/assets/<key>, which the pages, the export and og:image link', async () => {
  const root = copy();
  append(root, 'site.yaml', 'url: https://example.org/atlas');
  const own = await image({ root, file: svgFile(root, 'farm'), name: 'farm', caption: 'The story picture', story: 'settlement-of-iceland', log: quiet });
  const plain = await image({ root, file: svgFile(root, 'plain'), name: 'plain', caption: 'The battle picture', log: quiet });
  append(root, `${STORY}/pages/010-landnam/text/en.md`, `@image ${own}`);
  append(root, `${BATTLE}/pages/010-assembly/text/en.md`, `@image ${plain}`);
  append(root, `${BATTLE}/battle.yaml`, `images: [${plain}]`);
  await make(root);
  const B = bundleOf(root), site = 'https://example.org/atlas/', [ownKey, plainKey] = [own, plain].map(id => originalKey(root, id));
  assert.deepEqual([B.images[own].src, B.images[own].thumb, B.images[plain].src], [`../assets/${ownKey}`, `../assets/${ownKey}`, `../assets/${plainKey}`]);
  assert.deepEqual(B.battles['althing-1012'].images, [plain]);
  for (const key of [ownKey, plainKey]) assert.ok(fs.existsSync(path.join(root, 'dist/assets', key)), key);
  assert.ok(B.pages[3].html.en.includes(`<img src="../assets/${plainKey}"`) && B.pages[3].html.en.includes(`data-img="${plain}"`));
  const md = read(root, 'settlement-of-iceland/en.md');
  assert.ok(md.includes(`![The story picture](${site}assets/${ownKey})`) && md.includes(`![The battle picture](${site}assets/${plainKey})`));
  assert.ok(read(root, 'settlement-of-iceland/en/althing-1012-assembly/index.html').includes(`<meta property="og:image" content="${site}assets/${plainKey}">`));
});

test('harita image makes an image folder that texts, markers and battle cards share, and dist/ gets the ones in use', async () => {
  const root = copy();
  const own = await image({ root, file: svgFile(root, 'farm'), name: 'farm', caption: 'The farm', credit: 'A museum', story: 'settlement-of-iceland', log: quiet });
  const shared = await image({ root, file: svgFile(root, 'plain'), name: 'plain', caption: 'The assembly plain', log: quiet });
  const unused = await image({ root, file: svgFile(root, 'unused'), name: 'unused', caption: 'Nobody shows this', log: quiet });
  assert.match(own, /^farm-[0-9a-f]{6}$/);
  assert.ok(fs.existsSync(path.join(root, STORY, `shared/images/${own}/image.svg`)) && fs.existsSync(path.join(root, `content/shared/images/${shared}/image.yaml`)));
  append(root, `${STORY}/pages/010-landnam/text/en.md`, `@image ${own}`);
  edit(root, `${STORY}/shared/markers.yaml`, 'icon: house', `icon: house\n  image: ${own}`);
  append(root, `${BATTLE}/battle.yaml`, `images: [${shared}]`);
  append(root, `${BATTLE}/pages/020-fight/text/en.md`, `@image ${shared}`);
  addLanguage(root, 'tr');
  const lines = [];
  await make(root, { log: l => lines.push(l) });
  const B = bundleOf(root);
  const [ownKey, sharedKey, unusedKey] = [own, shared, unused].map(id => originalKey(root, id));
  assert.deepEqual(B.images[own], { id: own, src: `../assets/${ownKey}`, thumb: `../assets/${ownKey}`, caption: { en: 'The farm', tr: 'The farm' }, credit: { en: 'A museum', tr: 'A museum' } });
  assert.equal(B.markers.reykjavik.image, own);
  assert.deepEqual(B.battles['althing-1012'].images, [shared]);
  assert.ok(fs.existsSync(path.join(root, 'dist/assets', ownKey)) && fs.existsSync(path.join(root, 'dist/assets', sharedKey)));
  assert.ok(!B.images[unused] && !fs.existsSync(path.join(root, 'dist/assets', unusedKey)));
  assert.ok(lines.includes('  image folders tr: 0 of 2 strings translated, 2 missing (kitap i18n tr)'));
  i18n({ root, lang: 'tr', log: quiet });
  assert.match(fs.readFileSync(path.join(root, STORY, `shared/images/${own}/i18n/tr.yaml`), 'utf8'), /^# The farm\nimage\.caption: ""$/m);
});

test('an original ships once in dist/assets/ for every story that shows it, and goes when none does', async () => {
  const root = copy(), svg = path.join(root, 'picture.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
  const id = await image({ root, file: svg, name: 'plain', caption: 'The assembly plain', log: quiet });
  for (const s of [STORY, 'content/second-story']) append(root, `${s}/pages/010-landnam/text/en.md`, `@image ${id}`);
  await make(root);
  const key = originalKey(root, id), shipped = () => fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter(x => x.endsWith('.svg')).map(x => x.split(path.sep).join('/'));
  assert.deepEqual(shipped(), [`assets/${key}`]);
  for (const s of ['settlement-of-iceland', 'second-story']) assert.equal(bundleOf(root, s).images[id].src, `../assets/${key}`);
  for (const s of [STORY, 'content/second-story']) edit(root, `${s}/pages/010-landnam/text/en.md`, `@image ${id}`, '');
  await make(root);
  assert.deepEqual(shipped(), []);
});

test('harita image finds the image the content holds by its source or its bytes before it makes a folder', async () => {
  const root = copy(), file = svgFile(root, 'farm'), page = 'https://commons.wikimedia.org/wiki/File:Reykjav%C3%ADk%20farm.jpg';
  const first = await image({ root, file, name: 'farm', caption: 'The farm', source: page, story: 'settlement-of-iceland', log: quiet });
  const meta = fs.readFileSync(path.join(root, STORY, `shared/images/${first}/image.yaml`), 'utf8');
  assert.match(meta, new RegExp(`^source: ${page.replace(/[.?]/g, '\\$&')}\nfile: image\\.svg\nsha256: [0-9a-f]{64}\n$`, 'm'));
  // the same Commons page, written as Commons writes it, over another download of it
  assert.equal(await image({ root, file: svgFile(root, 'other'), name: 'farm', caption: 'x', source: 'https://commons.wikimedia.org/wiki/File:Reykjavík_farm.jpg', story: 'settlement-of-iceland', log: quiet }), first);
  // the same bytes without a source, from a second story: the folder moves where both stories see it
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  fs.rmSync(path.join(root, 'content/second-story/shared/images'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
  const lines = [];
  assert.equal(await image({ root, file, name: 'farm', caption: 'x', story: 'second-story', log: l => lines.push(l) }), first);
  assert.ok(fs.existsSync(path.join(root, `content/shared/images/${first}/image.svg`)) && !fs.existsSync(path.join(root, STORY, `shared/images/${first}`)));
  assert.deepEqual(lines, [`moved ${STORY}/shared/images/${first}/ to content/shared/images/${first}/, it holds the same file`, `name it as ${first}`]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'content/shared/images')), [first]);
});

test('a strict build holds each original here to its sha256, and harita rehash writes file and sha256 and drops url', async () => {
  const root = copy(), id = await image({ root, file: svgFile(root, 'farm'), name: 'farm', caption: 'The farm', story: 'settlement-of-iceland', log: quiet });
  const folder = `${STORY}/shared/images/${id}`;
  append(root, `${STORY}/pages/010-landnam/text/en.md`, `@image ${id}`);
  await make(root, { strict: true });
  fs.writeFileSync(path.join(root, folder, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>new</title></svg>');
  await assert.rejects(make(root, { strict: true }), new RegExp(`${id}/image\\.yaml: image\\.svg changed after its sha256 was written, kitap rehash writes the new one`));
  await make(root);
  edit(root, `${folder}/image.yaml`, /^file:.*\n/m, 'url: https://example.org/farm.svg\n');
  await assert.rejects(make(root), /image\.yaml:\n\s+file: /);
  assert.deepEqual(rehash({ root, log: quiet }), [folder]);
  assert.match(fs.readFileSync(path.join(root, folder, 'image.yaml'), 'utf8'), /^caption: The farm\nfile: image\.svg\nsha256: [0-9a-f]{64}\n$/);
  await make(root, { strict: true });
  assert.deepEqual(rehash({ root, log: quiet }), []);
  edit(root, `${folder}/image.yaml`, 'file: image.svg', 'file: image.png');
  await assert.rejects(make(root), /image\.yaml: file names image\.png and the folder holds image\.svg, kitap rehash writes the file it holds/);
});

test("a story's cover can name an image, and the image ships once", async () => {
  const root = copy(), svg = path.join(root, 'picture.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  const id = await image({ root, file: svg, name: 'farm', caption: 'The farm', story: 'settlement-of-iceland', log: quiet });
  append(root, `${STORY}/story.yaml`, `cover: ${id}`);
  append(root, 'site.yaml', 'url: https://example.org/atlas');
  const r = await make(root), key = originalKey(root, id);
  assert.equal(r.stories[0].cover, `assets/${key}`);
  assert.ok(read(root, 'index.html').includes(`<div class="cover"><img src="assets/${key}" alt=""></div>`));
  assert.ok(fs.existsSync(path.join(root, 'dist/assets', key)) && !fs.existsSync(path.join(root, 'dist/settlement-of-iceland/cover.svg')));
  for (const f of ['settlement-of-iceland/en/index.html', 'index.html']) assert.ok(read(root, f).includes(`<meta property="og:image" content="https://example.org/atlas/assets/${key}">`), f);
  edit(root, `${STORY}/story.yaml`, `cover: ${id}`, 'cover: nowhere-a1b2c3');
  await assert.rejects(make(root), /story\.yaml cover: unknown image "nowhere-a1b2c3"/);
});

test('an image folder used the wrong way stops the build, naming the folder', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const folder = (root, dir, files) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(root, dir, f), t); };
  const use = (root, id) => append(root, `${STORY}/pages/010-landnam/text/en.md`, `@image ${id}`);
  const cases = [
    [root => { folder(root, 'content/shared/images/farm', { 'image.svg': svg, 'image.yaml': 'caption: A farm\n' }); use(root, 'farm'); }, /content\/shared\/images\/farm: an image folder is named <name>-<six hex digits>/],
    [root => { folder(root, 'content/shared/images/farm-a1b2c3', { 'image.svg': svg }); use(root, 'farm-a1b2c3'); }, /farm-a1b2c3: image\.yaml is missing/],
    [root => { folder(root, 'content/shared/images/farm-a1b2c3', { 'image.svg': svg, 'image.png': '', 'image.yaml': 'caption: A farm\n' }); use(root, 'farm-a1b2c3'); }, /farm-a1b2c3: keep one image file of image\.png, image\.svg/],
    [root => { for (const d of ['content/shared/images/farm-a1b2c3', `${STORY}/shared/images/farm-a1b2c3`]) folder(root, d, { 'image.svg': svg, 'image.yaml': 'caption: A farm\n' }); use(root, 'farm-a1b2c3'); },
      /010-landnam\/text\/en\.md: image "farm-a1b2c3" is in content\/settlement-of-iceland\/shared\/images\/farm-a1b2c3 and content\/shared\/images\/farm-a1b2c3, keep one/],
    // every image is an image folder
    [root => append(root, `${STORY}/pages/010-landnam/page.yaml`, 'images:\n  farm: { file: farm.svg, caption: A farm }'), /010-landnam\/page\.yaml:\n  images: images live in image folders, content\/<story>\/shared\/images\/<name>-<six hex digits>\/, and kitap image <file> <name> makes one/],
    [root => fs.writeFileSync(path.join(root, STORY, 'shared/images.yaml'), 'farm: { file: farm.svg, caption: A farm }\n'), /shared\/images\.yaml: images live in image folders/],
    [root => append(root, `${STORY}/story.yaml`, 'cover: cover.jpg'), /story\.yaml:\n  cover: the id of an image folder the story can show, kitap image <file> <name> --story <story> makes one/],
    [root => { folder(root, 'content/shared/images/farm-a1b2c3', { 'image.svg': svg, 'image.yaml': 'caption: A farm\n' }); use(root, '../images/farm-a1b2c3'); }, /010-landnam\/text\/en\.md: unknown image "\.\.\/images\/farm-a1b2c3", an image id is lowercase letters, digits and dashes/],
    // a shared battle sees the shared image folders alone, so it works in any story
    [root => { folder(root, `${STORY}/shared/images/farm-a1b2c3`, { 'image.svg': svg, 'image.yaml': 'caption: A farm\n' }); append(root, `${BATTLE}/battle.yaml`, 'images: [farm-a1b2c3]'); }, /althing-1012\/battle\.yaml: unknown image "farm-a1b2c3"/],
  ];
  for (const [breakIt, message] of cases) {
    const root = copy();
    breakIt(root);
    await assert.rejects(make(root), message);
  }
});

test("a battle page without the story's language shows the battle's text with a warning, and --strict stops on it", async () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'languages: [en]', 'languages: [en, tr]');
  for (const f of fs.readdirSync(path.join(root, STORY, 'pages'), { recursive: true })) if (f.endsWith('en.md')) fs.copyFileSync(path.join(root, STORY, 'pages', f), path.join(root, STORY, 'pages', f.replace(/en\.md$/, 'tr.md')));
  const lines = [];
  await make(root, { log: l => lines.push(l) });
  assert.ok(lines.includes('  warning: battle "althing-1012" has no tr text on althing-1012-assembly, althing-1012-fight, they show the en text'));
  assert.ok(bundleOf(root).pages[3].html.tr.startsWith('<div lang="en" dir="ltr"><p>At the Althing of 1012'));
  i18n({ root, lang: 'tr', log: quiet });
  fillCatalogue(root, `${STORY}/i18n/tr.yaml`); fillCatalogue(root, `${BATTLE}/i18n/tr.yaml`);
  await assert.rejects(make(root, { strict: true }), /content\/shared\/battles\/althing-1012: tr: no text\/tr\.md on althing-1012-assembly, althing-1012-fight/);
});

test("patterns counts the zones an include shows on a battle's pages", () => {
  const root = copy();
  edit(root, `${STORY}/story.yaml`, 'smoothing: 4', '  church: { priority: 1, color: "#2f6aa0", color_dark: "#6fa3d7" }\nsmoothing: 4');
  fs.mkdirSync(path.join(root, STORY, 'shared/zones'));
  fs.writeFileSync(path.join(root, STORY, 'shared/zones/church.geojson'), JSON.stringify({
    type: 'Feature', properties: { family: 'church', name: 'Church land' },
    geometry: { type: 'Polygon', coordinates: [[[-22, 64], [-21, 64], [-21, 64.5], [-22, 64.5], [-22, 64]]] },
  }));
  append(root, INCLUDE, 'zones: [island, church]');
  const found = patterns({ root, log: quiet });
  assert.deepEqual(found.map(f => [f.a, f.b, f.dir]), [['church', 'settled', `${STORY}/pages/040-althing-battle`]]);
});

test('a battle folder or an include used the wrong way stops the build, naming the file', async () => {
  const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  const cases = [
    [root => write(root, `${STORY}/shared/battles.yaml`, 'x: {}\n'), /settlement-of-iceland\/shared\/battles\.yaml: battles live in folders now, one per battle/],
    [root => fs.copyFileSync(path.join(root, STORY, 'story.yaml'), path.join(root, 'content/shared/story.yaml')), /content\/shared\/story\.yaml: content\/shared\/ holds what the stories share/],
    [root => edit(root, INCLUDE, 'battle: althing-1012', 'battle: althing-1013'), /040-althing-battle\/include\.yaml: unknown battle "althing-1013", add content\/settlement-of-iceland\/shared\/battles\/althing-1013\/battle\.yaml or content\/shared\/battles\/althing-1013\/battle\.yaml/],
    [root => append(root, `${STORY}/pages/010-landnam/page.yaml`, 'battle: nowhere-900'), /010-landnam\/page\.yaml: unknown battle "nowhere-900"/],
    [root => fs.cpSync(path.join(root, BATTLE), path.join(root, STORY, 'shared/battles/althing-1012'), { recursive: true }), /battle "althing-1012" is in both content\/settlement-of-iceland\/shared\/battles\/althing-1012 and content\/shared\/battles\/althing-1012, keep one/],
    [root => { write(root, `${STORY}/pages/040-althing-battle/.DS_Store`, ''); write(root, `${STORY}/pages/040-althing-battle/notes.md`, 'x'); }, /040-althing-battle: an include folder holds include\.yaml alone, move notes\.md into/],
    [root => fs.cpSync(path.join(root, STORY, 'pages/040-althing-battle'), path.join(root, STORY, 'pages/050-again'), { recursive: true }), /050-again\/include\.yaml: battle "althing-1012" is included twice/],
    [root => write(root, `${BATTLE}/pages/030-more/include.yaml`, 'battle: althing-1012\n'), /030-more\/include\.yaml: a battle includes no other battle/],
    [root => { skirmish(root); write(root, `${STORY}/pages/050-skirmish/include.yaml`, 'battle: skirmish-900\n'); }, /050-skirmish\/include\.yaml: battle "skirmish-900" has no pages to include, a page that writes battle: skirmish-900 shows its card/],
    [root => append(root, INCLUDE, 'zones: [mainland]'), /040-althing-battle\/include\.yaml: unknown zone "mainland"/],
    [root => edit(root, INCLUDE, 'markers: [thingvellir]', 'markers: [hof]'), /040-althing-battle\/include\.yaml: unknown marker "hof"/],
    [root => append(root, PLAN, 'zones: [island]'), /020-fight\/page\.yaml: a battle page has no zones/],
    [root => write(root, `${BATTLE}/zones/field.geojson`, '{}'), /althing-1012\/zones: a battle holds no zones/],
    [root => append(root, `${STORY}/pages/010-landnam/page.yaml`, 'battle: true'), /010-landnam\/page\.yaml: battle: true opens the card on a battle's own page/],
    [root => edit(root, `${BATTLE}/pages/010-assembly/page.yaml`, 'battle: true', 'battle: althing-1012'), /010-assembly\/page\.yaml: a battle page opens its own card with battle: true/],
    [root => edit(root, `${STORY}/story.yaml`, 'smoothing: 4', '  held: { priority: 1, color: "#c62828", aliases: [settled] }\nsmoothing: 4'), /story\.yaml: family "held" has the alias "settled", which is the id of another family/],
    [root => edit(root, `${STORY}/story.yaml`, 'smoothing: 4', '  a1: { priority: 1, color: "#c62828", aliases: [kin] }\n  a2: { priority: 1, color: "#c62828", aliases: [kin] }\nsmoothing: 4'), /the alias "kin" is on both "a1" and "a2", keep it on one/],
    [root => edit(root, `${BATTLE}/battle.yaml`, 'color: settled', 'color: allies'), /althing-1012\/battle\.yaml: side 2 uses "allies", which is not in the battle's families/],
    [root => write(root, `${BATTLE}/markers.yaml`, 'camp:\n  lnglat: [-21.12, 64.26]\n  label: Camp\n  color: allies\n'), /althing-1012\/markers\.yaml: marker "camp" uses unknown family "allies", add it to families in battle\.yaml/],
    [root => append(root, PLAN, 'markers: [camp]'), /020-fight\/page\.yaml: unknown marker "camp"/],
    [root => write(root, 'content/shared/battles.yaml', 'x: {}\n'), /content\/shared\/battles\.yaml: battles live in folders now/],
    [root => fs.copyFileSync(path.join(root, `${BATTLE}/pages/010-assembly/page.yaml`), path.join(root, STORY, 'pages/040-althing-battle/page.yaml')), /040-althing-battle: holds page\.yaml and include\.yaml, keep one/],
    [root => fs.renameSync(path.join(root, BATTLE), path.join(root, 'content/shared/battles/Althing-1012')), /content\/shared\/battles\/Althing-1012: a battle folder is named in lowercase letters/],
    [root => { fs.rmSync(path.join(root, BATTLE, 'pages'), { recursive: true }); fs.mkdirSync(path.join(root, BATTLE, 'pages/010-notes'), { recursive: true }); }, /include\.yaml: battle "althing-1012" has no pages to include/],
    [root => write(root, `${BATTLE}/pages/010-assembly/zones/field.geojson`, '{}'), /010-assembly\/zones: a battle holds no zones/],
  ];
  for (const [breakIt, message] of cases) {
    const root = copy();
    breakIt(root);
    await assert.rejects(make(root), message);
  }
});

test('a route takes the colour of the family it names', async () => {
  const colour = (root, family) => {
    const file = path.join(root, STORY, 'shared/routes/pillars.geojson'), route = JSON.parse(fs.readFileSync(file, 'utf8'));
    route.properties.color = family; fs.writeFileSync(file, JSON.stringify(route));
  };
  const root = copy();
  colour(root, 'settled');
  await make(root);
  assert.equal(bundleOf(root).routes.pillars.color, 'settled');
  for (const f of ['kitap.js', 'harita.js']) new vm.Script(read(root, f)); // the page scripts parse
  const bad = copy();
  colour(bad, 'norse');
  await assert.rejects(make(bad), /pillars\.geojson: route "pillars" uses unknown family "norse"/);
});

test('routes in a list of their own are one leg, travelled at once', async () => {
  const root = copy(), dir = path.join(root, STORY, 'shared/routes');
  const route = JSON.parse(fs.readFileSync(path.join(dir, 'pillars.geojson'), 'utf8'));
  route.properties.id = 'column'; route.properties.name = { en: 'A second column' }; fs.writeFileSync(path.join(dir, 'column.geojson'), JSON.stringify(route));
  edit(root, `${STORY}/pages/010-landnam/page.yaml`, 'routes: [pillars]', 'routes: [[pillars, column]]');
  await make(root);
  const page = bundleOf(root).pages.find(p => p.id === 'landnam');
  assert.deepEqual(page.routes, ['pillars', 'column']);
  assert.deepEqual(page.groups, [['pillars', 'column']]);
});

test('a built site loads its scripts, fonts and map glyphs from itself', async () => {
  const root = copy();
  await make(root);
  const dist = path.join(root, 'dist');
  for (const f of fs.readdirSync(dist, { recursive: true }).filter(f => /\.(html|js|css)$/.test(f) && !f.startsWith('vendor'))) {
    const text = fs.readFileSync(path.join(dist, f), 'utf8');
    for (const host of ['fonts.googleapis', 'fonts.gstatic', 'cdnjs.', 'jsdelivr', 'unpkg', 'protomaps.github.io']) assert.ok(!text.includes(host), `${f} names ${host}`);
  }
  const page = read(root, 'settlement-of-iceland/en/landnam/index.html');
  for (const lib of ['maplibre-gl', 'topojson-client', 'turf']) {
    const src = page.match(new RegExp(`<script src="\\.\\./(vendor/${lib}@[^"]+)"`))?.[1];
    assert.ok(src && fs.existsSync(path.join(dist, src)), lib);
  }
  const css = read(root, 'vendor/fonts.css');
  assert.deepEqual([...new Set([...css.matchAll(/font-family: '([^']+)'/g)].map(m => m[1]))], ['Fraunces', 'Public Sans']);
  for (const [, file] of css.matchAll(/url\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(dist, 'vendor', file)), file);
  assert.ok(fs.existsSync(path.join(dist, 'vendor/glyphs/noto-sans/0-255.pbf')));
});

test('a story folder named vendor fails, since harita writes dist/vendor/', async () => {
  const root = copy();
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/vendor'), { recursive: true });
  edit(root, 'content/vendor/story.yaml', 'id: settlement-of-iceland', 'id: vendor');
  await assert.rejects(make(root), /content\/vendor: kitap writes dist\/vendor\/, give the story another folder name/);
});

// --- shared zones, and the zones of different stories that look like one region ---
const ISLAND = `${STORY}/pages/020-althing/zones/island.geojson`;
// a second story, a copy of the example under another id
function secondStory(root) {
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
}
// every coordinate of a zone file moved a little, as another hand would draw it
const redraw = (root, file, d = 0.002) => { const z = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); z.geometry.coordinates = z.geometry.coordinates.map(r => r.map(([x, y], i) => [x + (i % 2 ? d : -d), y + d])); fs.writeFileSync(path.join(root, file), JSON.stringify(z)); };

test("a shared zone shows in every story that names it, in the story's family by id or alias", async () => {
  const root = copy(), shared = 'content/shared/zones/island-930';
  const island = JSON.parse(fs.readFileSync(path.join(root, ISLAND), 'utf8'));
  fs.mkdirSync(path.join(root, shared), { recursive: true });
  fs.writeFileSync(path.join(root, shared, 'zone.geojson'), JSON.stringify({ ...island, properties: { family: 'settlers', name: 'The settled island', clip: ['Iceland'] } }));
  fs.rmSync(path.join(root, ISLAND));
  for (const page of ['020-althing', '030-kristnitaka']) edit(root, `${STORY}/pages/${page}/page.yaml`, 'zones: [island]', 'zones: [island-930]');
  await assert.rejects(make(root), /island-930\/zone\.geojson: family "settlers" is not in content\/settlement-of-iceland\/story\.yaml, give a family there the id or alias "settlers"/);
  edit(root, `${STORY}/story.yaml`, 'color_dark: "#6fa3d6" }', 'color_dark: "#6fa3d6", aliases: [settlers] }');
  addLanguage(root, 'tr');
  const lines = [];
  await make(root, { log: l => lines.push(l) });
  const B = bundleOf(root);
  assert.equal(B.zones['island-930'].family, 'settled');
  assert.ok(zoneGeometry(B, 'island-930'), 'the story cleans the shared zone with its own');
  assert.ok(lines.includes('  zone folders tr: 0 of 1 strings translated, 1 missing (kitap i18n tr)'));
  i18n({ root, lang: 'tr', log: quiet });
  assert.match(fs.readFileSync(path.join(root, shared, 'i18n/tr.yaml'), 'utf8'), /^zone\.name: ""$/m);
  // the same id in the story and in content/shared/zones/ is one too many
  fs.mkdirSync(path.join(root, STORY, 'shared/zones'), { recursive: true });
  fs.writeFileSync(path.join(root, STORY, 'shared/zones/island-930.geojson'), JSON.stringify(island).replace('"id":"island"', '"id":"island-930"'));
  await assert.rejects(make(root), /zone "island-930" is in content\/settlement-of-iceland\/shared and in content\/shared\/zones\/island-930, keep one/);
});

test('harita zones tells MultiPolygon zones apart by their parts', () => {
  const root = copy();
  secondStory(root);
  const multi = (file, boxes) => { const z = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    z.geometry = { type: 'MultiPolygon', coordinates: boxes.map(([w, s, e, n]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]) };
    fs.writeFileSync(path.join(root, file), JSON.stringify(z)); };
  multi(`${STORY}/pages/010-landnam/zones/southwest.geojson`, [[-22, 63.8, -21, 64.2], [-20.5, 63.4, -19.5, 63.8]]);
  multi('content/second-story/pages/010-landnam/zones/southwest.geojson', [[-16, 64.5, -15, 65], [-15, 65.5, -14, 66]]);
  assert.deepEqual(zones({ root, log: quiet }).map(p => p.a.id), ['island']);
  // the same parts in another order are the same drawing
  multi('content/second-story/pages/010-landnam/zones/southwest.geojson', [[-20.5, 63.4, -19.5, 63.8], [-22, 63.8, -21, 64.2]]);
  const pairs = zones({ root, log: quiet });
  assert.deepEqual(pairs.map(p => [p.a.id, p.exact]).sort(), [['island', true], ['southwest', true]]);
});

test('harita zones finds copies and near copies across stories, and the review page shows them', async () => {
  const root = copy();
  secondStory(root);
  let pairs = zones({ root, log: quiet });
  // the second story copies both zones: one map read finds each copy
  assert.deepEqual(pairs.map(p => p.a.id).sort(), ['island', 'southwest']);
  // a plain build warns about the copies and writes the review page, a strict one stops
  const plain = [];
  fs.rmSync(path.join(root, '.cache/kitap/zones.html'));
  await make(root, { log: l => plain.push(l) });
  assert.ok(plain.some(l => /^warning: second-story\/island ~ settlement-of-iceland\/island  the same drawing/.test(l)) && fs.existsSync(path.join(CACHE, 'zones.html')));
  assert.deepEqual(pairs.map(p => p.exact), [true, true]);
  await assert.rejects(make(root, { strict: true }), /zones that copy another one: second-story\/(island|southwest) ~ settlement-of-iceland\/\1  the same drawing, families settled \/ settled: harita zones --share second-story\/\1 --replace settlement-of-iceland\/\1 keeps one outline/);
  // redrawn by another hand they cover the same land, which is a warning
  for (const f of ['pages/020-althing/zones/island.geojson', 'pages/010-landnam/zones/southwest.geojson']) redraw(root, `content/second-story/${f}`);
  pairs = zones({ root, log: quiet });
  assert.ok(pairs.length === 2 && pairs.every(p => !p.exact && p.overlap >= 0.98), JSON.stringify(pairs.map(p => [p.a.id, p.overlap])));
  const lines = [];
  await make(root, { strict: true, log: l => lines.push(l) });
  assert.ok(lines.some(l => /^warning: second-story\/island ~ settlement-of-iceland\/island  \d+% overlap, the same land.*, families settled \/ settled, see .*zones\.html$/.test(l)), lines.filter(l => l.startsWith('warning')).join('\n'));
  const page = fs.readFileSync(path.join(root, '.cache/kitap/zones.html'), 'utf8');
  assert.ok(page.includes('second-story/island') && page.includes('maplibre-gl'));
  // inside one story, dated shapes of a family overlap on purpose: those pairs show on request only
  fs.copyFileSync(path.join(root, ISLAND), path.join(root, `${STORY}/pages/030-kristnitaka/zones-copy.geojson`));
  fs.mkdirSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones`));
  fs.renameSync(path.join(root, `${STORY}/pages/030-kristnitaka/zones-copy.geojson`), path.join(root, `${STORY}/pages/030-kristnitaka/zones/island-1000.geojson`));
  edit(root, `${STORY}/pages/030-kristnitaka/zones/island-1000.geojson`, '"id": "island"', '"id": "island-1000"');
  assert.ok(!zones({ root, log: quiet }).some(p => p.a.story === p.b.story));
  assert.ok(zones({ root, sameStory: true, log: quiet }).some(p => p.a.story === STORY.split('/')[1] && p.b.story === p.a.story && p.exact));
  // a zone about to be added, against what the content holds
  fs.copyFileSync(path.join(root, ISLAND), path.join(root, 'new.geojson'));
  redraw(root, 'new.geojson', 0.003);
  assert.deepEqual(zones({ root, like: path.join(root, 'new.geojson'), log: quiet }).map(p => `${p.b.story}/${p.b.id}`).sort(), ['second-story/island', 'settlement-of-iceland/island', 'settlement-of-iceland/island-1000']);
});

test("harita zones --share makes a shared zone, and a replaced zone keeps its id, name and family in zones.yaml", async () => {
  const root = copy();
  secondStory(root);
  // the second story drew its own island under another id
  const own = 'content/second-story/pages/020-althing/zones';
  fs.renameSync(path.join(root, own, 'island.geojson'), path.join(root, own, 'iceland.geojson'));
  edit(root, `${own}/iceland.geojson`, '"id": "island"', '"id": "iceland"');
  edit(root, `${own}/iceland.geojson`, '"en": "The settled island"', '"en": "Iceland of the second story"');
  redraw(root, `${own}/iceland.geojson`);
  for (const page of ['020-althing', '030-kristnitaka']) edit(root, `content/second-story/pages/${page}/page.yaml`, 'zones: [island]', 'zones: [iceland]');
  fs.mkdirSync(path.join(root, STORY, 'i18n'));
  fs.writeFileSync(path.join(root, STORY, 'i18n/tr.yaml'), '# The settled island\nzones.island.name: "Yerleşilen ada"\n\n# other\nmarkers.reykjavik.note: "x"\n');
  const lines = [];
  zones({ root, share: 'settlement-of-iceland/island', replace: ['second-story/iceland'], log: l => lines.push(l) });
  assert.deepEqual(lines, ['moved content/settlement-of-iceland/pages/020-althing/zones/island.geojson to content/shared/zones/island/zone.geojson',
    'second-story/iceland takes its outline from island, in content/second-story/pages/020-althing/zones.yaml']);
  assert.ok(!fs.existsSync(path.join(root, ISLAND)) && !fs.existsSync(path.join(root, own, 'iceland.geojson')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'content/shared/zones/island/zone.geojson'), 'utf8')).properties.id, undefined);
  assert.match(fs.readFileSync(path.join(root, 'content/shared/zones/island/i18n/tr.yaml'), 'utf8'), /^zone\.name: "Yerleşilen ada"$/m);
  assert.equal(fs.readFileSync(path.join(root, STORY, 'i18n/tr.yaml'), 'utf8'), '# other\nmarkers.reykjavik.note: "x"\n');
  assert.match(fs.readFileSync(path.join(root, 'content/second-story/pages/020-althing/zones.yaml'), 'utf8'), /^iceland: \{zone: island, name: \{en: Iceland of the second story\}, family: settled, clip: \[Iceland\]\}$/m);
  assert.match(fs.readFileSync(path.join(root, 'content/second-story/pages/030-kristnitaka/page.yaml'), 'utf8'), /^zones: \[iceland\]$/m);
  await make(root);
  assert.equal(bundleOf(root).zones.island.name.en, 'The settled island');
  assert.deepEqual(bundleOf(root, 'second-story').zones.iceland, { family: 'settled', name: { en: 'Iceland of the second story' }, area: bundleOf(root, 'second-story').zones.iceland.area });
  // both outlines are one now, so nothing looks alike
  assert.deepEqual(zones({ root, log: quiet }).filter(p => p.a.id === 'island' || p.b.id === 'island'), []);
});

test('zones.yaml gives a zone the outline of another, shared or of the story, with a name and family of its own', async () => {
  const root = copy(), shared = 'content/shared/zones/iceland-island';
  const island = JSON.parse(fs.readFileSync(path.join(root, ISLAND), 'utf8'));
  fs.mkdirSync(path.join(root, shared), { recursive: true });
  fs.writeFileSync(path.join(root, shared, 'zone.geojson'), JSON.stringify({ ...island, properties: { family: 'land', name: 'Iceland', clip: ['Iceland'] } }));
  edit(root, `${STORY}/story.yaml`, 'smoothing: 4', '  church: { priority: 1, color: "#7a3b9a", pattern: hatch }\nsmoothing: 4');
  fs.writeFileSync(path.join(root, STORY, 'shared/zones.yaml'),
    'church-1000: { zone: iceland-island, family: church, name: { en: Church lands } }\nisland-1000: { zone: island, name: { en: The island in 1000 } }\n');
  edit(root, `${STORY}/pages/020-althing/page.yaml`, 'zones: [island]', 'zones: [island-1000]');
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'zones: [island]', 'zones: [church-1000]');
  addLanguage(root, 'tr');
  await make(root);
  const B = bundleOf(root);
  assert.deepEqual([B.zones['church-1000'].family, B.zones['church-1000'].name.en, B.zones['island-1000'].family, B.zones['island-1000'].name.en],
    ['church', 'Church lands', 'settled', 'The island in 1000']);
  // the story's own names go to its catalogue, the shared zone's name is not shown and counts in its folder
  i18n({ root, lang: 'tr', log: quiet });
  assert.match(fs.readFileSync(path.join(root, STORY, 'i18n/tr.yaml'), 'utf8'), /^zones\.church-1000\.name: ""$/m);
  const cases = [
    ['church-1000: { zone: nowhere }\n', /shared\/zones\.yaml: unknown zone "nowhere"/],
    ['a: { zone: b }\nb: { zone: a }\n', /zone "a" takes its outline from itself, through a, b/],
    ['church-1000: { zone: island, family: clergy }\n', /zone "church-1000" uses unknown family "clergy"/],
    ['church-1000: { zone: iceland-island }\n', /iceland-island\/zone\.geojson: family "land" is not in .*story\.yaml, give a family there the id or alias "land", or the zone a family of the story in zones\.yaml/],
  ];
  for (const [text, message] of cases) {
    fs.writeFileSync(path.join(root, STORY, 'shared/zones.yaml'), text);
    await assert.rejects(make(root), message);
  }
});

test('a pair kept apart stops warning until either zone is redrawn, and a copy cannot be kept apart', async () => {
  const root = copy();
  secondStory(root);
  redraw(root, 'content/second-story/pages/020-althing/zones/island.geojson');
  redraw(root, 'content/second-story/pages/010-landnam/zones/southwest.geojson');
  const lines = [];
  zones({ root, apart: ['second-story/island', 'settlement-of-iceland/island'], why: 'two states on one island', log: l => lines.push(l) });
  assert.deepEqual(lines, ['kept second-story/island and settlement-of-iceland/island apart in content/shared/zones/apart.yaml']);
  const all = [];
  assert.deepEqual(zones({ root, log: l => all.push(l) }).map(p => p.a.id), ['southwest']);
  assert.match(all.at(-1), /^1 pair, 1 kept apart, see /);
  const strict = [];
  await make(root, { strict: true, log: l => strict.push(l) });
  assert.ok(!strict.some(l => l.includes('island ~')) && strict.some(l => l.includes('southwest ~')));
  // a new drawing brings the pair back
  redraw(root, 'content/second-story/pages/020-althing/zones/island.geojson', 0.001);
  assert.ok(zones({ root, log: quiet }).some(p => p.a.id === 'island' && p.redrawn));
  // an entry whose zone is gone is reported
  fs.rmSync(path.join(root, 'content/second-story/pages/020-althing/zones/island.geojson'));
  const gone = [];
  zones({ root, log: l => gone.push(l) });
  assert.ok(gone.includes('content/shared/zones/apart.yaml: second-story/island ~ settlement-of-iceland/island names a zone that is gone, remove the entry'));
  // copies share one outline instead
  fs.copyFileSync(path.join(root, `${STORY}/pages/010-landnam/zones/southwest.geojson`), path.join(root, 'content/second-story/pages/010-landnam/zones/southwest.geojson'));
  assert.throws(() => zones({ root, apart: ['second-story/southwest', 'settlement-of-iceland/southwest'], why: 'x', log: quiet }), /are the same drawing: harita zones --share second-story\/southwest --replace settlement-of-iceland\/southwest keeps one outline/);
});

test('battles, images and zones sit in groups of folders at any depth, which only order them', async () => {
  const root = copy(), group = (from, to) => { fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true }); fs.renameSync(path.join(root, from), path.join(root, to)); };
  group(BATTLE, 'content/shared/battles/iceland/11th-century/althing-1012');
  const farm = await image({ root, file: svgFile(root, 'farm'), name: 'farm', caption: 'The farm', story: 'settlement-of-iceland', log: quiet });
  group(`${STORY}/shared/images/${farm}`, `${STORY}/shared/images/farms/${farm}`);
  append(root, `${STORY}/pages/010-landnam/text/en.md`, `@image ${farm}`);
  // a story's zone files in a subfolder of zones/, and a shared zone in a group
  group(ISLAND, `${STORY}/pages/020-althing/zones/whole/island.geojson`);
  const island = JSON.parse(fs.readFileSync(path.join(root, `${STORY}/pages/020-althing/zones/whole/island.geojson`), 'utf8'));
  fs.mkdirSync(path.join(root, 'content/shared/zones/north/iceland-930'), { recursive: true });
  fs.writeFileSync(path.join(root, 'content/shared/zones/north/iceland-930/zone.geojson'), JSON.stringify({ ...island, properties: { family: 'settled', name: 'Iceland', clip: ['Iceland'] } }));
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, 'zones: [island]', 'zones: [iceland-930]');
  await make(root);
  const B = bundleOf(root);
  assert.ok(B.pages.some(p => p.id === 'althing-1012-fight') && B.images[farm] && B.zones.island && B.zones['iceland-930']);
  assert.ok(fs.existsSync(path.join(root, 'dist/assets', originalKey(root, farm))));
  // harita image and harita zones look in the groups too
  assert.equal(await image({ root, file: svgFile(root, 'farm'), name: 'farm', caption: 'x', story: 'settlement-of-iceland', log: quiet }), farm);
  assert.deepEqual(zones({ root, log: quiet }).map(p => [p.a.id, p.b.id].sort()), [['iceland-930', 'island']]);
  // one name in two groups
  fs.cpSync(path.join(root, 'content/shared/battles/iceland/11th-century/althing-1012'), path.join(root, 'content/shared/battles/elsewhere/althing-1012'), { recursive: true });
  await assert.rejects(make(root), /content\/shared\/battles: content\/shared\/battles\/elsewhere\/althing-1012 and content\/shared\/battles\/iceland\/11th-century\/althing-1012 have one name, rename one/);
});

// --- what the 0.4.0 review found ---
test('--share checks everything before it writes, refuses a clash, and writes zones.yaml beside the zones/ folder', async () => {
  const root = copy();
  secondStory(root);
  const own = 'content/second-story/pages/020-althing/zones';
  fs.mkdirSync(path.join(root, own, 'whole'));
  fs.renameSync(path.join(root, own, 'island.geojson'), path.join(root, own, 'whole/iceland.geojson'));
  edit(root, `${own}/whole/iceland.geojson`, '"id": "island"', '"id": "iceland"');
  for (const page of ['020-althing', '030-kristnitaka']) edit(root, `content/second-story/pages/${page}/page.yaml`, 'zones: [island]', 'zones: [iceland]');
  // a mistyped replace changes nothing
  assert.throws(() => zones({ root, share: 'settlement-of-iceland/island', replace: ['second-story/islnd'], log: quiet }), /no zone second-story\/islnd/);
  assert.ok(fs.existsSync(path.join(root, ISLAND)) && !fs.existsSync(path.join(root, 'content/shared/zones/island')));
  // a third story that draws its own island would see the id twice
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/third-story'), { recursive: true });
  edit(root, 'content/third-story/story.yaml', 'id: settlement-of-iceland', 'id: third-story');
  assert.throws(() => zones({ root, share: 'settlement-of-iceland/island', replace: ['second-story/iceland'], log: quiet }), /third-story\/island draws a zone of the id island too/);
  fs.rmSync(path.join(root, 'content/third-story'), { recursive: true });
  zones({ root, share: 'settlement-of-iceland/island', replace: ['second-story/iceland'], log: quiet });
  assert.ok(fs.existsSync(path.join(root, 'content/second-story/pages/020-althing/zones.yaml')));
  await make(root);
  assert.equal(bundleOf(root, 'second-story').zones.iceland.family, 'settled');
});

test('a zones.yaml entry of an id already taken is reported, and a failed entry leaves no false loop behind', async () => {
  const root = copy();
  fs.writeFileSync(path.join(root, STORY, 'shared/zones.yaml'), 'island: { zone: southwest, name: Renamed }\n');
  await assert.rejects(make(root), /shared\/zones\.yaml: zone "island" is defined twice/);
  fs.writeFileSync(path.join(root, STORY, 'shared/zones.yaml'), 'a: { zone: island, family: nope }\nb: { zone: a }\n');
  const problems = check({ root, story: 'settlement-of-iceland', log: quiet });
  assert.ok(problems.some(p => /zone "a" uses unknown family "nope"/.test(p)), problems.join('\n'));
  assert.ok(!problems.some(p => /takes its outline from itself/.test(p)), problems.join('\n'));
});

test('a strict build names the way out of a copy of a shared zone, and a zone file that is not JSON is named', async () => {
  const root = copy(), shared = 'content/shared/zones/island-930';
  fs.mkdirSync(path.join(root, shared), { recursive: true });
  const island = JSON.parse(fs.readFileSync(path.join(root, ISLAND), 'utf8'));
  fs.writeFileSync(path.join(root, shared, 'zone.geojson'), JSON.stringify({ ...island, properties: { family: 'settled', name: 'Iceland', clip: ['Iceland'] } }));
  await assert.rejects(make(root, { strict: true }), /name the shared zone island-930 in place of settlement-of-iceland\/island, or give settlement-of-iceland\/island a zones\.yaml entry \{ zone: island-930 \}/);
  fs.writeFileSync(path.join(root, shared, 'zone.geojson'), '{ type: Feature }');
  assert.throws(() => zones({ root, log: quiet }), /content\/shared\/zones\/island-930\/zone\.geojson: /);
});

test('harita image tells two pages by their query apart, refuses a file without an image extension, and rehash names a folder without image.yaml', async () => {
  const root = copy(), page = id => `https://collections.example.org/object.php?id=${id}`;
  const sword = await image({ root, file: svgFile(root, 'sword'), name: 'sword', caption: 'A sword', source: page(101), story: 'settlement-of-iceland', log: quiet });
  const helmet = await image({ root, file: svgFile(root, 'helmet'), name: 'helmet', caption: 'A helmet', source: page(202), log: quiet });
  assert.notEqual(sword, helmet);
  fs.writeFileSync(path.join(root, 'noext'), 'x');
  await assert.rejects(image({ root, file: path.join(root, 'noext'), name: 'thing', caption: 'x', log: quiet }), /an image is a \.jpg, \.jpeg, \.png, \.webp, \.svg or \.gif file/);
  fs.mkdirSync(path.join(root, 'content/shared/images/bare-a1b2c3'));
  fs.writeFileSync(path.join(root, 'content/shared/images/bare-a1b2c3/image.svg'), '<svg/>');
  const lines = [];
  rehash({ root, log: l => lines.push(l) });
  assert.ok(lines.includes('content/shared/images/bare-a1b2c3: image.yaml is missing'));
});

test('a strict build checks the images it ships, and a story built alone keeps the shared images of the others', async () => {
  const root = copy();
  secondStory(root);
  for (const f of ['pages/020-althing/zones/island.geojson', 'pages/010-landnam/zones/southwest.geojson']) redraw(root, `content/second-story/${f}`);
  const shared = await image({ root, file: svgFile(root, 'plain'), name: 'plain', caption: 'The plain', log: quiet });
  append(root, 'content/second-story/pages/010-landnam/text/en.md', `@image ${shared}`);
  // an image only a marker no page shows: not shipped, so neither its hash nor its caption counts
  const hidden = await image({ root, file: svgFile(root, 'hof'), name: 'hof', caption: 'The hof', story: 'settlement-of-iceland', log: quiet });
  fs.appendFileSync(path.join(root, STORY, 'shared/markers.yaml'), `hof:\n  lnglat: [-21.1, 64.3]\n  label: Hof\n  image: ${hidden}\n`);
  fs.writeFileSync(path.join(root, STORY, `shared/images/${hidden}/image.svg`), '<svg xmlns="http://www.w3.org/2000/svg"><title>new</title></svg>');
  await make(root, { strict: true });
  const key = path.join(root, 'dist/assets', originalKey(root, shared));
  assert.ok(fs.existsSync(key));
  await make(root, { story: 'settlement-of-iceland' });
  assert.ok(fs.existsSync(key), 'the second story still shows it');
  // dist/assets/ holds the images and tiles, so no story takes its name
  edit(root, `${STORY}/story.yaml`, 'id: settlement-of-iceland', 'id: assets');
  await assert.rejects(make(root), /the story id "assets" names the folder dist\/assets\/ that holds the images and objects of a --local-assets build/);
});

test('an inline text without the default language names its file, and --like keeps the rest of the cache', async () => {
  const root = copy();
  edit(root, `${BATTLE}/battle.yaml`, 'name: { en: "Fight at the Althing" }', 'name: { is: "Bardaginn á Alþingi" }');
  await assert.rejects(make(root), /content\/shared\/battles\/althing-1012\/battle\.yaml: battle\.name: no "en" text, write it in en or set default_language to the language it is in/);
  edit(root, `${BATTLE}/battle.yaml`, 'name: { is: "Bardaginn á Alþingi" }', 'name: { en: "Fight at the Althing" }');
  secondStory(root);
  redraw(root, 'content/second-story/pages/020-althing/zones/island.geojson');
  zones({ root, log: quiet });
  const cache = () => Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.cache/kitap/zone-compare.json'), 'utf8')).overlap).length;
  const before = cache();
  fs.copyFileSync(path.join(root, ISLAND), path.join(root, 'new.geojson'));
  redraw(root, 'new.geojson', 0.004);
  zones({ root, like: path.join(root, 'new.geojson'), log: quiet });
  assert.ok(before > 0 && cache() >= before, `${before} overlaps cached, ${cache()} after --like`);
});

// --- what the final 0.4.0 review found ---
test("a broken zone file in another story leaves a story built alone working, and a zones.yaml entry keeps its own clip", async () => {
  const root = copy();
  secondStory(root);
  for (const f of ['pages/020-althing/zones/island.geojson', 'pages/010-landnam/zones/southwest.geojson']) redraw(root, `content/second-story/${f}`);
  fs.writeFileSync(path.join(root, 'content/second-story/pages/010-landnam/zones/southwest.geojson'), '{ "type": "Feature", "properties": {} ');
  const lines = [];
  await make(root, { story: 'settlement-of-iceland', log: l => lines.push(l) });
  assert.ok(lines.some(l => /^warning: content\/second-story\/pages\/010-landnam\/zones\/southwest\.geojson: .*, left out of the zone comparison$/.test(l)), lines.join('\n'));
  await assert.rejects(make(root), /second-story\/pages\/010-landnam\/zones\/southwest\.geojson/);
  fs.rmSync(path.join(root, 'content/second-story'), { recursive: true });
  // the first story clips its island to two countries, the second story knows one of them and draws its island without a clip
  secondStory(root);
  edit(root, `${STORY}/story.yaml`, 'countries: [Iceland]', 'countries: [Iceland, Greenland]');
  edit(root, ISLAND, '"clip": ["Iceland"]', '"clip": ["Iceland", "Greenland"]');
  edit(root, 'content/second-story/pages/020-althing/zones/island.geojson', ', "clip": ["Iceland"]', '');
  zones({ root, share: 'settlement-of-iceland/island', replace: ['second-story/island', 'second-story/island'], log: quiet });
  assert.deepEqual(check({ root, story: 'second-story', log: quiet }), []);
});

test('--share reads every catalogue before it writes, and harita image checks its fields and its folder first', async () => {
  const root = copy();
  secondStory(root);
  fs.mkdirSync(path.join(root, STORY, 'i18n'));
  fs.writeFileSync(path.join(root, STORY, 'i18n/tr.yaml'), 'zones.island.name: [unclosed\n');
  assert.throws(() => zones({ root, share: 'settlement-of-iceland/island', replace: ['second-story/island'], log: quiet }), /settlement-of-iceland\/i18n\/tr\.yaml: /);
  assert.ok(fs.existsSync(path.join(root, ISLAND)) && !fs.existsSync(path.join(root, 'content/shared/zones/island')));
  const file = svgFile(root, 'farm');
  await assert.rejects(image({ root, file, name: 'farm', caption: 'x', source: 'commons.wikimedia.org/wiki/File:Farm.jpg', log: quiet }), /source: Invalid URL/);
  assert.ok(!fs.existsSync(path.join(root, 'content/shared/images')));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-empty-'));
  await assert.rejects(image({ root: empty, file, name: 'farm', caption: 'x', log: quiet }), /content\/: no story\.yaml found, run kitap image from a content project/);
  assert.ok(!fs.existsSync(path.join(empty, 'content')));
});
