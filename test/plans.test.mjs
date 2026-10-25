// The helpers for scripts that draw battle plans: the local frame, the page writer and the coast lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { frame, planWriter, coast } from '../src/plans.mjs';
import { buildPages } from '../src/build.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test('a frame places points given in metres and turns relative bearings into compass bearings', () => {
  // u runs east along bearing 90, w south along 180
  const f = frame([16, 41], 90);
  const [lon, lat] = f.p(1000, 0);
  near(lon, 16 + 1000 / (111320 * Math.cos(41 * Math.PI / 180)));
  near(lat, 41);
  near(f.p(0, 1000)[1], 41 - 1000 / 110540);
  assert.equal(f.face(90), 180);
  assert.equal(f.face(-100), 350);
  assert.deepEqual(f.path([[0, 0], [1000, 0]]), [f.p(0, 0), f.p(1000, 0)]);
});

test('writePlan writes the emblem, bbox, markers and routes and keeps the rest of the page', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-plans-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  // a battle folder is the root of its own pages, as a story folder is
  const battle = path.join(root, 'content/shared/battles/althing-1012'), page = path.join(battle, 'pages/020-fight');
  const f = frame([-21.116, 64.258], 0), writePlan = planWriter(battle);
  writePlan('pages/020-fight', {
    bbox: f.box([[-500, -500], [500, 500]], 100),
    emblem: { units: [{ side: 'neutral', type: 'archers', at: f.p(0, 0), width: 200, depth: 60, facing: f.face(0), name: { en: 'Bowmen' } }] },
    markers: { lawrock: { lnglat: f.p(100, 0), icon: 'landmark', label: { en: 'Lögberg' } } },
    routes: { 'to-the-rift': { name: { en: 'To the rift' }, path: [f.p(0, 0), f.p(0, -300)] } },
  });
  const text = fs.readFileSync(path.join(page, 'page.yaml'), 'utf8');
  assert.match(text, /^emblem:\n {2}kind: battle-plan\n {2}units:\n {4}- \{side: neutral, type: archers/m);
  assert.match(text, /^markers: \[lawrock\]$/m);
  assert.match(text, /^routes: \[to-the-rift\]$/m);
  assert.match(text, /^when: 1012$/m);
  assert.match(text, /^# battle-plan ships with harita/m);
  assert.ok(text.includes('Njáls saga, ch. 145.'));
  assert.ok(fs.existsSync(path.join(page, 'routes/to-the-rift.geojson')));
  assert.match(fs.readFileSync(path.join(page, 'markers.yaml'), 'utf8'), /^lawrock:\n {2}lnglat: \[/m);
  // the written page builds
  buildPages({ root, log: () => {}, cache: path.join(root, '.cache/harita'), localAssets: true });
});

test('coast lists the shore points of a country inside a box', () => {
  const pieces = coast('Italy', [12.3, 37.8, 12.6, 38.1]);
  assert.ok(pieces.length && pieces.every(pts => pts.length));
  for (const [x, y] of pieces.flat()) assert.ok(x >= 12.3 && x <= 12.6 && y >= 37.8 && y <= 38.1);
});
