// Helpers for scripts that draw battle plans. A script lays out one battle in a local frame, metres along and across
// the battle line, and writes the result into the battle's pages.
//
//   import { frame, planWriter } from '@openhistoryatlas/harita/plans';
//   const writePlan = planWriter('content/punic-wars');   // bound to one story folder, or one battle folder
//   const f = frame([16.133, 41.297], 330);   // origin [lon, lat]; u runs along bearing 330, w along 330 + 90
//   f.p(1800, -500)                           // -> [lon, lat] of the point u = 1800 m, w = -500 m
//   f.face(90)                                // -> compass bearing of the +w direction, for a unit's facing
//   writePlan('pages/.../020-cannae-deployment', { emblem, markers, show, routes, bbox });
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as yaml from 'js-yaml';
import * as tc from 'topojson-client';

const require = createRequire(import.meta.url);

const r5 = x => Math.round(x * 1e5) / 1e5;

export function frame([lon0, lat0], bearing) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540, t = bearing * Math.PI / 180;
  const u = [Math.sin(t), Math.cos(t)], w = [Math.cos(t), -Math.sin(t)];
  const p = (a, b) => [r5(lon0 + (a * u[0] + b * w[0]) / kx), r5(lat0 + (a * u[1] + b * w[1]) / ky)];
  const face = rel => ((bearing + rel) % 360 + 360) % 360;
  // a bbox around local points, padded by pad metres
  const box = (pts, pad = 400) => {
    const us = pts.map(q => q[0]), ws = pts.map(q => q[1]), u0 = Math.min(...us) - pad, u1 = Math.max(...us) + pad, w0 = Math.min(...ws) - pad, w1 = Math.max(...ws) + pad;
    const ll = [p(u0, w0), p(u0, w1), p(u1, w0), p(u1, w1)];
    return [Math.min(...ll.map(q => q[0])), Math.min(...ll.map(q => q[1])), Math.max(...ll.map(q => q[0])), Math.max(...ll.map(q => q[1]))].map(r5);
  };
  return { p, face, box, path: pts => pts.map(([a, b]) => p(a, b)) };
}

// Writes the plan of one page: the emblem and bbox into page.yaml, the page's own markers into markers.yaml
// and routes into routes/*.geojson, and sets the page's markers and routes lists. `show` adds marker ids
// defined elsewhere. Keys that are left out stay as they are.
export const planWriter = story => (pageDir, plan) => writePlan(story, pageDir, plan);
export function writePlan(story, pageDir, { emblem, markers, show = [], routes, bbox }) {
  const dir = path.join(story, pageDir), file = path.join(dir, 'page.yaml');
  let text = fs.readFileSync(file, 'utf8');
  const setKey = (key, value) => {
    // a key's block is its line and the indented lines under it; a comment at the margin belongs to the next key
    const block = new RegExp(`^${key}:.*\\n(?:[ ].*\\n|\\n)*`, 'm'), line = value === undefined ? '' : `${key}:${value.startsWith('\n') ? '' : ' '}${value}\n`;
    text = block.test(text) ? text.replace(block, line) : /^images:/m.test(text) ? text.replace(/^images:/m, line + 'images:') : text.replace(/\n?$/, '\n') + line;
  };
  if (bbox) setKey('bbox', JSON.stringify(bbox.map(r5)).replace(/,/g, ', '));
  if (emblem) setKey('emblem', '\n' + yaml.dump({ kind: 'battle-plan', ...emblem }, { flowLevel: 2, lineWidth: 200 }).replace(/^/gm, '  ').trimEnd());
  if (markers && !Object.keys(markers).length) { fs.rmSync(path.join(dir, 'markers.yaml'), { force: true }); setKey('markers', `[${show.join(', ')}]`); }
  else if (markers) {
    const out = '# Written by .plans: labels for the units and places on this page. lnglat is [longitude, latitude].\n'
      + Object.entries(markers).map(([id, m]) => `${id}:\n  lnglat: ${JSON.stringify(m.lnglat).replace(',', ', ')}\n  icon: ${m.icon ?? 'flag'}\n` + (m.color ? `  color: ${m.color}\n` : '')
        + `  label: ${JSON.stringify(m.label)}\n` + (m.note ? `  note: ${JSON.stringify(m.note)}\n` : '')).join('');
    fs.writeFileSync(path.join(dir, 'markers.yaml'), out);
    setKey('markers', `[${[...Object.keys(markers), ...show].join(', ')}]`);
  } else if (show.length) setKey('markers', `[${show.join(', ')}]`);
  if (routes) {
    fs.rmSync(path.join(dir, 'routes'), { recursive: true, force: true });
    if (Object.keys(routes).length) fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
    for (const [id, r] of Object.entries(routes)) {
      const props = { name: r.name, style: r.style ?? 'solid', arrows: r.arrows ?? true, ...(r.offset ? { offset: r.offset } : {}), ...(r.color ? { color: r.color } : {}) };
      fs.writeFileSync(path.join(dir, 'routes', id + '.geojson'), JSON.stringify({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: r.path.map(q => q.map(r5)) } }) + '\n');
    }
    // routes with the same group next to each other were travelled at once: the page lists them as one inner list
    const legs = [];
    for (const [id, r] of Object.entries(routes)) { const last = legs.at(-1); if (r.group && last?.group === r.group) last.ids.push(id); else legs.push({ group: r.group, ids: [id] }); }
    setKey('routes', `[${legs.map(l => l.ids.length > 1 ? `[${l.ids.join(', ')}]` : l.ids[0]).join(', ')}]`);
  }
  fs.writeFileSync(file, text);
}

// The Natural Earth 10m coastline of a country inside a box [w, s, e, n], the coast the map draws, so a plan can
// fit its water and walls to it. One list of [lon, lat] points per piece of the country that reaches into the box.
export function coast(country, [w, s, e, n]) {
  const world = require('world-atlas/countries-10m.json');
  const f = tc.feature(world, world.objects.countries).features.find(f => f.properties.name === country);
  if (!f) throw new Error(`"${country}" is not a country name in Natural Earth, as story.yaml's countries list spells them`);
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.map(p => p[0].filter(([x, y]) => x >= w && x <= e && y >= s && y <= n)).filter(pts => pts.length);
}
