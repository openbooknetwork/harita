// The asset store: an S3 bucket that holds the images and elevation tiles under keys harita computes, and per story a
// hash tree of the keys it needs. Reads go through the store's public URL, uploads through its S3 endpoint.
import crypto from 'crypto';
import { AwsClient } from 'aws4fetch';
import { tileKey } from './terrain.mjs';

export const TREE_FORMAT = 1;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const hashLines = lines => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');

// A story's hash tree: a directory per image folder with its keys, and terrain/<z> per zoom with that zoom's tiles. A
// directory's hash is the sha256 of its sorted keys, and the root's the sha256 of its sorted "<hash> <directory>"
// lines. images are { dir, keys } with dir the folder's path in the project, tiles are "z/x/y".
export function storyTree(story, images, tiles) {
  const keysOf = {};
  for (const { dir, keys } of images) keysOf[dir] = Object.values(keys);
  for (const t of tiles) (keysOf[`terrain/${t.split('/')[0]}`] ??= []).push(tileKey(t));
  const dirs = {};
  for (const d of Object.keys(keysOf).sort()) { const keys = [...new Set(keysOf[d])].sort(); dirs[d] = { hash: hashLines(keys), keys }; }
  return { format: TREE_FORMAT, story, root: hashLines(Object.entries(dirs).map(([d, x]) => `${x.hash} ${d}`).sort()), dirs };
}

// Runs fn over the items, n at a time, and returns its results in order.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// A request tried again five times on a network error or a 5xx or 429 answer, waiting twice as long each time, half
// a minute in all. Returns the last answer, or throws with the status or the error code, such as ETIMEDOUT.
export async function retry(what, request, { wait = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null, error = null;
    try { res = await request(); } catch (err) { error = err; }
    if (res && res.status < 500 && res.status !== 429) return res;
    if (attempt === 5) throw new Error(`${what}: ${res ? `HTTP ${res.status}` : [error.cause?.code, error.cause?.message || error.message].filter(Boolean).join(' ')}`);
    await new Promise(r => setTimeout(r, wait * 2 ** attempt));
  }
}

// Reads objects through the store's public URL, which needs no credentials. count tells the requests made.
export function storeReader(url, opts = {}) {
  const r = {
    count: 0,
    // whether the store holds the key: a GET of its first byte, since the store closes the connection after a HEAD
    async has(key) {
      r.count++;
      const res = await retry(url + key, () => fetch(url + key, { headers: { Range: 'bytes=0-0' } }), opts);
      await res.arrayBuffer();
      if (res.status === 404 || res.status === 403) return false;
      if (!res.ok) throw new Error(`${url + key}: HTTP ${res.status}`);
      return true;
    },
    async get(key) {
      r.count++;
      const res = await retry(url + key, () => fetch(url + key, { cache: 'no-store' }), opts);
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`${url + key}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async json(key) { const b = await r.get(key); return b && JSON.parse(b.toString('utf8')); },
  };
  return r;
}

const unescapeXml = s => s.replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (_, e, n) => n ? String.fromCodePoint(n) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]);

// Writes, lists and deletes objects through the S3 endpoint with the credentials of AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY. command names the harita command in the error for missing credentials.
export function storeWriter({ endpoint, bucket }, { command = 'harita upload', ...opts } = {}) {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!accessKeyId || !secretAccessKey) throw new Error(`${command} writes with the S3 credentials of an API token for the bucket: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY`);
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  const base = `${endpoint.replace(/\/$/, '')}/${bucket}/`;
  return {
    // the store checks the bytes against Content-MD5 and refuses a copy damaged on the way
    async put(key, body, type, cacheControl = IMMUTABLE) {
      const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, 'Content-MD5': crypto.createHash('md5').update(body).digest('base64') };
      const res = await retry(`PUT ${key}`, async () => fetch(await aws.sign(base + key, { method: 'PUT', body, headers })), opts);
      if (!res.ok) throw new Error(`PUT ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    },
    // every key in the bucket with its ETag, the MD5 of an object put in one part, a thousand keys a request
    async list() {
      const out = [];
      let token = null;
      do {
        const query = `?list-type=2${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
        const res = await retry(`list ${bucket}`, async () => fetch(await aws.sign(base + query, { method: 'GET' })), opts);
        if (!res.ok) throw new Error(`list ${bucket}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        const xml = await res.text();
        for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
          out.push({ key: unescapeXml(entry.match(/<Key>([\s\S]*?)<\/Key>/)[1]), etag: unescapeXml(entry.match(/<ETag>([\s\S]*?)<\/ETag>/)[1]).replace(/"/g, '') });
        token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
        token = token ? unescapeXml(token) : null;
      } while (token);
      return out;
    },
    async delete(key) {
      const res = await retry(`DELETE ${key}`, async () => fetch(await aws.sign(base + key, { method: 'DELETE' })), opts);
      if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    },
  };
}

// The keys of a tree the store lacks. The meta file of the tree's root means none. Else the tree latest.json names
// tells the directories that match and the keys uploaded, and the store is asked for each other key. A story without
// latest.json returns null, or with headAll a request for every key.
export async function missingKeys(reader, tree, { headAll = false } = {}) {
  const meta = `meta/${tree.story}/`;
  if (await reader.get(`${meta}${tree.root}.json`)) return { missing: [], complete: true };
  const latest = await reader.json(`${meta}latest.json`), stored = latest && await reader.json(`${meta}${latest.root}.json`);
  if (!stored && !headAll) return { missing: null, complete: false };
  const known = new Set(), same = new Set();
  for (const [d, x] of Object.entries(stored?.dirs ?? {})) {
    for (const k of x.keys) known.add(k);
    if (tree.dirs[d]?.hash === x.hash) same.add(d);
  }
  const ask = [...new Set(Object.entries(tree.dirs).filter(([d]) => !same.has(d)).flatMap(([, x]) => x.keys).filter(k => !known.has(k)))];
  const found = await pool(ask, 8, k => reader.has(k));
  return { missing: ask.filter((_, i) => !found[i]), complete: false };
}

// The keys of a tree that a listing of the bucket lacks, held being the set of keys in the store.
export function missingIn(held, tree) {
  const keys = [...new Set(Object.values(tree.dirs).flatMap(x => x.keys))];
  return { missing: keys.filter(k => !held.has(k)), complete: held.has(`meta/${tree.story}/${tree.root}.json`) };
}

// The missing objects of a tree in words: the image folders by path, and the tiles by count.
export function describeMissing(tree, missing) {
  const set = new Set(missing);
  const folders = Object.entries(tree.dirs).filter(([d, x]) => !d.startsWith('terrain/') && x.keys.some(k => set.has(k))).map(([d]) => d);
  const tiles = missing.filter(k => k.startsWith('terrain/')).length;
  return [folders.length && `the images of ${folders.join(', ')}`, tiles && `${tiles} elevation tile${tiles === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
}

// harita build --strict: every object the trees name is in the store. Throws with the stories that lack some, named by
// each tree's dir, the story folder.
export async function checkStore({ url, trees, log = console.log, ...opts }) {
  const reader = storeReader(url, opts), problems = [];
  for (const tree of trees) {
    const { missing } = await missingKeys(reader, tree);
    if (missing === null) problems.push(`${tree.dir}: the store holds no upload of this story, harita upload --story ${tree.story} puts its images and tiles there`);
    else if (missing.length) problems.push(`${tree.dir}: the store lacks ${describeMissing(tree, missing)}, harita upload --story ${tree.story} puts them there`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  log(`the store holds every image and tile of ${trees.length} stor${trees.length === 1 ? 'y' : 'ies'} (${reader.count} request${reader.count === 1 ? '' : 's'})`);
}
