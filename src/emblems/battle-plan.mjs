// A battle at one moment, as map geometry: unit blocks, movement arrows, rivers, walls and points of contact,
// each filled in its side's colour. Sizes are in metres, positions are [lon, lat].
//
// emblem:
//   kind: battle-plan
//   land:   [{ area: [[lon, lat], ...] }]     ground the base map's coast misses, in the land colour of its country
//   water:  [{ path: [[lon, lat], ...], width: 80 }, { area: [[lon, lat], ...] }]     rivers, lakes, coast
//   works:  [{ side: rome, path: [[lon, lat], ...], width: 40, style: trench }]        walls, ramparts, siege lines
//   units:  [{ side: carthage, type: infantry, at: [lon, lat], width: 1800, depth: 400, facing: 315, bow: 300 }]
//   arrows: [{ side: rome, path: [[lon, lat], ...], width: 160, style: dashed }]
//   clashes: [[lon, lat], ...]           or [{ at: [lon, lat], size: 250 }]
//
// Unit types: infantry (block with an X), cavalry (block with one diagonal), knights (heavy cavalry, block with two
// diagonals), pikes (a phalanx or pike block, files with points beyond the front), light (a loose row of squares),
// archers (a loose row of chevrons), irregular (militia and tribesmen, a broken outline), elephants (a row of discs),
// chariots (a row of cars on an axle with a pole), siege (siege engines, wedges on a base), artillery (a row of guns,
// a wheel with a barrel towards the enemy), armour (tanks, block with a track cut into it), aircraft (planes in a V),
// ships (a line of hulls, `rows`), submarines (hull outlines, `rows`), camp (a square ring), square (an infantry
// square, drawn as a camp), fort (a ring with a bastion at each corner, `width` across), wagons (war wagons end to end,
// chained, a board on the side towards the enemy, `rows` lines of them), wagon-fort (wagons chained in an oval ring,
// boards outwards, `depth` defaults to 0.6 of `width`, `gaps` leaves wagons out at compass bearings from its centre,
// for a gate, an opening or a breach: `gaps: [0, { bearing: 135, wagons: 3 }]`), handguns (a loose row of squares, each with a barrel towards
// the enemy), pavises (a row of tall shields). The rows take `count`.
// A work with style trench zigzags, the default is a straight wall.
// `facing` is the compass bearing the unit faces. `width` runs along its front, `depth` front to back.
// `bow` bends the front: positive pushes the centre towards the enemy, negative draws it back.
// `side` is a family of the story, or of the battle on a battle's page, `neutral` for a grey, or a hex colour.
// Arrows curve through their points, dashed is a retreat and fire is shooting, drawn as three thin arrows. A later
// arrow draws over an earlier one. Any unit, arrow, work or water can carry a `name`, shown when the reader points at
// it. Pieces with the same name highlight together. `id` sets the catalogue key, else it comes from the English name.
// harita checks the parameters against BattlePlan in src/schema.mjs before drawing.
import { buffer, polygon } from '@turf/turf';

const NEUTRAL = '#8c8c8c', WATER = '#5b9bd5', CLASH = '#f4c542';

export default function battlePlan(spec, { families = {} } = {}) {
  const { land = [], water = [], works = [], units = [], arrows = [], clashes = [] } = spec;
  const all = [...land.flatMap(l => l.area), ...water.flatMap(w => w.path ?? w.area), ...works.flatMap(w => w.path), ...units.map(u => u.at), ...arrows.flatMap(a => a.path), ...clashes.map(clashAt)];
  // one flat projection around the middle of the plan: metres east and north
  const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length, lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const toM = ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const toLL = ([x, y]) => [+(lon0 + x / kx).toFixed(5), +(lat0 + y / ky).toFixed(5)];
  // a side that is a family takes the family's colours, light or dark with the theme
  const look = s => families[s] ? { family: s, color: families[s].color } : s === 'neutral' ? { color: NEUTRAL } : /^#[0-9a-f]{6}$/i.test(s)
    ? { color: s } : fail(`unknown side "${s}", use a family (${Object.keys(families).join(', ')}), neutral or a hex colour`);
  const label = item => item.name == null ? {} : { id: item.id ?? slug(typeof item.name === 'string' ? item.name : item.name.en), name: item.name };
  const feats = [];
  const add = (rings, props) => { const closed = rings.filter(r => r.length >= 3).map(r => { const ll = r.map(toLL); ll.push(ll[0]); return ll; }); if (closed.length) feats.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: closed } }); };
  // a ring grown by pad metres on every side, with round corners
  const addGrown = (ring, pad, props) => { const ll = ring.map(toLL); ll.push(ll[0]); const { geometry } = buffer(polygon([ll]), pad, { units: 'meters' }); feats.push({ type: 'Feature', properties: props, geometry: { type: geometry.type, coordinates: rounded(geometry.coordinates) } }); };

  // the build gives land the tint of its country
  for (const l of land) add([l.area.map(toM)], { land: true });
  // a `water` family colours water per theme, for stories and battles whose sides are blue
  const wet = families.water ? { family: 'water', color: families.water.color } : { color: WATER };
  for (const w of water) {
    if (w.area) add([w.area.map(toM)], { ...wet, ...label(w) });
    else add([ribbon(smooth(w.path.map(toM)), w.width ?? 80, w.width ?? 80)], { ...wet, ...label(w) });
  }
  for (const w of works) {
    const pts = w.path.map(toM), width = w.width ?? 40;
    add([ribbon(w.style === 'trench' ? zigzag(pts, width * 3, width * 1.2) : pts, width, width)], { ...look(w.side ?? 'neutral'), ...label(w) });
  }
  // a named row of pieces gets an undrawn footprint, so the reader can point at the gaps as well as the pieces
  const gappy = new Set(['light', 'archers', 'irregular', 'elephants', 'chariots', 'siege', 'ships', 'submarines', 'artillery', 'aircraft',
    'wagons', 'wagon-fort', 'handguns', 'pavises']);
  for (const u of units) {
    if (u.name != null && gappy.has(u.type)) add([footprint(u, toM)], { ...look(u.side), ...label(u), hit: true });
    for (const rings of unitShapes(u, toM)) add(rings, { ...look(u.side), ...label(u) });
  }
  // each arrow sits on a slightly larger copy in the paper colour, so where two arrows cross the later one stands apart
  for (const a of arrows) {
    const pts = smooth(a.path.map(toM)), w = a.width ?? Math.max(40, length(pts) / 25), rings = arrowShapes(pts, w, a.style);
    if (a.name != null && a.style === 'dashed') add([ribbon(pts, a.width ?? 100, a.width ?? 100)], { ...look(a.side), ...label(a), hit: true });
    if (a.name != null && a.style === 'fire') add([ribbon(pts, w * 1.2, w * 4.4)], { ...look(a.side), ...label(a), hit: true });
    for (const ring of rings) addGrown(ring, w * 0.15, { casing: true, ...label(a) });
    for (const ring of rings) add([ring], { ...look(a.side), ...label(a) });
  }
  for (const c of clashes) add([star(toM(clashAt(c)), c.size ?? 150)], { color: CLASH });
  return { type: 'FeatureCollection', features: feats };
}

const clashAt = c => Array.isArray(c) ? c : c.at;
const rounded = c => typeof c[0] === 'number' ? c.map(v => +v.toFixed(5)) : c.map(rounded);
const slug = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fail = msg => { throw new Error(`battle-plan: ${msg}`); };

// --- units: drawn in local coordinates (u along the front to the right, v towards the enemy), then bent and placed ---
function unitShapes(u, toM) {
  const type = u.type ?? 'infantry', W = u.width, D = depthOf(u);
  const [cx, cy] = toM(u.at), th = (u.facing ?? 0) * Math.PI / 180, bow = u.bow ?? 0;
  const fx = Math.sin(th), fy = Math.cos(th), rx = Math.cos(th), ry = -Math.sin(th);
  // only a bent front needs extra points along its edges
  const place = ring => (bow ? densify(ring, Math.max(W, D) / 40) : ring).map(([a, b]) => { const v = b + bow * (1 - (2 * a / W) ** 2); return [cx + a * rx + v * fx, cy + a * ry + v * fy]; });
  const w = W / 2, d = D / 2, gap = Math.min(W, D) * 0.07;
  const A = [-w, -d], B = [w, -d], C = [w, d], E = [-w, d], O = [0, 0];
  if (type === 'infantry') // four triangles split by an X
    return [[A, B, O], [B, C, O], [C, E, O], [E, A, O]].map(t => [place(inset(t, [0, gap, gap]))]);
  if (type === 'cavalry') // two triangles split by one diagonal
    return [[[A, B, C], [0, 0, gap]], [[A, C, E], [gap, 0, 0]]].map(([t, o]) => [place(inset(t, o))]);
  if (type === 'camp' || type === 'square') { const t = Math.min(W, D) * 0.14; return [[place([A, B, C, E]), place([[-w + t, -d + t], [-w + t, d - t], [w - t, d - t], [w - t, -d + t]])]]; }
  if (type === 'light') {
    const s = D * 0.45, n = u.count ?? Math.max(3, Math.round(W / (s * 2.2)));
    return [...Array(n)].map((_, i) => { const x = -w + s / 2 + i * (W - s) / Math.max(1, n - 1), y = (i % 2 ? -1 : 1) * D * 0.18; return [place([[x - s / 2, y - s / 2], [x + s / 2, y - s / 2], [x + s / 2, y + s / 2], [x - s / 2, y + s / 2]])]; });
  }
  if (type === 'elephants') {
    const r = D * 0.42, n = u.count ?? Math.max(3, Math.round(W / (r * 3)));
    return [...Array(n)].map((_, i) => { const x = -w + r + i * (W - 2 * r) / Math.max(1, n - 1); return [place([...Array(16)].map((_, k) => [x + r * Math.cos(k * Math.PI / 8), r * Math.sin(k * Math.PI / 8)]))]; });
  }
  if (type === 'artillery') {
    const r = D * 0.26, n = u.count ?? Math.max(2, Math.round(W / (r * 4.5))), bw = r * 0.6, y = -d + r;
    return [...Array(n)].flatMap((_, i) => { const x = n === 1 ? 0 : -w + r + i * (W - 2 * r) / (n - 1);
      return [[place([...Array(16)].map((_, k) => [x + r * Math.cos(k * Math.PI / 8), y + r * Math.sin(k * Math.PI / 8)]))], [place([[x - bw / 2, y + r * 0.7], [x + bw / 2, y + r * 0.7], [x + bw / 2, d], [x - bw / 2, d]])]]; });
  }
  if (type === 'ships' || type === 'submarines') {
    const sub = type === 'submarines', n = u.count ?? 6, rows = u.rows ?? 1, cols = Math.ceil(n / rows), L = Math.min(D / rows * 0.85, W / cols * 1.6), beam = L * (sub ? 0.2 : 0.3);
    const out = [];
    for (let i = 0; i < n; i++) {
      const col = i % cols, row = Math.floor(i / cols), x = cols === 1 ? 0 : -w + beam + col * (W - 2 * beam) / (cols - 1), y = rows === 1 ? 0 : d - L / 2 - row * (D - L) / (rows - 1);
      const hull = (b, l) => { const side = [...Array(12)].map((_, k) => { const t = Math.PI * k / 11; return [x + b / 2 * Math.sin(t), y - l / 2 + l * (1 - Math.cos(t)) / 2]; }); return [...side, ...side.slice(1, -1).reverse().map(([a, c]) => [2 * x - a, c])]; };
      // a submarine is drawn as an outline, a ship filled
      out.push(sub ? [place(hull(beam, L)), place(hull(beam * 0.4, L * 0.78))] : [place(hull(beam, L))]);
    }
    return out;
  }
  if (type === 'knights') { // three pieces split by two diagonals
    const len = Math.hypot(W, D), nx = -D / len, ny = W / len, o = Math.min(W, D) * 0.16, h = gap / 2, R = [A, B, C, E];
    return [clip(R, -nx, -ny, o + h), clip(clip(R, nx, ny, h - o), -nx, -ny, h - o), clip(R, nx, ny, o + h)].map(t => [place(t)]);
  }
  if (type === 'pikes') { // files side by side, each ending in a point towards the enemy
    const n = u.count ?? Math.max(3, Math.round(W / (D * 0.6))), fw = (W - (n - 1) * gap) / n, tip = Math.min(D * 0.35, fw);
    return [...Array(n)].map((_, i) => { const x0 = -w + i * (fw + gap), x1 = x0 + fw; return [place([[x0, -d], [x1, -d], [x1, d - tip], [(x0 + x1) / 2, d], [x0, d - tip]])]; });
  }
  if (type === 'archers') { // a loose row of chevrons pointing at the enemy
    const s = D * 0.62, t = s * 0.34, n = u.count ?? Math.max(3, Math.round(W / (s * 1.5)));
    return [...Array(n)].map((_, i) => { const x = -w + s / 2 + i * (W - s) / Math.max(1, n - 1), y = (i % 2 ? -1 : 1) * D * 0.18;
      return [place([[x - s / 2, y - s / 2], [x, y + s / 2], [x + s / 2, y - s / 2], [x + s / 2 - t, y - s / 2], [x, y + s / 2 - t * 1.8], [x - s / 2 + t, y - s / 2]])]; });
  }
  if (type === 'irregular') { // the block's outline in dashes, for a body without a set formation
    const t = Math.min(W, D) * 0.14, dash = t * 2.5, space = t * 1.5;
    const dashes = (len, at) => { const n = Math.max(1, Math.round((len + space) / (dash + space))), l = (len - (n - 1) * space) / n; return [...Array(n)].map((_, i) => at(i * (l + space), i * (l + space) + l)); };
    return [...dashes(W, (a, b) => [[-w + a, -d], [-w + b, -d], [-w + b, -d + t], [-w + a, -d + t]]), ...dashes(W, (a, b) => [[-w + a, d - t], [-w + b, d - t], [-w + b, d], [-w + a, d]]),
      ...dashes(D - 2 * t, (a, b) => [[-w, -d + t + a], [-w + t, -d + t + a], [-w + t, -d + t + b], [-w, -d + t + b]]), ...dashes(D - 2 * t, (a, b) => [[w - t, -d + t + a], [w, -d + t + a], [w, -d + t + b], [w - t, -d + t + b]])].map(q => [place(q)]);
  }
  if (type === 'chariots') { // each a car between two wheels, and a pole towards the enemy
    const s = D * 0.9, n = u.count ?? Math.max(2, Math.round(W / (s * 1.3))), r = s * 0.13;
    return [...Array(n)].flatMap((_, i) => { const x = n === 1 ? 0 : -w + s * 0.45 + i * (W - s * 0.9) / (n - 1);
      return [rect(x - s * 0.18, -s * 0.5, x + s * 0.18, -s * 0.1), disc(x - s * 0.32, -s * 0.3, r), disc(x + s * 0.32, -s * 0.3, r),
        rect(x - s * 0.32, -s * 0.33, x + s * 0.32, -s * 0.27), rect(x - s * 0.04, -s * 0.1, x + s * 0.04, s * 0.5)].map(q => [place(q)]); });
  }
  if (type === 'siege') { // engines in a row: a wedge on a base, pointing at the enemy
    const s = D * 0.9, n = u.count ?? Math.max(2, Math.round(W / (s * 1.2)));
    return [...Array(n)].flatMap((_, i) => { const x = n === 1 ? 0 : -w + s * 0.35 + i * (W - s * 0.7) / (n - 1);
      return [[place(rect(x - s * 0.35, -s * 0.5, x + s * 0.35, -s * 0.2))], [place([[x - s * 0.14, -s * 0.2], [x + s * 0.14, -s * 0.2], [x, s * 0.5]])]]; });
  }
  if (type === 'armour') { // a block with the outline of a track cut into it
    const t = Math.min(W, D) * 0.1, ow = w * 0.6, oh = d * 0.5;
    return [[place([A, B, C, E]), place(stadium(ow + t / 2, oh + t / 2))], [place(stadium(ow - t / 2, oh - t / 2))]];
  }
  if (type === 'aircraft') { // planes in a V, the leader forward, noses towards the enemy
    const n = u.count ?? Math.max(3, Math.round(W / D)), s = Math.min(D * 0.8, W / n * 0.9);
    return [...Array(n)].flatMap((_, i) => { const x = n === 1 ? 0 : -w + s / 2 + i * (W - s) / (n - 1), y = d - s / 2 - Math.abs(x) / Math.max(w, 1e-9) * (D - s);
      return [[[x - s * 0.06, y - s * 0.5], [x + s * 0.06, y - s * 0.5], [x + s * 0.06, y + s * 0.38], [x, y + s * 0.5], [x - s * 0.06, y + s * 0.38]],
        [[x - s * 0.5, y - s * 0.08], [x + s * 0.5, y - s * 0.08], [x + s * 0.08, y + s * 0.16], [x - s * 0.08, y + s * 0.16]],
        [[x - s * 0.2, y - s * 0.5], [x + s * 0.2, y - s * 0.5], [x + s * 0.05, y - s * 0.36], [x - s * 0.05, y - s * 0.36]]].map(q => [place(q)]); });
  }
  if (type === 'wagons') { // carts end to end in each row, chained, wheels behind and a board towards the enemy
    const rows = u.rows ?? 1, b = D / rows, n = u.count ?? Math.max(2, Math.round(W / (b * 1.5))), l = W / n * 0.82;
    return [...Array(rows)].flatMap((_, k) => {
      const yr = rows === 1 ? 0 : -d + b / 2 + k * b, xs = [...Array(n)].map((_, i) => n === 1 ? 0 : -w + l / 2 + i * (W - l) / (n - 1));
      return wagonRow(xs.map(x => [x, yr]), xs.map(() => [1, 0]), l, b * 0.46).map(q => [place(q)]);
    });
  }
  if (type === 'wagon-fort') { // carts chained in an oval ring, boards outwards
    const ring = ellipse(w, d, 360), cum = [0];
    for (let k = 1; k <= ring.length; k++) cum.push(cum[k - 1] + Math.hypot(ring[k % ring.length][0] - ring[k - 1][0], ring[k % ring.length][1] - ring[k - 1][1]));
    const P = cum.at(-1), n = u.count ?? Math.max(8, Math.round(P / (Math.min(W, D) * 0.3))), l = P / n * 0.78;
    // the point and the direction of travel at arc length s
    const along = s => { const k = Math.max(0, cum.findIndex(c => c > s) - 1), p = ring[k], q = ring[(k + 1) % ring.length], t = (s - cum[k]) / (cum[k + 1] - cum[k]), len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      return { at: [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])], dir: [(q[0] - p[0]) / len, (q[1] - p[1]) / len] }; };
    const carts = [...Array(n)].map((_, i) => along((i + 0.5) * P / n));
    // a gap removes the wagons nearest its compass bearing, measured from the fort's centre
    const skip = new Set(), bearingOf = ([a, b]) => ((u.facing ?? 0) + Math.atan2(a, b) * 180 / Math.PI + 360) % 360;
    for (const g of u.gaps ?? []) {
      const { bearing, wagons = 1 } = typeof g === 'number' ? { bearing: g } : g, off = i => Math.abs(((bearingOf(carts[i].at) - bearing) % 360 + 540) % 360 - 180);
      [...carts.keys()].sort((i, j) => off(i) - off(j)).slice(0, wagons).forEach(i => skip.add(i));
    }
    return wagonRow(carts.map(c => c.at), carts.map(c => c.dir), l, Math.min(l * 0.58, Math.min(w, d) * 0.3), true, skip).map(q => [place(q)]);
  }
  if (type === 'handguns') { // a loose row of small squares, each with a barrel towards the enemy
    const s = D * 0.38, n = u.count ?? Math.max(3, Math.round(W / (s * 2.2))), bw = s * 0.22;
    return [...Array(n)].flatMap((_, i) => { const x = -w + s / 2 + i * (W - s) / Math.max(1, n - 1), y = (i % 2 ? -0.3 : -0.12) * D;
      return [[place(rect(x - s / 2, y - s / 2, x + s / 2, y + s / 2))], [place(rect(x - bw / 2, y + s / 2, x + bw / 2, y + s * 1.4))]]; });
  }
  if (type === 'pavises') { // tall shields side by side, rounded at the end towards the enemy
    const n = u.count ?? Math.max(3, Math.round(W / (D * 0.45))), sw = (W - (n - 1) * gap) / n, h = D * 0.8, r = Math.min(sw / 2, h / 2);
    return [...Array(n)].map((_, i) => { const x0 = -w + i * (sw + gap), xm = x0 + sw / 2, top = h / 2 - r;
      return [place([[x0, -h / 2], [x0 + sw, -h / 2], ...[...Array(9)].map((_, k) => [xm + sw / 2 * Math.cos(Math.PI * k / 8), top + r * Math.sin(Math.PI * k / 8)])])]; });
  }
  if (type === 'fort') { // walls round a square court with a bastion at each corner, width across
    const m = w * 0.74, c = w * 0.42;
    return [[place([[-w, -w], [0, -m], [w, -w], [m, 0], [w, w], [0, m], [-w, w], [-m, 0]]), place(rect(-c, -c, c, c))]];
  }
}
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const depthOf = u => u.depth ?? (u.type === 'wagon-fort' ? u.width * 0.6 : Math.max(60, u.width / 5));
const ellipse = (a, b, n) => [...Array(n)].map((_, k) => [a * Math.cos(2 * Math.PI * k / n), b * Math.sin(2 * Math.PI * k / n)]);
// wagons l long and t deep at the given centres, each along its direction: a body with two wheels on the inner side,
// a board on the outer side and a chain to the next wagon. Outer is the left of the direction for a row, away from
// the centre for a ring, which also chains the last wagon to the first.
function wagonRow(centres, dirs, l, t, ring = false, skip = new Set()) {
  const out = [], ends = [];
  centres.forEach(([cx, cy], i) => {
    let [tx, ty] = dirs[i], [nx, ny] = [-ty, tx];
    if (ring && nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
    const pt = (p, q) => [cx + p * tx + q * nx, cy + p * ty + q * ny], box = (p0, q0, p1, q1) => [pt(p0, q0), pt(p1, q0), pt(p1, q1), pt(p0, q1)];
    ends.push([pt(-l / 2, -t * 0.19), pt(l / 2, -t * 0.19)]);
    if (skip.has(i)) return;
    out.push(box(-l / 2, -t * 0.5, l / 2, t * 0.12), box(-l / 2, t * 0.26, l / 2, t * 0.5));
    for (const p of [-l * 0.3, l * 0.3]) out.push([...Array(12)].map((_, k) => pt(p + t * 0.2 * Math.cos(k * Math.PI / 6), -t * 0.5 + t * 0.2 * Math.sin(k * Math.PI / 6))));
  });
  // a chain is a thin band from the end of one wagon to the start of the next
  for (let i = 0; i < ends.length - (ring ? 0 : 1); i++) {
    if (skip.has(i) || skip.has((i + 1) % ends.length)) continue;
    const a = ends[i][1], b = ends[(i + 1) % ends.length][0], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const h = t * 0.06, ox = -(b[1] - a[1]) / len * h, oy = (b[0] - a[0]) / len * h;
    out.push([[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy], [b[0] - ox, b[1] - oy], [a[0] - ox, a[1] - oy]]);
  }
  return out;
}
const disc = (x, y, r) => [...Array(16)].map((_, k) => [x + r * Math.cos(k * Math.PI / 8), y + r * Math.sin(k * Math.PI / 8)]);
// a long oval: a rectangle with round ends, half width a and half height b around the origin
const stadium = (a, b) => { const r = Math.min(a, b), c = a - r; return [...Array(12)].map((_, k) => { const t = -Math.PI / 2 + Math.PI * k / 11; return [c + r * Math.cos(t), r * Math.sin(t)]; })
  .concat([...Array(12)].map((_, k) => { const t = Math.PI / 2 + Math.PI * k / 11; return [-c + r * Math.cos(t), r * Math.sin(t)]; })); };
// the part of a convex polygon where nx * x + ny * y >= c
function clip(poly, nx, ny, c) {
  const out = [], inside = p => nx * p[0] + ny * p[1] >= c;
  poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length], a = nx * p[0] + ny * p[1] - c, b = nx * q[0] + ny * q[1] - c;
    if (inside(p)) out.push(p);
    if ((a >= 0) !== (b >= 0)) { const t = a / (a - b); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); } });
  return out;
}

// the rectangle a unit stands in, placed and bent like the unit
function footprint(u, toM) {
  const W = u.width, D = depthOf(u), [cx, cy] = toM(u.at), th = (u.facing ?? 0) * Math.PI / 180, bow = u.bow ?? 0;
  const fx = Math.sin(th), fy = Math.cos(th), rx = Math.cos(th), ry = -Math.sin(th), w = W / 2, d = D / 2;
  // a wagon fort can be pointed at anywhere inside its ring
  return (u.type === 'wagon-fort' ? ellipse(w, d, 64) : densify([[-w, -d], [w, -d], [w, d], [-w, d]], Math.max(W, D) / 40)).map(([a, b]) => { const v = b + bow * (1 - (2 * a / W) ** 2); return [cx + a * rx + v * fx, cy + a * ry + v * fy]; });
}

// move the edges of a convex polygon inwards, edge i (from vertex i to i+1) by offsets[i]
function inset(poly, offsets) {
  const n = poly.length, lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
    const sign = area(poly) > 0 ? 1 : -1, o = offsets[i] * sign; return [[p[0] + nx * o, p[1] + ny * o], [q[0] + nx * o, q[1] + ny * o]];
  });
  return lines.map((l, i) => cross(lines[(i + n - 1) % n], l));
}
const area = p => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
function cross([[x1, y1], [x2, y2]], [[x3, y3], [x4, y4]]) {
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4); if (Math.abs(den) < 1e-9) return [x2, y2];
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den; return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
function densify(ring, step) {
  const out = [];
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step)); for (let k = 0; k < n; k++) out.push([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n]); });
  return out;
}

// --- lines: Catmull-Rom through the given points, then a band of the given width ---
function smooth(pts) {
  if (pts.length < 3) return pts;
  const out = [], P = [pts[0], ...pts, pts.at(-1)];
  for (let i = 1; i < P.length - 2; i++) for (let k = 0; k < 12; k++) {
    const t = k / 12, [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    out.push([0, 1].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3)));
  }
  out.push(pts.at(-1));
  return out;
}
const normals = pts => pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
function ribbon(pts, w0, w1) {
  const nm = normals(pts), n = pts.length, half = i => (w0 + (w1 - w0) * i / Math.max(1, n - 1)) / 2;
  return [...pts.map((p, i) => [p[0] + nm[i][0] * half(i), p[1] + nm[i][1] * half(i)]), ...pts.map((p, i) => [p[0] - nm[i][0] * half(i), p[1] - nm[i][1] * half(i)]).reverse()];
}
// cut a line at length s from its start
function cutAt(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc + l >= s) { const t = (s - acc) / l; return [...pts.slice(0, i), [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]]; } acc += l; }
  return pts;
}
const length = pts => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
// a line resampled every step metres, with the points pushed alternately amp to either side
function zigzag(pts, step, amp) {
  const L = length(pts), n = Math.max(2, Math.round(L / step)), at = [...Array(n + 1)].map((_, i) => cutAt(pts, L * i / n).at(-1)), nm = normals(at);
  return at.map((p, i) => i === 0 || i === n ? p : [p[0] + nm[i][0] * amp * (i % 2 ? 1 : -1), p[1] + nm[i][1] * amp * (i % 2 ? 1 : -1)]);
}

// a solid arrow is one ring, a dashed one a head and dashes, fire three thin arrows that spread towards the target
function arrowShapes(pts, w, style) {
  if (style === 'fire') {
    const nm = normals(pts), at = [0];
    for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return [-1, 0, 1].map(k => arrowRing(pts.map((p, i) => { const o = k * w * 1.6 * (0.3 + 0.7 * at[i] / at.at(-1)); return [p[0] + nm[i][0] * o, p[1] + nm[i][1] * o]; }), w * 0.25, w * 0.3, w * 1.4, w * 0.6));
  }
  if (style !== 'dashed') return [arrowRing(pts, w * 0.55, w, w * 2.6, w * 1.25)];
  const { shaft, head } = headOf(pts, w * 2.6, w * 1.25), out = [head], dash = w * 2.2, gap = w * 1.4, Ls = length(shaft);
  for (let s = 0; s < Ls - 1; s += dash + gap) { const piece = cutAt(shaft, Math.min(Ls, s + dash)), from = cutAt(piece, s); const seg = [from.at(-1), ...piece.slice(from.length - 1)]; if (seg.length >= 2) out.push(ribbon(seg, w * 0.8, w * 0.8)); }
  return out;
}
// the head at the end of pts, `len` long and 2 * hw wide, and the shaft that leads to it
function headOf(pts, len, hw) {
  const L = length(pts), shaft = cutAt(pts, L - Math.min(len, L * 0.4)), base = shaft.at(-1), [nx, ny] = normals(shaft).at(-1);
  return { shaft, head: [[base[0] + nx * hw, base[1] + ny * hw], pts.at(-1), [base[0] - nx * hw, base[1] - ny * hw]] };
}
// one ring for an arrow along pts, its shaft widening from w0 to w1
function arrowRing(pts, w0, w1, len, hw) {
  const { shaft, head } = headOf(pts, len, hw), side = ribbon(shaft, w0, w1);
  return [...side.slice(0, shaft.length), ...head, ...side.slice(shaft.length)];
}

function star([x, y], r) {
  return [...Array(16)].map((_, k) => { const t = k * Math.PI / 8 + Math.PI / 16, rr = k % 2 ? r * 0.42 : r; return [x + rr * Math.cos(t), y + rr * Math.sin(t)]; });
}
