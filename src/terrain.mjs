// Elevation tiles for the hillshade and the 3D view: Terrarium PNGs from the AWS open data bucket, cut to the
// areas the stories show. The sea is flattened to 0 m so it stays unshaded, and heights are rounded to whole
// metres; together that halves the download.
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

const SOURCE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const BASE_ZOOM = 7;  // the whole extent down to this zoom; a page that zooms in further gets tiles of its own
const SOURCE_ZOOM = 15;      // the deepest zoom the source has tiles for
const VIEW = [1200, 900];    // a large map pane in CSS pixels, for the zoom a page opens at
const PAD = 0.1;             // the share of a page's bbox added on each side, so a little panning stays sharp
export const VERSION = 1;    // part of the cache folder name and the store keys, bumped when cut() changes

// Each source's credit as its licence asks for it, with a box around the area it covers. The texts follow
// https://github.com/tilezen/joerd/blob/master/docs/attribution.md
const CREDITS = [
  { text: 'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey' },
  { text: 'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration' },
  { bbox: [-32, 27, 45, 72], text: 'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers' },
  { bbox: [-141, 41.6, -52.6, 83.2], text: 'Canada terrain data contains information licensed under the Open Government Licence – Canada' },
  { bbox: [-118.5, 14.5, -86.7, 32.8], text: 'Mexico terrain data source: INEGI, Continental relief, 2016' },
  { bbox: [9.5, 46.3, 17.2, 49.1], text: 'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich' },
  { bbox: [-8.7, 49.8, 1.8, 60.9], text: 'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved' },
  { bbox: [4.5, 57.9, 31.2, 71.2], text: 'Norway terrain data © Kartverket' },
  { bbox: [112, -44, 154, -10], text: 'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017' },
  { bbox: [166, -47.5, 179, -34], text: 'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)' },
  { bbox: [-180, 60, 180, 90], text: 'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736' },
];

const merc = lat => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
const clampTile = (v, z) => Math.min(2 ** z - 1, Math.max(0, Math.floor(v * 2 ** z)));
// [x0, y0, x1, y1] of the tiles at zoom z that cover a [w, s, e, n] box
const range = ([w, s, e, n], z) => [clampTile((w + 180) / 360, z), clampTile(merc(n), z), clampTile((e + 180) / 360, z), clampTile(merc(s), z)];
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// The zoom fitBounds picks for a page's bbox in a large pane.
export const openZoom = ([w, s, e, n]) => Math.min(Math.log2(VIEW[0] / ((e - w) / 360 * 512)), Math.log2(VIEW[1] / ((merc(s) - merc(n)) * 512)));
// The tile zoom a page needs: its opening zoom plus one, for 256 px tiles, and at most one above the map's maxZoom.
export const pageZoom = (bbox, maxZoom = 11) => Math.min(SOURCE_ZOOM, maxZoom + 1, Math.round(openZoom(bbox) + 1));

// The tiles of one story: the extent to BASE_ZOOM, then each { bbox, maxZoom } page's padded bbox at the zooms it opens
// at. ranges maps a zoom to [x0, y0, x1, y1] blocks, which the map uses to ask only for tiles that exist.
export function terrainPlan(extent, pages) {
  const ranges = {};
  const add = (z, r) => { const list = ranges[z] ??= []; if (!list.some(q => q.every((v, i) => v === r[i]))) list.push(r); };
  for (let z = 0; z <= BASE_ZOOM; z++) add(z, range(extent, z));
  let maxzoom = BASE_ZOOM;
  for (const { bbox: [w, s, e, n], maxZoom = 11 } of pages) {
    const top = pageZoom([w, s, e, n], maxZoom), dx = (e - w) * PAD, dy = (n - s) * PAD;
    for (let z = BASE_ZOOM + 1; z <= top; z++) add(z, range([w - dx, Math.max(-85, s - dy), e + dx, Math.min(85, n + dy)], z));
    maxzoom = Math.max(maxzoom, top);
  }
  const credits = ['Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.', ...CREDITS.filter(c => !c.bbox || overlaps(c.bbox, extent)).map(c => c.text)];
  return { ranges, maxzoom, credits };
}

// A tile's key in the asset store, from its "z/x/y".
export const tileKey = k => `terrain/v${VERSION}/${k}.png`;

// Every tile of the plans as "z/x/y", once.
export function tileKeys(plans) {
  const keys = new Set();
  for (const p of plans) for (const [z, list] of Object.entries(p.ranges)) for (const [x0, y0, x1, y1] of list)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.add(`${z}/${x}/${y}`);
  return [...keys];
}

// A source tile with the sea at 0 m and every height rounded to a whole metre.
export function cut(buffer) {
  const src = PNG.sync.read(buffer), out = new PNG({ width: src.width, height: src.height });
  for (let k = 0; k < src.data.length; k += 4) {
    const h = Math.max(0, Math.round(src.data[k] * 256 + src.data[k + 1] + src.data[k + 2] / 256 - 32768)) + 32768;
    out.data[k] = h >> 8; out.data[k + 1] = h & 255; out.data[k + 2] = 0; out.data[k + 3] = 255;
  }
  return PNG.sync.write(out, { colorType: 2, deflateLevel: 9 });
}

async function fromAws(key) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${SOURCE}/${key}.png`);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status < 500 || attempt === 3) throw new Error(`HTTP ${res.status}`);
    } catch (err) { if (attempt === 3) throw err; }
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
}

// Cuts the tiles missing from the cache and returns the cache folder. elevation(key) returns a source PNG and
// stands in for the download in tests.
export async function cutTiles({ keys, cache, elevation = fromAws, log = console.log }) {
  const dir = path.join(cache, `terrain-v${VERSION}`);
  const missing = keys.filter(k => !fs.existsSync(path.join(dir, k + '.png')));
  if (!missing.length) return dir;
  log(`elevation: fetching ${missing.length} of ${keys.length} tiles into ${path.relative(process.cwd(), dir) || dir}`);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < missing.length) {
      const key = missing[next++];
      let raw;
      try { raw = await elevation(key); } catch (err) {
        throw new Error(`elevation tile ${key} could not be fetched from ${SOURCE} (${err.message}). The first build of an area needs the network, later builds read ${dir}`);
      }
      const file = path.join(dir, key + '.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, cut(raw));
      if (++done % 200 === 0) log(`elevation: ${done} of ${missing.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return dir;
}

// Cuts the tiles missing from the cache, then copies every tile to its key under out.
export async function terrainTiles({ keys, cache, out, elevation = fromAws, log = console.log }) {
  const dir = await cutTiles({ keys, cache, elevation, log });
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
