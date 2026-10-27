// Image folders: content/shared/images/<id>/ for every story, content/<story>/shared/images/<id>/ for one. Each holds
// image.yaml with the caption, the credit, where the original came from, its file name and sha256. The original,
// image.<ext>, stays on the machine that added it, and the asset store holds it with its WebP sizes.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { libraryItems, storyFolders, isImage } from './folders.mjs';
import { check, ImageFolder } from './schema.mjs';

export const SIZES_VERSION = 1; // part of the keys of the WebP sizes, bumped when the sizes or their encoding change
export const MAX_BYTES = 20e6;
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
export const contentType = ext => TYPES[ext] ?? 'application/octet-stream';
const FORMAT = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.gif': 'gif', '.webp': 'webp', '.svg': 'svg' };

export const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const sha256 = file => sha256Of(fs.readFileSync(file));
// The keys of an image's objects in the asset store, from its folder id and the file and sha256 of its image.yaml.
export const imageKeys = (id, { file, sha256: hash }) => ({
  original: `images/${hash}/${id}${path.extname(file)}`,
  large: `images/${hash}/s${SIZES_VERSION}/${id}-1280.webp`,
  small: `images/${hash}/s${SIZES_VERSION}/${id}-320.webp`,
});

// The format the bytes hold, by their first bytes, or null.
function formatOf(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // an XML declaration, comments and a doctype may come before the svg element
  const head = b.toString('utf8', 0, 65536);
  if (/^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

// true when an EXIF block holds a position: IFD0 points at a GPS IFD with a latitude or a longitude in it
function exifHasPosition(exif) {
  const t = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? exif.subarray(6) : exif;
  if (t.length < 8) return false;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = o => le ? t.readUInt16LE(o) : t.readUInt16BE(o), u32 = o => le ? t.readUInt32LE(o) : t.readUInt32BE(o);
  const tags = ifd => {
    const found = new Map();
    if (ifd + 2 > t.length) return found;
    for (let i = 0, n = u16(ifd); i < n && ifd + 14 + i * 12 <= t.length; i++) found.set(u16(ifd + 2 + i * 12), u32(ifd + 10 + i * 12));
    return found;
  };
  try {
    const gps = tags(u32(4)).get(0x8825);
    if (gps == null) return false;
    const g = tags(gps);
    return g.has(2) || g.has(4);
  } catch { return false; } // a block too short for its own offsets holds no position
}

// What an SVG must not hold: anything that runs code or loads a file when the SVG is opened.
const SVG_RULES = [
  [/<script[\s>/]/i, () => 'a script'],
  [/\s(on[a-z]+)\s*=/i, m => `the event attribute ${m[1]}`],
  [/\s((?:xlink:)?href|src)\s*=\s*["']\s*(?!#|data:)([^"']*)/i, m => `a reference to ${m[2] || 'another file'}`],
  [/url\(\s*["']?\s*(?!#|data:)([^)"']*)/i, m => `a reference to ${m[1]}`],
  [/@import\b/i, () => 'a stylesheet import'],
  [/<!ENTITY[^>]*\b(SYSTEM|PUBLIC)\b/i, () => 'an outside entity'],
];

// Refuses an original over 20 MB, one whose bytes are not the format its extension names, one with a position in its
// EXIF or XMP metadata, and an SVG that holds a script, an event attribute or a reference outside the file.
export async function checkOriginal(bytes, ext, where) {
  if (bytes.length > MAX_BYTES) throw new Error(`${where}: ${(bytes.length / 1e6).toFixed(1)} MB, an original is at most ${MAX_BYTES / 1e6} MB, add a smaller copy`);
  const want = FORMAT[ext.toLowerCase()], got = formatOf(bytes);
  if (got !== want) throw new Error(`${where}: the file ends in ${ext} and holds ${got ? `${got.toUpperCase()} bytes` : 'bytes of no image format'}, add it with the extension of its format`);
  if (got === 'svg') {
    const text = bytes.toString('utf8');
    for (const [re, what] of SVG_RULES) {
      const m = text.match(re);
      if (m) throw new Error(`${where}: the SVG holds ${what(m)}, remove it and add the file again`);
    }
    return;
  }
  const sharp = (await import('sharp')).default;
  let meta;
  try { meta = await sharp(bytes).metadata(); } catch (err) { throw new Error(`${where}: the ${got.toUpperCase()} does not read (${err.message})`); }
  const xmp = meta.xmp ? meta.xmp.toString('utf8') : '';
  if ((meta.exif && exifHasPosition(meta.exif)) || /GPS(Latitude|Longitude)/.test(xmp))
    throw new Error(`${where}: the file holds the place it was taken in its metadata, remove the location and add the file again`);
}

// a source as a page address, so File%3AA%20b.jpg over http and File:A_b.jpg over https are one source, and
// object.php?id=101 and ?id=202 are two
const sameSource = url => { try { const u = new URL(url); return u.host + decodeURIComponent(u.pathname).replace(/ /g, '_') + u.search; } catch { return url; } };
const readMeta = dir => { try { return yaml.load(fs.readFileSync(path.join(dir, 'image.yaml'), 'utf8')) ?? {}; } catch { return {}; } };
// a field of image.yaml set in place, so the other lines and their comments stay. A new field goes before the field
// named by before, else at the end.
function setField(dir, key, value, before = null) {
  const file = path.join(dir, 'image.yaml'), text = fs.readFileSync(file, 'utf8'), line = `${key}: ${value}`, at = new RegExp(`^${key}:.*$`, 'm');
  const next = before && text.match(new RegExp(`^${before}:`, 'm'));
  fs.writeFileSync(file, at.test(text) ? text.replace(at, line) : next ? text.slice(0, next.index) + line + '\n' + text.slice(next.index) : text.replace(/\n?$/, '\n') + line + '\n');
}
const removeField = (dir, key) => { const file = path.join(dir, 'image.yaml'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(new RegExp(`^${key}:.*\n?`, 'm'), '')); };

// Every image folder the content holds, with its stored fields. file and size describe the original on this machine,
// and are null where it is elsewhere.
export function imageIndex({ root = process.cwd() } = {}) {
  const content = path.join(root, 'content'), index = [];
  // the image folders of a library, in its groups too
  const folders = (dir, story) => {
    for (const [id, d] of libraryItems(dir, isImage, p => path.relative(root, p))) {
      const m = readMeta(d), files = fs.readdirSync(d).filter(f => /^image\.\w+$/.test(f) && f !== 'image.yaml');
      const f = files.includes(m.file) ? m.file : files[0], file = f ? path.join(d, f) : null;
      index.push({ id, story, dir: d, meta: fs.existsSync(path.join(d, 'image.yaml')), file, size: file ? fs.statSync(file).size : null,
        source: m.source ?? null, url: m.url ?? null, name: m.file ?? null, sha256: m.sha256 ?? null });
    }
  };
  folders(path.join(content, 'shared', 'images'), null);
  for (const [s, d] of storyFolders(content, p => path.relative(root, p))) folders(path.join(d, 'shared', 'images'), s);
  return index;
}

// The image the content already holds for a source or an original: the same source first, then the same bytes, by
// the sha256 of file or the sha256 given. Returns the index entry with by: 'source' or 'sha256', or null.
export function findImage(index, { source = null, file = null, sha256: hash = file ? sha256(file) : null } = {}) {
  if (source) {
    const want = sameSource(source), hit = index.find(i => i.source && sameSource(i.source) === want);
    if (hit) return { ...hit, by: 'source' };
  }
  if (hash) {
    // a folder without a sha256 hashes its original, which only happens before harita rehash
    const hit = index.find(i => (i.sha256 ?? (i.file ? sha256(i.file) : null)) === hash);
    if (hit) return { ...hit, by: 'sha256' };
  }
  return null;
}

// The original behind a URL and its extension: the one the path ends in, else the one of the type the server sends.
export async function downloadOriginal(url) {
  let res;
  try { res = await fetch(url); } catch (err) { throw new Error(`${url}: ${err.cause?.message ?? err.message}`); }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`${url}: an original is at most ${MAX_BYTES / 1e6} MB, add a smaller copy`);
  const bytes = Buffer.from(await res.arrayBuffer()), named = path.extname(decodeURIComponent(new URL(url).pathname)).toLowerCase();
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = FORMAT[named] ? named : Object.keys(TYPES).find(e => e !== '.jpeg' && TYPES[e] === type);
  if (!ext) throw new Error(`${url}: an image is a .jpg, .jpeg, .png, .webp, .svg or .gif file, and this one is ${type || 'of no known type'}`);
  return { bytes, ext };
}

// harita image: the folder that holds the same source or bytes, moved to content/shared/images/ when another story owns
// it, else a new one named <name>-<six random hex digits>, so branches adding images at once never clash. file is a
// path or a URL to download the original from. Returns the id.
export async function image({ root = process.cwd(), file, name, caption, credit = null, source = null, story = null, log = console.log } = {}) {
  if (!file || !name || !caption) throw new Error('usage: harita image <file or url> <name> --caption <text> [--credit <text>] [--source <url>] [--story <id>]');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`"${name}": a name is lowercase letters, digits and dashes, such as hastings-knights`);
  const url = /^https?:\/\//i.test(file) ? file : null;
  if (!url && !fs.existsSync(file)) throw new Error(`${file}: no such file`);
  if (!url && !FORMAT[path.extname(file).toLowerCase()]) throw new Error(`${file}: an image is a .jpg, .jpeg, .png, .webp, .svg or .gif file`);
  const stories = storyFolders(path.join(root, 'content'), p => path.relative(root, p));
  if (!stories.size) throw new Error('content/: no story.yaml found, run harita image from a content project');
  if (story && !stories.has(story)) throw new Error(`"${story}" is not a story folder under content/`);
  // the fields as image.yaml will hold them, checked before anything is fetched or written
  const fields = { caption, ...(credit ? { credit } : {}), ...(source ? { source } : {}), ...(url ? { url } : {}) };
  check(ImageFolder.partial({ file: true, sha256: true }), fields, '--caption, --credit and --source');
  const { bytes, ext } = url ? await downloadOriginal(url) : { bytes: fs.readFileSync(file), ext: path.extname(file).toLowerCase() };
  await checkOriginal(bytes, ext, file);
  const hash = sha256Of(bytes), rel = p => path.relative(root, p), common = path.join(root, 'content', 'shared', 'images');
  const index = imageIndex({ root }), hit = findImage(index, { source, sha256: hash });
  if (hit) {
    let dir = hit.dir;
    // a folder of another story moves where both stories see it, and every reference to it keeps working
    if (hit.story && hit.story !== story) {
      dir = path.join(common, hit.id);
      if (fs.existsSync(dir) || index.some(i => i.id === hit.id && i.dir !== hit.dir)) throw new Error(`${rel(hit.dir)} holds this image and another folder is named ${hit.id} too, keep one`);
      fs.mkdirSync(common, { recursive: true });
      fs.renameSync(hit.dir, dir);
      log(`moved ${rel(hit.dir)}/ to ${rel(dir)}/, it holds the same ${hit.by === 'source' ? 'source' : 'file'}`);
    } else log(`${rel(dir)}/ holds the same ${hit.by === 'source' ? 'source' : 'file'}`);
    if (source && !hit.source) setField(dir, 'source', source);
    log(`name it as ${hit.id}`);
    return hit.id;
  }
  const base = story ? path.join(stories.get(story), 'shared', 'images') : common;
  let id;
  // a fresh suffix, unused in every library and group
  do id = `${name}-${crypto.randomBytes(3).toString('hex')}`; while (index.some(i => i.id === id));
  const dir = path.join(base, id), original = 'image' + ext;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, original), bytes);
  // the caption is in the story's default language, or for a shared image the site's
  const settingsFile = story ? path.join(stories.get(story), 'story.yaml') : path.join(root, 'site.yaml');
  const settings = fs.existsSync(settingsFile) ? yaml.load(fs.readFileSync(settingsFile, 'utf8')) ?? {} : {};
  const lang = settings.default_language ?? settings.languages?.[0] ?? 'en';
  fs.writeFileSync(path.join(dir, 'image.yaml'), yaml.dump({ ...fields, ...(lang !== 'en' ? { default_language: lang } : {}), file: original, sha256: hash }, { lineWidth: -1 }));
  log(`wrote ${rel(dir)}/, name it as ${id}`);
  return id;
}

// harita rehash: writes the file and sha256 of every image folder whose original is on this machine into its
// image.yaml, where they are missing or no longer match. A new sha256 drops url, which downloads the old bytes.
// Returns the folders it wrote.
export function rehash({ root = process.cwd(), log = console.log } = {}) {
  const written = [];
  for (const i of imageIndex({ root })) {
    if (!i.meta) { log(`${path.relative(root, i.dir)}: image.yaml is missing`); continue; }
    if (!i.file) continue;
    const hash = sha256(i.file), name = path.basename(i.file);
    if (i.sha256 === hash && i.name === name) continue;
    if (i.name !== name) setField(i.dir, 'file', name, 'sha256');
    if (i.sha256 !== hash) { setField(i.dir, 'sha256', hash); if (i.url) removeField(i.dir, 'url'); }
    written.push(path.relative(root, i.dir));
  }
  log(`wrote the file and sha256 of ${written.length} image folder${written.length === 1 ? '' : 's'}`);
  return written;
}
