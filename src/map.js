// The map engine's client: everything inside the stage. kitap's shell mounts it with a host that carries the bundle,
// the stage's elements, the current page and language, and the shell's helpers. The map's own bundle sits under
// B.harita and a page's map fields under page.harita; here H and M(page) read them.
window.KITAP_ENGINE = function (host) {
const { B, el, L, T, css, colorVar, esc, $, pref, savePref, reduced, canHover, phone } = host;
const H = B.harita, ICONS = B.icons;
// the overview shows the whole extent with nothing on it
const OVERVIEW = { id: null, zones: [], routes: [], markers: [], battle: null, emblem: null, emblemNames: {}, bbox: H.extent, camera: null };
const M = p => p.id == null ? OVERVIEW : p.harita;
const here = () => M(host.here());
const lang = () => host.lang();
const legend = el.legend, story = el.story, extra = el.extra;
const fitPadding = host.padding;
// a route takes the colour of the family that travels it, else the theme's route colour
const routeVar = id => H.routes[id].color ? colorVar(H.routes[id].color) : '--route';
// the routes of one colour on a page are the legs of one march, numbered in the order the page lists them. The last
// has the full colour, the ones before it a lightness nearer the middle, where a colour keeps the most strength, the
// earlier the more: shade is that share of LEG_SHADE. A route without arrows marks a front or a border and keeps the
// full colour.
const LEG_SHADE = 0.18;
// a group the page lists in a list of its own, such as the columns of one army, is one leg
const legOf = (page, id) => { const g = page.groups?.findIndex(ids => ids.includes(id)) ?? -1; return g < 0 ? id : 'group ' + g; };
function routeLegs(page){
  const marches = {}, legs = {};
  for (const id of page.routes) {
    legs[id] = { shade: 0, n: null }; if (!H.routes[id].arrows) continue;
    const m = marches[routeVar(id)] ??= new Map(), leg = legOf(page, id); m.set(leg, [...(m.get(leg) ?? []), id]);
  }
  for (const m of Object.values(marches)) { const steps = [...m.values()]; if (steps.length > 1) steps.forEach((ids, i) => { for (const id of ids) legs[id] = { shade: (steps.length - 1 - i) / (steps.length - 1), n: i + 1 }; }); }
  return legs;
}
// #rrggbb to OKLCH and back: a leg keeps its hue and as much of its chroma as sRGB holds at its new lightness
const toLinear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
function oklch(hex){
  const [r, g, b] = [1, 3, 5].map(i => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];
}
function srgb(L, C, h){
  const a = C * Math.cos(h), bb = C * Math.sin(h), l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
function lighten(hex, dL){
  const [L, C, h] = oklch(hex), L2 = Math.min(0.92, Math.max(0.2, L + dL));
  let rgb = srgb(L2, C, h);
  for (let c = C; rgb.some(v => v < -0.001 || v > 1.001) && c > 0.001; c *= 0.92) rgb = srgb(L2, c, h);
  return '#' + rgb.map(v => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, '0')).join('');
}
// a route's colour on a page: a light colour darker, a dark one lighter
function legColor(id, leg){
  const c = css(routeVar(id)); if (!leg.shade) return c;
  return lighten(c, LEG_SHADE * leg.shade * (oklch(c)[0] > 0.55 ? -1 : 1));
}
// A 16 px tile in the family colour, drawn so it repeats without seams: hatch, cross or dots.
function patternImage(kind, color){
  const s = 16, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = color; g.lineWidth = 2;
  const line = (x0, y0, x1, y1) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  if (kind === 'hatch' || kind === 'cross') { line(0, s, s, 0); line(0, s / 2, s / 2, 0); line(s / 2, s, s, s / 2); }
  if (kind === 'cross') { line(0, 0, s, s); line(s / 2, 0, s, s / 2); line(0, s / 2, s / 2, s); }
  if (kind === 'dots') for (const [x, y] of [[s / 4, s / 4], [3 * s / 4, 3 * s / 4]]) { g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
  return g.getImageData(0, 0, s, s);
}
const patternCss = family => {
  const c = `var(${colorVar(family)})`, p = B.families[family]?.pattern, hatch = a => `repeating-linear-gradient(${a}deg, ${c} 0 1.5px, transparent 1.5px 5px)`;
  const img = p === 'hatch' ? hatch(45) : p === 'cross' ? `${hatch(45)}, ${hatch(-45)}` : p === 'dots' ? `radial-gradient(${c} 1.2px, transparent 1.5px) 0 0 / 5px 5px` : 'none';
  return `background:${img}, color-mix(in srgb, ${c} 55%, transparent);border-color:${c}`;
};
const DUR = reduced ? 0 : 1400;

// ---------- shared helpers ----------
const countries = topojson.feature(H.topo, H.topo.objects.countries);
// the theme's land tints, picked per country by the tint index the build assigned
// Noto Sans glyphs, SIL Open Font License, fetched by range from the Protomaps assets host when a story labels its countries
// the label glyphs harita copies to dist/vendor/glyphs/; MapLibre wants an absolute URL, and fills in the braces itself
const GLYPHS = new URL('../vendor/glyphs/', document.baseURI).href + '{fontstack}/{range}.pbf';
const landFill = () => { const tints = [...Array(8)].map((_, i) => css(`--land-${i}`).trim()); return ['match', ['get', 'tint'], ...tints.flatMap((c, i) => [i, c]), tints[0]]; };
// zone outlines come from one topology, decoded the first time a page shows the zone; a zone smaller than a pixel
// on every page that shows it has no outline in it
const ZONE_SHAPES = Object.fromEntries(H.zoneShapes.objects.zones.geometries.map(g => [g.id, g]));
const zoneFeature = id => ({ type:'Feature', properties:{ id }, geometry: ZONE_SHAPES[id] ? topojson.feature(H.zoneShapes, ZONE_SHAPES[id]).geometry : null });
const HIDDEN = { visibility:'none' };
const routeFeature = (id, coords) => ({ type:'Feature', properties:{ id }, geometry:{ type:'LineString', coordinates: coords } });
const sliceRoute = (coords, t) => t <= 0 ? [] : turf.lineSliceAlong(turf.lineString(coords), 0, t * turf.length(turf.lineString(coords))).geometry.coordinates;
function markerEl(m, battle){
  const el = document.createElement('div'); el.className = battle ? 'mk battle' : 'mk'; el.style.setProperty('--c', `var(${colorVar(m.color)})`);
  const im = m.image ? B.images[m.image] : null;
  const photo = im ? `<img class="ph" src="${esc(im.thumb)}" alt="${esc(L(im.caption))}" tabindex="0" data-img="${esc(m.image)}"><span class="ic badge">${ICONS[m.icon]}</span>` : `<span class="ic">${ICONS[m.icon]}</span>`;
  el.innerHTML = `<span class="wrap">${photo}</span><b>${esc(L(m.label))}</b><small>${esc(L(m.note))}</small>`;
  return el;
}
// ---------- battles ----------
const sideColor = c => !c ? 'var(--rule)' : c.startsWith('#') ? c : `var(--z-${c})`;
function battleCard(b){
  const el = document.createElement('div'); el.className = 'bc';
  const side = s => `<div class="side" style="--c:${sideColor(s.color)}"><h5>${esc(L(s.name))}</h5><dl>
    ${s.commanders.length ? `<dt>${esc(T().commanders)}</dt><dd><ul>${s.commanders.map(c => `<li>${esc(L(c))}</li>`).join('')}</ul></dd>` : ''}
    ${s.strength ? `<dt>${esc(T().strength)}</dt><dd>${esc(L(s.strength))}</dd>` : ''}
    ${s.casualties ? `<dt>${esc(T().casualties)}</dt><dd>${esc(L(s.casualties))}</dd>` : ''}</dl></div>`;
  const pics = b.images.map(id => B.images[id]);
  // the caption sits outside the fixed height slide, else it spills under the arrows
  const pic = i => `<img src="${esc(pics[i].src)}" alt="${esc(L(pics[i].caption))}" data-img="${esc(b.images[i])}">`;
  const cap = i => esc(L(pics[i].caption));
  el.innerHTML = `<header><span class="ic">${ICONS.swords}</span><div><h4>${esc(L(b.name))}</h4><small>${esc(L(b.date))}</small></div></header>
    ${pics.length ? `<figure class="pic"><div class="slide">${pic(0)}</div><figcaption>${cap(0)}</figcaption>${pics.length > 1 ? `<div class="nav"><button type="button" data-dir="-1" aria-label="${esc(T().previous_image)}">${ICONS['chevron-left']}</button><span class="n">1 / ${pics.length}</span><button type="button" data-dir="1" aria-label="${esc(T().next_image)}">${ICONS['chevron-right']}</button></div>` : ''}</figure>` : ''}
    ${b.result ? `<div class="result"><b>${esc(T().result)}</b><span>${esc(L(b.result))}</span></div>` : ''}
    <div class="sides">${b.sides.map(side).join('')}</div>
    ${b.source ? `<footer><a href="${esc(b.source)}" target="_blank" rel="noopener">${esc(T().source)} ${ICONS['external-link']}</a></footer>` : ''}`;
  if (pics.length > 1) { // little arrows step through the images without closing the card
    let i = 0;
    el.querySelectorAll('.nav button').forEach(btn => btn.onclick = e => { e.stopPropagation(); i = (i + Number(btn.dataset.dir) + pics.length) % pics.length; el.querySelector('.slide').innerHTML = pic(i); el.querySelector('figcaption').innerHTML = cap(i); el.querySelector('.n').textContent = `${i + 1} / ${pics.length}`; });
  }
  return el;
}
// A phone shows a battle's card at the top of the text, under the page's title, and a tap on the battle scrolls
// there. A kitap without that box, or a wider screen, shows the card on the map.
const cardInText = () => phone.matches && !!extra && !!host.showText;
function renderTextCard(page){ extra?.replaceChildren(...(page.battle ? [battleCard(H.battles[page.battle])] : [])); }
let battlePopup = null;
// a map with room for the card beside the battle shows it there, a narrow one above it
const cardBeside = () => $('map').getBoundingClientRect().width >= 700;
function openBattle(id){
  const m = ML.map; if (!m) return;
  closeBattle();
  const beside = cardBeside(), at = H.battles[id].lnglat;
  // beside, the card clears the battle's label, which hangs centred under the marker
  const mark = beside && ML.markers['battle:' + id]?.getElement();
  const offset = mark ? Math.max(30, mark.getBoundingClientRect().width / 2 + 12) : 30;
  const popup = new maplibregl.Popup({ offset, maxWidth: 'none', focusAfterOpen: false, anchor: beside ? 'left' : 'bottom', closeOnClick: false }).setLngLat(at).setDOMContent(battleCard(H.battles[id])).addTo(m);
  battlePopup = popup;
  // the card's own × closes it; that counts as the reader closing it, so the map slides back
  popup.on('close', () => { if (battlePopup !== popup) return; battlePopup = null; restoreNudge(); });
  // beside: the map slides so the battle and its card sit together in the middle, the battle left of centre.
  // above: the map slides only if the card runs past its edge
  const place = () => {
    if (battlePopup !== popup) return;
    const r = popup.getElement().getBoundingClientRect(), s = $('map').getBoundingClientRect(), pad = 12;
    let dx = 0, dy = 0;
    if (beside) {
      const p = m.project(at), span = r.right - s.left - p.x;
      dx = p.x - (s.width - span) / 2; dy = p.y - s.height / 2;
    } else {
      if (r.top < s.top + pad) dy = r.top - (s.top + pad); else if (r.bottom > s.bottom - pad) dy = r.bottom - (s.bottom - pad);
      if (r.left < s.left + pad) dx = r.left - (s.left + pad); else if (r.right > s.right - pad) dx = r.right - (s.right - pad);
    }
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    // phones and the card beside the battle remember where the map was, to slide back when the reader closes the card
    if (beside || matchMedia('(max-width:900px)').matches) ML.beforeNudge = m.getCenter();
    m.panBy([dx, dy], { duration: reduced ? 0 : 400 });
  };
  // the slide waits for the page's camera to land, so the two moves do not fight
  requestAnimationFrame(() => { if (m.isMoving()) m.once('moveend', place); else place(); });
}
// restore: the reader closed the card, so undo the slide; a page change or a new card closes without it
function closeBattle(restore = false){
  const p = battlePopup; if (!p) return;
  battlePopup = null; p.remove();
  if (restore) restoreNudge(); else ML.beforeNudge = null;
}
function restoreNudge(){
  const c = ML.beforeNudge; ML.beforeNudge = null;
  if (c && ML.map) ML.map.easeTo({ center: c, duration: reduced ? 0 : 400 });
}

// ---------- terrain ----------
// The build cut elevation tiles for the story's extent at low zoom and for each page's area at the zooms it opens
// at. The map asks only for those; a refused tile makes it draw the parent tile instead.
const hasTile = (z, x, y) => (H.terrain.ranges[z] ?? []).some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
if (window.maplibregl) maplibregl.addProtocol('dem', async (params, abort) => {
  const [z, x, y] = params.url.slice('dem://'.length).split('/').map(Number);
  if (!hasTile(z, x, y)) throw new Error('no elevation tile');
  const res = await fetch(H.terrain.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal: abort.signal });
  if (!res.ok) throw new Error(`elevation tile ${z}/${x}/${y}: HTTP ${res.status}`);
  return { data: await res.arrayBuffer() };
});
const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;
// relief in the theme's colours: on light paper the shadows take the ink and lit slopes the paper, on dark paper
// the shadows go black and lit slopes take a little of the light ink
function hillPaint(){
  const paper = css('--paper'), ink = css('--ink'), [r, g, b] = hexRgb(paper), dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  return { 'hillshade-exaggeration': 0.7, 'hillshade-shadow-color': dark ? 'rgba(0,0,0,0.6)' : rgba(ink, 0.5),
    'hillshade-highlight-color': dark ? rgba(ink, 0.12) : rgba(paper, 0.55), 'hillshade-accent-color': dark ? 'rgba(0,0,0,0.3)' : rgba(ink, 0.2) };
}

// ---------- map ----------
const ML = { map:null, ready:false, markers:{}, legs:{}, anim:{}, shown:{}, camera:0, zoneData:new Set(), zoneHide:{} };
function mapInit(){
  if (!window.maplibregl) { $('map').innerHTML = `<div class="fail">${esc(T().map_failed_cdn)}</div>`; return; }
  const [w, s, e, n] = H.extent;
  let m;
  try {
    m = new maplibregl.Map({
      container:'map', attributionControl:false, canvasContextAttributes:{ antialias:true }, // smooths the emblem's edges, see below
      style:{ version:8, sources:{}, ...(H.labels ? { glyphs: GLYPHS } : {}), layers:[{ id:'bg', type:'background', paint:{ 'background-color': css('--sea') } }] },
      bounds:[[w, s], [e, n]], minZoom:3.5, maxZoom:H.maxZoom ?? 11, dragRotate:false, touchPitch:false, keyboard:false // arrow keys step pages, never pan
    });
    m.touchZoomRotate.disableRotation(); // turning and tilting are for the 3D view, see freeCamera
  } catch (err) { // no WebGL: keep the text and navigation working without the map
    $('map').innerHTML = `<div class="fail">${esc(T().map_failed_webgl)}</div>`; return;
  }
  ML.map = m;
  CO.layer = document.createElement('div'); CO.layer.className = 'callouts';
  CO.layer.innerHTML = '<svg aria-hidden="true"></svg>'; el.map.appendChild(CO.layer); CO.svg = CO.layer.firstChild;
  // the markers have moved by the time a frame renders, so the lines follow them
  m.on('render', placeCallouts);
  m.on('resize', calloutMode);
  // a story wider than the map at zoom 3.5, such as one from Greenland to the Caspian, zooms out until its extent fits
  const fitExtent = () => m.setMinZoom(Math.min(3.5, (m.cameraForBounds([[w, s], [e, n]], { padding: fitPadding() })?.zoom ?? 3.5) - 0.2));
  fitExtent(); m.on('resize', fitExtent);
  m.on('movestart', e => { if (e.originalEvent) ML.beforeNudge = null; });
  m.on('error', e => { if (!e.sourceId?.startsWith('dem')) console.error(e.error ?? e); }); // a refused elevation tile is expected
  // pointing at a zone or a route highlights it; on touch screens a tap does, and a tap on empty map clears it
  let pending = null;
  m.on('mousemove', e => { if (!canHover.matches || !ML.ready) return; const first = !pending; pending = e; if (first) requestAnimationFrame(() => { const ev = pending; pending = null; const h = !onOverlay(ev) && hitAt(ev.point); h ? setHighlight(h.kind, h.id, ev.point) : clearHighlight(); }); });
  m.on('mouseout', () => { if (canHover.matches) clearHighlight(); });
  m.on('click', e => { if (canHover.matches || !ML.ready || onOverlay(e)) return; const h = hitAt(e.point); h ? setHighlight(h.kind, h.id, null) : clearHighlight(); });
  m.on('load', () => {
    m.setPaintProperty('bg', 'background-color', css('--sea')); // the theme may have changed while the map loaded
    m.addSource('countries', { type:'geojson', data: countries });
    m.addSource('land', { type:'geojson', data: H.land });
    m.addLayer({ id:'land', type:'fill', source:'countries', paint:{ 'fill-color': landFill() } });
    // one source shades the relief, another lifts the 3D terrain; MapLibre draws both better when they are separate
    const dem = { type:'raster-dem', tiles:['dem://{z}/{x}/{y}'], tileSize:256, encoding:'terrarium', maxzoom: H.terrain.maxzoom };
    m.addSource('dem', dem); m.addSource('dem-3d', dem);
    m.addLayer({ id:'hill', type:'hillshade', source:'dem', paint: hillPaint() });
    for (const f in B.families) if (B.families[f].pattern) m.addImage('pat-' + f, patternImage(B.families[f].pattern, css(colorVar(f))));
    for (const id in H.zones) {
      const f = H.zones[id].family, c = css(colorVar(f));
      m.addSource('z-' + id, { type:'geojson', data:{ type:'FeatureCollection', features: [] } });
      m.addLayer({ id:'z-' + id, type:'fill', source:'z-' + id, layout: HIDDEN, paint:{ 'fill-color': c, 'fill-opacity':0, 'fill-opacity-transition':{ duration:600 } } });
      if (B.families[f].pattern) m.addLayer({ id:'zp-' + id, type:'fill', source:'z-' + id, layout: HIDDEN, paint:{ 'fill-pattern': 'pat-' + f, 'fill-opacity':0, 'fill-opacity-transition':{ duration:600 } } });
      m.addLayer({ id:'zl-' + id, type:'line', source:'z-' + id, layout: HIDDEN, paint:{ 'line-color': c, 'line-width':1, 'line-opacity':0, 'line-opacity-transition':{ duration:600 } } });
    }
    m.addLayer({ id:'borders', type:'line', source:'countries', paint:{ 'line-color': css('--border'), 'line-width':0.8, 'line-dasharray':[2, 2] } });
    m.addLayer({ id:'land-outline', type:'line', source:'land', paint:{ 'line-color': css('--ink'), 'line-width':1.2 } });
    for (const id in H.routes) {
      m.addSource('r-' + id, { type:'geojson', data: routeFeature(id, []) });
      const offset = H.routes[id].offset; // line-offset and the arrows' offset both count to the right of travel
      m.addLayer({ id:'rc-' + id, type:'line', source:'r-' + id, layout:{ 'line-cap':'round', 'line-join':'round' }, paint:{ 'line-color': css('--paper'), 'line-width':5, 'line-offset': offset } });
      const paint = { 'line-color': css(routeVar(id)), 'line-width':2.5, 'line-offset': offset };
      if (H.routes[id].style === 'dashed') paint['line-dasharray'] = [2, 1.5];
      m.addLayer({ id:'r-' + id, type:'line', source:'r-' + id, layout:{ 'line-cap':'round', 'line-join':'round' }, paint });
      if (H.routes[id].arrows) m.addLayer({ id:'ra-' + id, type:'symbol', source:'r-' + id,
        layout:{ 'symbol-placement':'line', 'symbol-spacing':70, 'icon-image': arrowFor(css(routeVar(id))), 'icon-rotation-alignment':'map', 'icon-allow-overlap':true, 'icon-ignore-placement':true, 'icon-keep-upright':false, 'icon-offset':[0, offset] } });
    }
    m.addSource('emblem', { type:'geojson', data: { type:'FeatureCollection', features: [] } });
    // the GPU smooths the emblem's edges, since MapLibre's edge pass draws covered shapes' edges over the shapes on top
    m.addLayer({ id:'emblem', type:'fill', source:'emblem', paint:{ 'fill-color': emblemFill(), 'fill-opacity': emblemOpacity(null), 'fill-antialias': false } });
    m.addLayer({ id:'emblem-hl', type:'line', source:'emblem', filter: emblemOutline(null), paint:{ 'line-color': css('--ink'), 'line-width': 2 } });
    if (H.labels) { // atlas lettering: small caps in ink-2 with a land coloured halo, larger countries win a collision
      m.addSource('labels', { type:'geojson', data: { type:'FeatureCollection', features: H.labels } });
      m.addLayer({ id:'labels', type:'symbol', source:'labels',
        layout:{ 'text-field': ['get', lang()], 'text-font': ['noto-sans'], 'text-size': ['interpolate', ['linear'], ['zoom'], 3.5, 9, 6, 12, 9, 16], 'text-transform': 'uppercase',
          'text-letter-spacing': 0.18, 'text-max-width': 7, 'text-padding': 12, 'symbol-sort-key': ['get', 'rank'] },
        paint:{ 'text-color': css('--ink-2'), 'text-halo-color': css('--paper-2'), 'text-halo-width': 1.2, 'text-opacity': 0.85 } });
    }
    for (const id in H.battles) {
      if (!H.battles[id].front) continue;
      m.addSource('bf-' + id, { type:'geojson', data: routeFeature(id, H.battles[id].front) });
      m.addLayer({ id:'bf-' + id, type:'line', source:'bf-' + id, layout:{ 'line-cap':'round', 'line-join':'round' }, paint:{ 'line-color': css('--accent'), 'line-width':3, 'line-dasharray':[1, 2], 'line-opacity':0, 'line-opacity-transition':{ duration:600 } } });
    }
    ML.ready = true; mapApply(here(), true);
  });
}
// a chevron pointing along +x, the way a line symbol is turned to follow its line; drawn in the colour over a paper
// coloured outline, at twice the resolution for sharp screens, one image per colour
function arrowFor(color){ const n = 'arrow' + color; if (!ML.map.hasImage(n)) ML.map.addImage(n, arrowImage(color), { pixelRatio: 2 }); return n; }
function arrowImage(color){
  const s = 2, w = 16 * s, c = document.createElement('canvas'); c.width = w; c.height = w;
  const g = c.getContext('2d'); g.lineCap = 'round'; g.lineJoin = 'round';
  const chevron = () => { g.beginPath(); g.moveTo(5 * s, 3.5 * s); g.lineTo(11 * s, 8 * s); g.lineTo(5 * s, 12.5 * s); g.stroke(); };
  g.strokeStyle = css('--paper'); g.lineWidth = 5.5 * s; chevron();
  g.strokeStyle = color; g.lineWidth = 2.6 * s; chevron();
  return g.getImageData(0, 0, w, w);
}
function mapTheme(){
  const m = ML.map; if (!m || !ML.ready) return;
  m.setPaintProperty('bg', 'background-color', css('--sea'));
  m.setPaintProperty('land', 'fill-color', landFill());
  for (const [k, v] of Object.entries(hillPaint())) m.setPaintProperty('hill', k, v);
  if (H.labels) { m.setPaintProperty('labels', 'text-color', css('--ink-2')); m.setPaintProperty('labels', 'text-halo-color', css('--paper-2')); }
  m.setPaintProperty('borders', 'line-color', css('--border'));
  m.setPaintProperty('land-outline', 'line-color', css('--ink'));
  for (const id in H.zones) { const c = css(colorVar(H.zones[id].family)); m.setPaintProperty('z-' + id, 'fill-color', c); m.setPaintProperty('zl-' + id, 'line-color', c); }
  for (const f in B.families) if (B.families[f].pattern) m.updateImage('pat-' + f, patternImage(B.families[f].pattern, css(colorVar(f))));
  for (const id in H.routes) { m.setPaintProperty('rc-' + id, 'line-color', css('--paper')); m.setPaintProperty('r-' + id, 'line-color', css(routeVar(id))); }
  routeColors(here());
  for (const id in H.battles) if (H.battles[id].front) m.setPaintProperty('bf-' + id, 'line-color', css('--accent'));
  m.setPaintProperty('emblem', 'fill-color', emblemFill()); m.setPaintProperty('emblem-hl', 'line-color', css('--ink'));
}
// an emblem feature takes its family's colour in the current theme, else its own colour
function emblemFill(){
  const fallback = ['coalesce', ['get', 'color'], css('--accent')], fams = Object.keys(B.families);
  const own = fams.length ? ['match', ['get', 'family'], ...fams.flatMap(f => [f, css(colorVar(f))]), fallback] : fallback;
  // land in a battle plan takes its country's tint, and an arrow's casing the paper colour
  return ['case', ['has', 'tint'], landFill(), ['has', 'casing'], css('--paper'), own];
}
// a highlighted emblem feature keeps its colour and gains an outline, the rest of the emblem fades; a "hit" feature
// is never drawn, it only widens the area the reader can point at, such as the gaps in a row of ships. An arrow's
// casing is opaque, so it hides the arrow under it
const emblemOpacity = id => { const shown = ['case', ['has', 'casing'], 1, 0.92];
  return ['case', ['to-boolean', ['get', 'hit']], 0, ['has', 'tint'], 1, id == null ? shown : ['case', ['==', ['get', 'id'], id], shown, 0.3]]; };
const emblemOutline = id => ['all', ['==', ['get', 'id'], id ?? ''], ['!', ['to-boolean', ['get', 'hit']]], ['!', ['has', 'casing']]];
function emblemLook(id){
  ML.map.setPaintProperty('emblem', 'fill-opacity', emblemOpacity(id));
  ML.map.setFilter('emblem-hl', emblemOutline(id));
}
// zone looks: off the page, on it, highlighted, or faded behind a highlighted neighbour
const ZONE_LOOK = { off: [0, 0, 0, 1], base: [0.38, 0.7, 0.9, 1], on: [0.62, 0.95, 1, 2.5], dim: [0.16, 0.3, 0.4, 1] };
function zonePaint(id, look, ms){
  const m = ML.map, [fill, pattern, line, width] = ZONE_LOOK[look];
  m.setPaintProperty('z-' + id, 'fill-opacity-transition', { duration: ms }); m.setPaintProperty('z-' + id, 'fill-opacity', fill);
  if (m.getLayer('zp-' + id)) { m.setPaintProperty('zp-' + id, 'fill-opacity-transition', { duration: ms }); m.setPaintProperty('zp-' + id, 'fill-opacity', pattern); }
  m.setPaintProperty('zl-' + id, 'line-opacity-transition', { duration: ms }); m.setPaintProperty('zl-' + id, 'line-opacity', line);
  m.setPaintProperty('zl-' + id, 'line-width', width);
}
// a zone joins the map when a page shows it, its data loaded the first time, and leaves once it has faded out,
// so MapLibre cuts tiles only for the zones on the page
function zoneShow(id, on){
  const m = ML.map, shown = m.getLayoutProperty('z-' + id, 'visibility') === 'visible';
  const visible = v => { for (const l of ['z-', 'zp-', 'zl-']) if (m.getLayer(l + id)) m.setLayoutProperty(l + id, 'visibility', v ? 'visible' : 'none'); };
  clearTimeout(ML.zoneHide[id]);
  if (on) {
    if (!ML.zoneData.has(id)) { ML.zoneData.add(id); m.getSource('z-' + id).setData(zoneFeature(id)); }
    if (!shown) visible(true);
    zonePaint(id, 'base', 600);
  } else if (shown) {
    zonePaint(id, 'off', 600);
    ML.zoneHide[id] = setTimeout(() => visible(false), 600);
  }
}
function routeWidth(id, on){ ML.map.setPaintProperty('r-' + id, 'line-width', on ? 4.5 : 2.5); ML.map.setPaintProperty('rc-' + id, 'line-width', on ? 8 : 5); }
// point: where to show the name beside the pointer; null pins it at the top of the map; label false shows none
function setHighlight(kind, id, point, label = true){
  const m = ML.map; if (!m || !ML.ready) return;
  const page = here(), k = kind + ':' + id;
  if (ML.hl !== k) {
    ML.hl = k;
    for (const z of page.zones) zonePaint(z, kind === 'zone' ? (z === id ? 'on' : 'dim') : 'base', 150);
    for (const r of page.routes) routeWidth(r, kind === 'route' && r === id);
    emblemLook(kind === 'unit' ? id : null);
    legend.querySelectorAll('.lg').forEach(b => b.setAttribute('aria-pressed', b.dataset.hl === k));
  }
  const lab = $('hl-label');
  lab.hidden = !label; if (!label) return;
  lab.textContent = L(kind === 'zone' ? H.zones[id].name : kind === 'route' ? H.routes[id].name : page.emblemNames[id]);
  lab.classList.toggle('pinned', !point);
  if (point) { lab.style.left = (point.x + 14) + 'px'; lab.style.top = (point.y + 14) + 'px'; } else { lab.style.left = ''; lab.style.top = ''; }
}
function clearHighlight(){
  if (!ML.hl || !ML.map) return;
  ML.hl = null; $('hl-label').hidden = true;
  const page = here();
  for (const z of page.zones) zonePaint(z, 'base', 150);
  for (const r of page.routes) routeWidth(r, false);
  emblemLook(null);
  legend.querySelectorAll('.lg').forEach(b => b.setAttribute('aria-pressed', 'false'));
}
// what lies under a point: a named emblem feature first, since it is drawn on top, then a route within a few pixels,
// since lines are thin, then the smallest zone containing the point, the most specific one; the query counts each
// route's line-offset
function hitAt(pt){
  const m = ML.map, page = here(), routes = page.routes.map(r => 'r-' + r), zoneLayers = page.zones.map(z => 'z-' + z);
  if (Object.keys(page.emblemNames).length) {
    const unit = m.queryRenderedFeatures([[pt.x - 3, pt.y - 3], [pt.x + 3, pt.y + 3]], { layers: ['emblem'] }).find(f => page.emblemNames[f.properties.id]);
    if (unit) return { kind: 'unit', id: unit.properties.id };
  }
  // the box grows a pixel at a time, so of two routes drawn side by side the nearer one wins
  for (let r = 0; r <= 6 && routes.length; r++) {
    const route = m.queryRenderedFeatures(r ? [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]] : [pt.x, pt.y], { layers: routes })[0];
    if (route) return { kind: 'route', id: route.properties.id };
  }
  const zones = zoneLayers.length ? m.queryRenderedFeatures([pt.x, pt.y], { layers: zoneLayers }).map(f => f.properties.id) : [];
  zones.sort((a, b) => H.zones[a].area - H.zones[b].area);
  return zones.length ? { kind: 'zone', id: zones[0] } : null;
}
const onOverlay = e => e.originalEvent?.target?.closest?.('.maplibregl-marker, .maplibregl-popup');
// The map is flat and north up until the reader picks 3D. In 3D a page tilts over the terrain with its own camera,
// else the story's. The terrain goes once the map has laid flat, so the flight down stays smooth.
let view = pref('view', ['2d', '3d'], '2d');
function camera(page, duration){
  const m = ML.map, c = view === '3d' ? page.camera ?? H.camera : null, token = ++ML.camera;
  if (c) m.setTerrain({ source:'dem-3d', exaggeration: c.exaggeration });
  else if (m.getTerrain()) m.once('moveend', () => { if (ML.camera === token) m.setTerrain(null); });
  const bearing = c ? c.bearing : 0, pitch = c ? c.pitch : 0;
  // a battle's pages may zoom closer than the story: the closer limit of the two pages holds during the flight
  const top = page.maxZoom ?? H.maxZoom ?? 11;
  m.setMaxZoom(Math.max(m.getMaxZoom(), top));
  const cam = m.cameraForBounds([[page.bbox[0], page.bbox[1]], [page.bbox[2], page.bbox[3]]], { padding: framePadding(page), bearing, pitch, maxZoom: top });
  m.flyTo({ center: cam.center, zoom: cam.zoom, bearing, pitch, duration });
  // the callouts show once the flight lands, rather than reshuffle on the way
  if (m.isMoving()) { CO.flying = true; m.once('moveend', () => { if (ML.camera === token) { CO.flying = false; placeCallouts(); } }); }
  if (!m.isMoving()) m.setMaxZoom(top); else m.once('moveend', () => { if (ML.camera === token) m.setMaxZoom(top); });
  freeCamera(!!c);
}
// in 3D the reader may turn and tilt: right drag or Ctrl drag with a mouse, two fingers on a touch screen
function freeCamera(on){
  const m = ML.map;
  for (const h of [m.dragRotate, m.touchPitch]) on ? h.enable() : h.disable();
  on ? m.touchZoomRotate.enableRotation() : m.touchZoomRotate.disableRotation();
}
function renderView(){
  for (const b of $('view').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.view === view);
}
// the page's routes and their arrows in their shades
function routeColors(page){
  const legs = routeLegs(page);
  for (const id of page.routes) {
    const c = legColor(id, legs[id]);
    ML.map.setPaintProperty('r-' + id, 'line-color', c);
    if (H.routes[id].arrows) ML.map.setLayoutProperty('ra-' + id, 'icon-image', arrowFor(c));
    ML.legs[id]?.getElement().style.setProperty('--rc', c);
  }
}
// the leg numbers, each at the start of its leg, or a little along it where a marker or another number sits on the
// start, a thirtieth of the page's width away; a number shows once its leg has drawn that far
const LEG_AT = [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3];
function legMarkers(page){
  for (const id in ML.legs) { ML.legs[id].remove(); delete ML.legs[id]; }
  const legs = routeLegs(page), [w, , e] = page.bbox ?? H.extent, clear = (e - w) / 30;
  const taken = [...page.markers.map(m => H.markers[m].lnglat), ...(page.battle ? [H.battles[page.battle].lnglat] : [])];
  const far = p => taken.every(q => Math.hypot((p[0] - q[0]) * Math.cos(p[1] * Math.PI / 180), p[1] - q[1]) > clear);
  for (const id of page.routes) if (legs[id].n) {
    const line = turf.lineString(H.routes[id].coordinates), len = turf.length(line);
    const spots = LEG_AT.map(t => turf.along(line, len * t).geometry.coordinates), at = spots.find(far) ?? spots[0];
    const el = document.createElement('div'); el.className = 'legno'; el.textContent = legs[id].n;
    ML.legs[id] = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(ML.map); ML.legs[id].at = LEG_AT[spots.indexOf(at)]; taken.push(at);
  }
}
function mapApply(page, first){
  const m = ML.map; if (!m || !ML.ready) return;
  camera(page, first ? 0 : DUR);
  renderView();
  ML.hl = null; $('hl-label').hidden = true;
  for (const id in H.zones) zoneShow(id, page.zones.includes(id));
  for (const id in H.routes) routeWidth(id, false);
  const fresh = page.routes.filter(id => !ML.shown[id]), freshLegs = [...new Set(fresh.map(id => legOf(page, id)))];
  legMarkers(page);
  for (const id in H.routes) {
    const on = page.routes.includes(id); const src = m.getSource('r-' + id); const coords = H.routes[id].coordinates;
    cancelAnimationFrame(ML.anim[id]);
    if (!on) { src.setData(routeFeature(id, [])); ML.shown[id] = false; continue; }
    if (ML.shown[id]) { src.setData(routeFeature(id, coords)); ML.legs[id]?.getElement().classList.add('in'); continue; }
    ML.shown[id] = true;
    const t0 = performance.now() + (first ? 0 : DUR * 0.6) + freshLegs.indexOf(legOf(page, id)) * DUR, len = DUR || 1;
    const tick = now => { const t = Math.min(1, Math.max(0, (now - t0) / len)); src.setData(routeFeature(id, sliceRoute(coords, t))); if (ML.legs[id] && t >= ML.legs[id].at) ML.legs[id].getElement().classList.add('in'); if (t < 1) ML.anim[id] = requestAnimationFrame(tick); };
    ML.anim[id] = requestAnimationFrame(tick);
  }
  routeColors(page);
  for (const id in H.battles) if (H.battles[id].front) m.setPaintProperty('bf-' + id, 'line-opacity', page.battle === id ? 0.9 : 0);
  m.getSource('emblem').setData(page.emblem ?? { type:'FeatureCollection', features: [] }); emblemLook(null);
  mapMarkers(page);
  closeBattle();
  if (page.battle && !cardInText()) { clearTimeout(ML.battleTimer); ML.battleTimer = setTimeout(() => { if (here() === page) openBattle(page.battle); }, first ? 300 : DUR * 0.8); }
}
function mapMarkers(page, redraw){
  const m = ML.map; if (!m || !ML.ready) return;
  if (redraw) for (const id in ML.markers) { const mk = ML.markers[id]; delete ML.markers[id]; mk.getElement().classList.remove('in'); setTimeout(() => mk.remove(), 650); }
  const wanted = [...page.markers, ...(page.battle ? ['battle:' + page.battle] : [])];
  for (const id in ML.markers) if (!wanted.includes(id)) { const mk = ML.markers[id]; delete ML.markers[id]; mk.getElement().classList.remove('in'); setTimeout(() => mk.remove(), 650); }
  wanted.forEach(id => {
    if (ML.markers[id]) return;
    const isBattle = id.startsWith('battle:');
    const src = isBattle ? H.battles[id.slice(7)] : H.markers[id];
    const data = isBattle ? { icon: 'swords', color: null, image: null, label: src.name, note: src.date } : src;
    const el = markerEl(data, isBattle);
    if (!isBattle) { const wrap = el.querySelector('.wrap'); wrap.onmouseenter = () => pointMarker(id, true); wrap.onmouseleave = () => pointMarker(id, false); }
    // with callouts a tap on the icon opens its name's note; a photo opens the photo
    if (!isBattle) el.querySelector('.wrap').onclick = e => { const it = CO.items.find(i => i.id === id); if (it && !e.target.closest('[data-img]')) tapCallout(it); };
    if (isBattle) el.onclick = e => { e.stopPropagation(); cardInText() ? host.showText(extra) : openBattle(id.slice(7)); }; // the map would otherwise close the popup on the same click
    const mk = new maplibregl.Marker({ element: el, anchor:'top' }).setLngLat(src.lnglat).addTo(m);
    ML.markers[id] = mk; requestAnimationFrame(() => requestAnimationFrame(() => mk.getElement().classList.add('in')));
  });
  linkPlaces();
  renderCallouts(page);
}
// ---------- places: a place the text names and its marker show each other ----------
// The markers the text names take the pointer, the others let it through to the zones and routes under them. A phone
// shows the text or the map, so there the places are plain text.
function linkPlaces(){
  const places = [...story.querySelectorAll('.place')], named = new Set(phone.matches ? [] : places.map(el => el.dataset.marker));
  for (const el of places) phone.matches ? el.removeAttribute('tabindex') : el.tabIndex = 0;
  for (const id in ML.markers) { const el = ML.markers[id].getElement(); el.classList.toggle('named', named.has(id)); el.classList.remove('pop'); }
}
const popMarker = (id, on) => ML.markers[id]?.getElement().classList.toggle('pop', on);
// pointing at a marker the text names pops it and tints its places in the text
const pointMarker = (id, on) => { popMarker(id, on); for (const el of story.querySelectorAll(`.place[data-marker="${CSS.escape(id)}"]`)) el.classList.toggle('on', on); };


// ---------- callouts: on an upright phone the markers' names stand in bands above and below the page's area ----------
// A phone held upright has a tall map and most pages a wide area, so the camera keeps a band free above and below the
// area, and each marker's name stands in the nearer band with a line to its icon, as beden's callouts stand beside a
// body. A tap on a name or an icon shows its note; on a battle's name it shows the battle's card.
const CO = { layer: null, svg: null, items: [], open: null, flying: false, on: false };
const SVGNS = 'http://www.w3.org/2000/svg', CO_GAP = 4, CO_EDGE = 8, CO_REACH = 12, CO_LINE = 24;
const calloutsOn = () => phone.matches && el.map.clientHeight > el.map.clientWidth;
const labelled = page => [...page.markers.filter(id => L(H.markers[id]?.label)), ...(page.battle ? ['battle:' + page.battle] : [])];
// the top of the area the names may take: under the map tools
const toolsBottom = () => el.tools.getBoundingClientRect().bottom - el.map.getBoundingClientRect().top + CO_EDGE;
// the shell pads its bottom by the height of what covers the map there, such as the peek card, and 24 px
const coveredBottom = () => { const p = fitPadding(); return typeof p === 'number' ? 0 : p.bottom - 24; };
// a band holds up to three rows of names, about four names to a band's row and two bands
function bandHeight(page){
  const n = labelled(page).length; if (!n) return 0;
  const row = parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.45 + CO_GAP;
  return Math.min(3, Math.ceil(n / 4)) * row + CO_LINE;
}
// the frame of a page: the shell's padding, and with callouts the bands above and below, kept within 60% of the map
function framePadding(page){
  const p = fitPadding(); if (!calloutsOn()) return p;
  const pad = typeof p === 'number' ? { top: p, right: p, bottom: p, left: p } : { ...p }, top = Math.max(pad.top, toolsBottom());
  const band = Math.max(0, Math.min(bandHeight(page), (el.map.clientHeight * 0.6 - top - pad.bottom) / 2));
  return { ...pad, top: top + band, bottom: pad.bottom + band };
}
// Places the names in rows along the top and bottom edges. An anchor above mid takes the top band, else the bottom
// one. In the order of their anchors, each name takes the row that keeps it nearest above or below its anchor,
// preferring rows at the edge, where neither its line crosses a name nearer the area nor its box a line from nearer the
// edge; failing that, any row with room. The rows a band has stop short of reach from its nearest icon. A band out of
// room hands the name nearest the middle to the other band while that one has room, and a name left over hides.
// anchors are { x, y, r, visible } with r the icon's radius, sizes { w, h }. Returns per anchor { x, y, from, to }
// (the name's box and its line) or null.
function bands(anchors, sizes, { width, top, bottom, mid }){
  const out = anchors.map(() => null), shown = anchors.map((a, i) => ({ ...a, i })).filter(a => a.visible);
  const lay = (list, isTop) => {
    if (!list.length) return { placed: [], left: [] };
    const h = Math.max(...list.map(a => sizes[a.i].h));
    const limit = isTop ? Math.min(...list.map(a => a.y - a.r)) - CO_REACH : Math.max(...list.map(a => a.y + a.r)) + CO_REACH;
    const rows = Array.from({ length: Math.max(0, Math.floor(((isTop ? limit - top : bottom - limit) + CO_GAP) / (h + CO_GAP))) }, () => []);
    const placed = [], left = [], hits = (x, o) => x > o.x - CO_GAP && x < o.x + o.w + CO_GAP;
    for (const a of [...list].sort((p, q) => p.x - q.x)) {
      const { w } = sizes[a.i], want = a.x - w / 2; let best = null, fallback = null;
      rows.forEach((row, r) => {
        const after = row.length ? row.at(-1).x + row.at(-1).w + 2 * CO_GAP : CO_EDGE, x = Math.max(after, Math.min(Math.max(CO_EDGE, want), width - CO_EDGE - w));
        if (x + w > width - CO_EDGE) return;
        const lx = Math.min(Math.max(a.x, x + 6), x + w - 6), score = Math.abs(x - want) + r * h;
        const clear = rows.every((o, k) => k === r || o.every(n => k > r ? !hits(lx, n) : !(n.lx > x - CO_GAP && n.lx < x + w + CO_GAP)));
        if (clear && (!best || score < best.score)) best = { r, x, w, lx, score };
        if (!fallback || score < fallback.score) fallback = { r, x, w, lx, score };
      });
      const pick = best ?? fallback; if (!pick) { left.push(a); continue; }
      rows[pick.r].push({ a, ...pick });
    }
    rows.forEach((row, r) => { for (const n of row) placed.push({ a: n.a, x: n.x, lx: n.lx, y: isTop ? top + r * (h + CO_GAP) : bottom - (r + 1) * h - r * CO_GAP, isTop }); });
    return { placed, left };
  };
  const up = shown.filter(a => a.y < mid), down = shown.filter(a => a.y >= mid);
  let t = lay(up, true), b = lay(down, false);
  for (let n = 0; n < shown.length && (t.left.length || b.left.length); n++) {
    const isTop = t.left.length > 0, from = isTop ? up : down, to = isTop ? down : up;
    const a = from.reduce((p, q) => (isTop ? q.y > p.y : q.y < p.y) ? q : p);
    if (lay([...to, a], !isTop).left.length > (isTop ? b : t).left.length) break;
    from.splice(from.indexOf(a), 1); to.push(a); t = lay(up, true); b = lay(down, false);
  }
  for (const { a, x, y, lx, isTop } of [...t.placed, ...b.placed]) {
    const { h } = sizes[a.i];
    out[a.i] = { x, y, from: [lx, isTop ? y + h : y], to: [a.x, isTop ? a.y - a.r : a.y + a.r] };
  }
  return out;
}
// the page's names, rebuilt with its markers; on a wider screen the markers carry their own
function renderCallouts(page){
  CO.items = []; CO.open = null; CO.svg.replaceChildren(); CO.layer.querySelectorAll('.co').forEach(e => e.remove());
  CO.on = calloutsOn(); el.map.classList.toggle('callouts-on', CO.on);
  if (!CO.on) return;
  for (const id of labelled(page)) {
    const mk = ML.markers[id]; if (!mk) continue;
    const battle = id.startsWith('battle:'), src = battle ? H.battles[id.slice(7)] : H.markers[id], note = L(battle ? src.date : src.note);
    const div = document.createElement('div'); div.className = 'co';
    div.innerHTML = `<b>${esc(L(battle ? src.name : src.label))}</b>${note ? `<small>${esc(note)}</small>` : ''}`;
    const line = document.createElementNS(SVGNS, 'line');
    div.style.setProperty('--c', `var(${colorVar(battle ? null : src.color)})`);
    CO.layer.appendChild(div); CO.svg.appendChild(line);
    const it = { id, battle, div, line, icon: mk.getElement().querySelector('.wrap'), note: !!note, size: null };
    div.onclick = e => { e.stopPropagation(); tapCallout(it); };
    CO.items.push(it);
  }
  measureCallouts(); placeCallouts();
}
const measureCallouts = () => { for (const it of CO.items) it.size = { w: it.div.offsetWidth, h: it.div.offsetHeight }; };
function tapCallout(it){
  if (it.battle) { if (cardInText()) host.showText(extra); return; }
  if (!it.note) return;
  CO.open = CO.open === it ? null : it;
  for (const i of CO.items) { i.div.classList.toggle('open', CO.open === i); i.line.classList.toggle('on', CO.open === i); }
  measureCallouts(); placeCallouts();
}
function placeCallouts(){
  if (!CO.items.length) return;
  const box = el.map.getBoundingClientRect();
  CO.layer.hidden = CO.flying || !box.width; if (CO.layer.hidden) return;
  const anchors = CO.items.map(it => {
    const r = it.icon.getBoundingClientRect(), x = r.left + r.width / 2 - box.left, y = r.top + r.height / 2 - box.top;
    return { x, y, r: r.height / 2, visible: x >= 0 && x <= box.width && y >= 0 && y <= box.height };
  });
  const top = toolsBottom(), bottom = box.height - coveredBottom() - CO_EDGE;
  bands(anchors, CO.items.map(it => it.size), { width: box.width, top, bottom, mid: (top + bottom) / 2 }).forEach((c, i) => {
    const it = CO.items[i]; it.div.hidden = !c; it.line.style.display = c ? '' : 'none'; if (!c) return;
    it.div.style.transform = `translate(${c.x}px, ${c.y}px)`;
    it.line.setAttribute('x1', c.from[0]); it.line.setAttribute('y1', c.from[1]); it.line.setAttribute('x2', c.to[0]); it.line.setAttribute('y2', c.to[1]);
  });
}
// a phone turned on its side, or a window crossing the phone width, switches between callouts and the markers' own names
function calloutMode(){
  if (!ML.map || !ML.ready || calloutsOn() === CO.on) return;
  renderCallouts(here()); camera(here(), 0);
}
// the legend's route lines in the shades of the current theme
function legendColors(page){ const legs = routeLegs(page); for (const b of legend.querySelectorAll('[data-hl^="route:"]')) b.style.setProperty('--rc', legColor(b.dataset.hl.slice(6), legs[b.dataset.hl.slice(6)])); }
// ---------- the legend: the page's zones and routes, with the colour of each ----------
function renderLegend(p){
  const legs = routeLegs(p);
  legend.innerHTML = p.zones.map(z => `<button type="button" class="lg" data-hl="zone:${esc(z)}" aria-pressed="false"><i style="${patternCss(H.zones[z].family)}"></i>${esc(L(H.zones[z].name))}</button>`).join('')
    + p.routes.map(r => `<button type="button" class="lg" data-hl="route:${esc(r)}" aria-pressed="false" style="--rc:${legColor(r, legs[r])}"><i class="r ${H.routes[r].style}${H.routes[r].arrows ? ' arrow' : ''}"></i>${legs[r].n ? `<span class="legno">${legs[r].n}</span>` : ''}${esc(L(H.routes[r].name))}</button>`).join('');
  legend.hidden = !legend.innerHTML;
  el.legendButton.hidden = legend.hidden;
}
// the places the text links take the colour of their marker's family
function colourPlaces(){
  for (const e of story.querySelectorAll('.place')) e.style.setProperty('--c', `var(${colorVar(H.markers[e.dataset.marker]?.color)})`);
}
const legendTarget = e => { const b = e.target.closest?.('.lg'); return b && b.dataset.hl.split(':'); };
legend.addEventListener('mouseover', e => { const h = legendTarget(e); if (h && canHover.matches) setHighlight(h[0], h[1], null, false); });
legend.addEventListener('mouseleave', () => { if (canHover.matches) clearHighlight(); });
legend.addEventListener('focusin', e => { const h = legendTarget(e); if (h) setHighlight(h[0], h[1], null, false); });
legend.addEventListener('focusout', e => { if (!legend.contains(e.relatedTarget)) clearHighlight(); });
legend.addEventListener('click', e => { const h = legendTarget(e); if (!h || canHover.matches) return; setHighlight(h[0], h[1], null); document.body.classList.remove('legend-open'); });
// the 2D/3D switch in the stage's tool strip
function renderViewLabels(){
  el.view.setAttribute('aria-label', T().map_view);
  for (const b of el.view.querySelectorAll('button')) b.textContent = T()['view_' + b.dataset.view];
}
el.view.onclick = e => {
  const b = e.target.closest('button'); if (!b || b.dataset.view === view) return;
  view = b.dataset.view; savePref('view', view);
  clearHighlight(); renderView(); camera(here(), reduced ? 0 : 900);
};
phone.addEventListener('change', () => { linkPlaces(); if (cardInText()) closeBattle(); calloutMode(); });
renderViewLabels();
mapInit();
return {
  show(page, first) { renderLegend(M(page)); renderTextCard(M(page)); colourPlaces(); mapApply(M(page), first); },
  lang(l) { renderViewLabels(); renderTextCard(here()); if (H.labels && ML.map && ML.ready) ML.map.setLayoutProperty('labels', 'text-field', ['get', l]); renderLegend(here()); colourPlaces(); mapMarkers(here(), true); if (battlePopup && here().battle) openBattle(here().battle); },
  theme() { mapTheme(); legendColors(here()); },
  resize() { if (ML.map && ML.ready) { ML.map.resize(); camera(here(), reduced ? 0 : 600); } },
  escape() { closeBattle(true); clearHighlight(); if (CO.open) tapCallout(CO.open); },
  point(id, on) { popMarker(id, on); },
  highlight(kind, id) { setHighlight(kind, id, null); },
};
};
