// The asset store: harita upload, the hash trees, the strict build's check, and the build's links in either assets
// mode, and harita deploy to the pages bucket. A local HTTP server stands in for both buckets and for the sites that
// url fields point at.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { build, check, deploy, i18n, image, rehash, upload } from '../src/index.mjs';
import { storyAssets } from '../src/build.mjs';
import { storeReader } from '../src/store.mjs';
import { webpSizes } from '../src/upload.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const STORY = 'content/settlement-of-iceland';
const quiet = () => {};
const TILE = PNG.sync.write(new PNG({ width: 256, height: 256 }));
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cache-'));
const elevation = async () => TILE;
process.env.AWS_ACCESS_KEY_ID = 'test-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

// The store: GET reads objects under /pub/, the first byte alone with a Range header, and /files/ serves downloads. Signed requests work on the assets
// bucket under /bucket/ and the pages bucket under /site/: PUT, DELETE, and a list of seven keys a page. requests
// lists every request as "METHOD path", and failPuts makes that many PUTs answer 500.
const server = { objects: new Map(), site: new Map(), files: new Map(), requests: [], failPuts: 0, refuse: null };
const md5 = bytes => crypto.createHash('md5').update(bytes);
const httpServer = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://store');
  server.requests.push(`${req.method} ${pathname}`);
  const body = [];
  for await (const chunk of req) body.push(chunk);
  const bytes = Buffer.concat(body), send = (status, headers = {}, out) => { res.writeHead(status, headers); res.end(out); };
  const signed = pathname.match(/^\/(bucket|site)\/(.*)$/);
  if (signed && (req.method !== 'GET' || searchParams.has('list-type'))) {
    const table = signed[1] === 'bucket' ? server.objects : server.site, key = signed[2];
    if (req.method === 'PUT' && (server.failPuts > 0 || server.refuse?.(key))) { server.failPuts--; return send(500); }
    if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=test-key/')) return send(403);
    if (req.method === 'PUT') {
      if (md5(bytes).digest('base64') !== req.headers['content-md5']) return send(400);
      table.set(key, { bytes, type: req.headers['content-type'], cache: req.headers['cache-control'] });
      return send(200);
    }
    if (req.method === 'DELETE') { table.delete(key); return send(204); }
    const after = searchParams.get('continuation-token'), keys = [...table.keys()].sort().filter(k => !after || k > after), page = keys.slice(0, 7);
    const entries = page.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><ETag>&quot;${md5(table.get(k).bytes).digest('hex')}&quot;</ETag></Contents>`);
    return send(200, { 'content-type': 'application/xml' }, `<?xml version="1.0"?><ListBucketResult><IsTruncated>${keys.length > 7}</IsTruncated>${keys.length > 7 ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ''}${entries.join('')}</ListBucketResult>`);
  }
  const [table, key] = pathname.startsWith('/pub/') ? [server.objects, pathname.slice(5)] : [server.files, pathname.slice(7)];
  const o = table.get(key);
  if (!o) return send(404);
  if (req.headers.range === 'bytes=0-0') return send(206, { 'content-type': o.type ?? 'application/octet-stream', 'content-range': `bytes 0-0/${o.bytes.length}` }, o.bytes.subarray(0, 1));
  send(200, { 'content-type': o.type ?? 'application/octet-stream' }, req.method === 'HEAD' ? undefined : o.bytes);
});
await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${httpServer.address().port}`;
after(() => httpServer.close());
const reset = () => { server.objects.clear(); server.site.clear(); server.files.clear(); server.requests = []; server.failPuts = 0; server.refuse = null; };

const edit = (root, file, from, to) => fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(root, file), 'utf8').replace(from, to));
const append = (root, file, text) => fs.appendFileSync(path.join(root, file), '\n' + text + '\n');
const read = (root, f) => fs.readFileSync(path.join(root, 'dist', f), 'utf8');
const bundleOf = root => { const js = read(root, 'settlement-of-iceland/story.js'); return JSON.parse(js.slice('const BUNDLE = '.length, js.lastIndexOf(';'))); };
// a copy of the example with the store in site.yaml
function project({ url = null } = {}) {
  reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-store-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  append(root, 'site.yaml', `${url ? `url: ${url}\n` : ''}assets:\n  url: ${BASE}/pub/\n  bucket: bucket\n  endpoint: ${BASE}`);
  return root;
}
const make = (root, opts = {}) => build({ root, log: quiet, cache: CACHE, elevation, ...opts });
const put = (root, opts = {}) => upload({ root, log: quiet, progress: quiet, cache: CACHE, elevation, wait: 1, ...opts });
const yamlOf = (root, dir) => fs.readFileSync(path.join(root, dir, 'image.yaml'), 'utf8');
const sha = (root, dir) => yamlOf(root, dir).match(/^sha256: (\w+)$/m)[1];
const svg = text => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><title>${text}</title></svg>`);
const jpeg = (w, h, exif) => { const img = sharp({ create: { width: w, height: h, channels: 3, background: '#7a5' } }).jpeg(); return (exif ? img.withExif(exif) : img).toBuffer(); };
const write = (root, name, bytes) => { const f = path.join(root, name); fs.writeFileSync(f, bytes); return f; };
// an image of the story shown on the first page, with its folder
async function shown(root, name, bytes, ext = '.svg', opts = {}) {
  const id = await image({ root, file: write(root, name + ext, bytes), name, caption: `The ${name}`, story: 'settlement-of-iceland', log: quiet, ...opts });
  append(root, `${STORY}/pages/010-landnam/text/en.md`, `@image ${id}`);
  return { id, dir: `${STORY}/shared/images/${id}` };
}
const keysOf = (root, { id, dir }, ext = '.svg') => { const h = sha(root, dir); return [`images/${h}/${id}${ext}`, `images/${h}/s1/${id}-1280.webp`, `images/${h}/s1/${id}-320.webp`]; };
const puts = () => server.requests.filter(r => r.startsWith('PUT ')).map(r => r.slice('PUT /bucket/'.length));

test('a build links each use to its object in the store, and dist/ holds no objects', async () => {
  const root = project({ url: 'https://example.org/atlas' });
  const farm = await shown(root, 'farm', await jpeg(64, 32), '.jpg'), plan = await shown(root, 'plan', svg('plan'));
  edit(root, `${STORY}/shared/markers.yaml`, 'icon: house', `icon: house\n  image: ${farm.id}`);
  append(root, `${STORY}/story.yaml`, `cover: ${farm.id}`);
  await make(root);
  const B = bundleOf(root), [orig, large, small] = keysOf(root, farm, '.jpg').map(k => `${BASE}/pub/${k}`);
  assert.deepEqual([B.images[farm.id].src, B.images[farm.id].thumb], [large, small]);
  assert.equal(B.terrain.tiles, `${BASE}/pub/terrain/v1/{z}/{x}/{y}.png`);
  assert.ok(read(root, 'settlement-of-iceland/en.md').includes(`![The farm](${orig})`));
  const step = read(root, 'settlement-of-iceland/en/landnam/index.html');
  assert.ok(step.includes(`<meta property="og:image" content="${orig}">`) && step.includes(`<img src="${large}"`));
  // the main page card shows the 1280 px size, and og:image the original
  const index = read(root, 'index.html');
  assert.ok(index.includes(`<img src="${large}" alt="">`) && index.includes(`<meta property="og:image" content="${orig}">`));
  // social sites read no SVG, so a page whose first image is an SVG shares its 1280 px WebP
  fs.writeFileSync(path.join(root, STORY, 'pages/020-althing/text/en.md'), `@image ${plan.id}\n`);
  await make(root);
  assert.ok(read(root, 'settlement-of-iceland/en/althing/index.html').includes(`<meta property="og:image" content="${BASE}/pub/${keysOf(root, plan)[1]}">`));
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter(f => /\.(png|jpe?g|svg|webp|gif)$/.test(f)), []);
  assert.deepEqual(server.requests, [], 'a build without --strict asks the store nothing');
});

test('the WebP sizes fit their bounds, leave a smaller original at its size, draw an SVG and keep a GIF moving', async () => {
  const dims = async b => { const m = await sharp(b, { animated: true }).metadata(); return [m.format, m.width, m.pageHeight ?? m.height, m.pages ?? 1]; };
  let s = await webpSizes(await jpeg(2000, 1000), '.jpg');
  assert.deepEqual([await dims(s.large), await dims(s.small)], [['webp', 1280, 640, 1], ['webp', 320, 160, 1]]);
  s = await webpSizes(await sharp({ create: { width: 600, height: 300, channels: 3, background: '#000' } }).png().toBuffer(), '.png');
  assert.deepEqual([await dims(s.large), await dims(s.small)], [['webp', 600, 300, 1], ['webp', 320, 160, 1]]);
  s = await webpSizes(svg('drawn'), '.svg');
  assert.deepEqual([await dims(s.large), await dims(s.small)], [['webp', 1280, 640, 1], ['webp', 320, 160, 1]]);
  const frame = c => sharp({ create: { width: 800, height: 400, channels: 4, background: c } }).png().toBuffer();
  const gif = await sharp([await frame('#f00'), await frame('#00f')], { join: { animated: true } }).gif().toBuffer();
  s = await webpSizes(gif, '.gif');
  assert.deepEqual([await dims(s.large), await dims(s.small)], [['webp', 800, 400, 2], ['webp', 320, 160, 2]]);
});

test("a story's tree keeps its root hash, and a changed image or bbox changes its directories and the root alone", async () => {
  const root = project(), farm = await shown(root, 'farm', svg('farm'));
  const tree = () => storyAssets({ root, log: quiet }).stories[0].tree;
  const a = tree(), b = tree();
  assert.equal(a.root, b.root);
  assert.deepEqual(a.dirs[farm.dir].keys, keysOf(root, farm).sort());
  assert.ok(Object.keys(a.dirs).some(d => d === 'terrain/0') && Object.values(a.dirs).every(x => x.hash.length === 64));
  const changed = (x, y) => Object.keys({ ...x.dirs, ...y.dirs }).filter(d => x.dirs[d]?.hash !== y.dirs[d]?.hash);
  fs.writeFileSync(path.join(root, farm.dir, 'image.svg'), svg('redrawn'));
  rehash({ root, log: quiet });
  const c = tree();
  assert.deepEqual(changed(a, c), [farm.dir]);
  assert.notEqual(c.root, a.root);
  edit(root, `${STORY}/pages/030-kristnitaka/page.yaml`, /^bbox: .*$/m, 'bbox: [-21.2, 64.2, -21.0, 64.3]');
  const d = tree();
  assert.ok(changed(c, d).length && changed(c, d).every(x => x.startsWith('terrain/')));
});

test('harita upload puts the missing objects with their headers, then the tree, then latest.json, and skips what is there', async () => {
  const root = project(), farm = await shown(root, 'farm', await jpeg(64, 32), '.jpg');
  const lines = [];
  const uploaded = await put(root, { log: l => lines.push(l) });
  const [orig, large, small] = keysOf(root, farm, '.jpg'), { tree } = storyAssets({ root, log: quiet }).stories[0];
  assert.deepEqual([orig, large, small].map(k => server.objects.get(k).type), ['image/jpeg', 'image/webp', 'image/webp']);
  assert.ok([orig, large].every(k => server.objects.get(k).cache === 'public, max-age=31536000, immutable'));
  const tiles = Object.values(tree.dirs).flatMap(x => x.keys).filter(k => k.startsWith('terrain/'));
  assert.ok(tiles.length > 100 && tiles.every(k => server.objects.get(k)?.type === 'image/png'));
  assert.deepEqual(puts().slice(-2), [`meta/settlement-of-iceland/${tree.root}.json`, 'meta/settlement-of-iceland/latest.json']);
  assert.equal(server.objects.get('meta/settlement-of-iceland/latest.json').cache, 'no-cache');
  assert.equal(JSON.parse(server.objects.get('meta/settlement-of-iceland/latest.json').bytes).root, tree.root);
  assert.equal(uploaded.length, 3 + tiles.length);
  assert.match(lines.at(-1), new RegExp(`^uploaded 1 image \\(0\\.0 MB\\) and ${tiles.length} tiles \\(\\d+\\.\\d MB\\), 0 were in the store$`));
  // a second run lists the bucket, finds the tree of the same root and puts nothing
  server.requests = [];
  assert.deepEqual(await put(root), []);
  assert.ok(server.requests.length && server.requests.every(r => r === 'GET /bucket/'), 'the listing alone, a page of keys a request');
});

test('harita upload takes an original from the file here, else the store, else its url', async () => {
  const root = project(), farm = await shown(root, 'farm', svg('farm')), [orig, large, small] = keysOf(root, farm);
  await put(root);
  // sizes of a new sizes version: the originals are in the store and not here
  fs.rmSync(path.join(root, farm.dir, 'image.svg'));
  for (const k of [large, small, ...[...server.objects.keys()].filter(k => k.startsWith('meta/'))]) server.objects.delete(k);
  server.requests = [];
  await put(root);
  assert.ok(server.requests.includes(`GET /pub/${orig}`));
  assert.deepEqual(puts().slice(0, 2).sort(), [large, small].sort());
  // an image added by url: the store lacks it, so the download is the original
  const field = await shown(root, 'field', svg('field'));
  const url = `${BASE}/files/field.svg`;
  server.files.set('field.svg', { bytes: svg('field'), type: 'image/svg+xml' });
  fs.rmSync(path.join(root, field.dir, 'image.svg'));
  append(root, `${field.dir}/image.yaml`, `url: ${url}`);
  server.requests = [];
  await put(root);
  assert.ok(server.requests.includes('GET /files/field.svg') && keysOf(root, field).every(k => server.objects.has(k)));
  // with neither, the error names the folder
  const lost = await shown(root, 'lost', svg('lost'));
  fs.rmSync(path.join(root, lost.dir, 'image.svg'));
  await assert.rejects(put(root), new RegExp(`${lost.dir}: the original is not on this machine, in the store or at a url in image.yaml, add it to the folder`));
});

test('harita upload retries a failed request, and one cut short writes no tree and the next run puts the rest', async () => {
  const root = project();
  await shown(root, 'farm', svg('farm'));
  server.failPuts = 1;
  await put(root);
  assert.equal(puts().filter(k => k === puts()[0]).length, 2, 'the first PUT went twice');
  // a run whose PUT of the original fails four times stops before the tree
  const root2 = project(), field = await shown(root2, 'field', svg('field')), [fieldOrig] = keysOf(root2, field);
  server.refuse = key => key === fieldOrig;
  await assert.rejects(put(root2), new RegExp(`PUT ${fieldOrig}: HTTP 500`));
  assert.ok(![...server.objects.keys()].some(k => k.startsWith('meta/')));
  server.refuse = null;
  const before = new Set(server.objects.keys());
  server.requests = [];
  const second = await put(root2);
  assert.ok(second.includes(fieldOrig) && second.every(k => !before.has(k)), 'the second run puts only what the first left out');
  assert.ok(server.objects.has('meta/settlement-of-iceland/latest.json') && server.objects.has(fieldOrig));
});

test('--dry-run lists what would go, reads through the public URL alone and writes nothing', async () => {
  const root = project();
  await shown(root, 'farm', svg('farm'));
  const lines = [], key = process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_ACCESS_KEY_ID;
  let planned;
  try { planned = await put(root, { dryRun: true, log: l => lines.push(l) }); } finally { process.env.AWS_ACCESS_KEY_ID = key; }
  assert.ok(planned.length > 100 && planned.some(k => k.endsWith('-320.webp')));
  assert.ok(server.requests.every(r => /^(GET|HEAD) \/pub\//.test(r)));
  assert.equal(server.objects.size, 0);
  assert.match(lines[0], /^settlement-of-iceland: would upload the images of content\/settlement-of-iceland\/shared\/images\/farm-[0-9a-f]{6} and \d+ elevation tiles$/);
  assert.match(lines.at(-1), /^would upload 1 image and \d+ tiles, 0 objects are in the store$/);
  delete process.env.AWS_ACCESS_KEY_ID;
  try { await assert.rejects(put(root), /set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/); } finally { process.env.AWS_ACCESS_KEY_ID = key; }
});

test('harita image and harita upload refuse an original that is too large, of another format, located, or an unsafe SVG', async () => {
  const root = project();
  const add = (name, bytes) => image({ root, file: write(root, name, bytes), name: 'thing', caption: 'x', log: quiet });
  await assert.rejects(add('big.jpg', Buffer.alloc(21e6)), /big\.jpg: 21\.0 MB, an original is at most 20 MB/);
  await assert.rejects(add('photo.png', await jpeg(8, 8)), /photo\.png: the file ends in \.png and holds JPEG bytes, add it with the extension of its format/);
  const located = await jpeg(8, 8, { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '64/1 8/1 0/1' } });
  await assert.rejects(add('located.jpg', located), /located\.jpg: the file holds the place it was taken in its metadata, remove the location and add the file again/);
  await add('dated.jpg', await jpeg(8, 8, { IFD0: { Copyright: 'A museum' } }));
  for (const [body, what] of [['<script>alert(1)</script>', 'a script'], ['<rect onload="alert(1)"/>', 'the event attribute onload'],
    ['<image href="https://example.org/a.png"/>', 'a reference to https://example.org/a.png'], ['<rect style="fill:url(http://x/y)"/>', 'a reference to http://x/y']]) {
    await assert.rejects(add('bad.svg', `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`), new RegExp(`bad\\.svg: the SVG holds ${what.replace(/[.()]/g, '\\$&')}, remove it and add the file again`));
  }
  await add('fine.svg', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>');
  // a folder written by hand gets the same check from harita upload
  const { id, dir } = await shown(root, 'farm', svg('farm'));
  fs.rmSync(path.join(root, dir, 'image.svg'));
  fs.writeFileSync(path.join(root, dir, 'image.jpg'), located);
  edit(root, `${dir}/image.yaml`, 'file: image.svg', 'file: image.jpg');
  rehash({ root, log: quiet });
  await assert.rejects(put(root), new RegExp(`${id}/image\\.jpg: the file holds the place it was taken`));
});

test('harita build --strict asks one request of an unchanged story, asks only for new keys, and names harita upload', async () => {
  const root = project(), farm = await shown(root, 'farm', svg('farm'));
  await assert.rejects(make(root, { strict: true }), /content\/settlement-of-iceland: the store holds no upload of this story, harita upload --story settlement-of-iceland puts its images and tiles there/);
  await put(root);
  server.requests = [];
  const lines = [];
  await make(root, { strict: true, log: l => lines.push(l) });
  assert.equal(server.requests.length, 1);
  assert.ok(lines.includes('the store holds every image and tile of 1 story (1 request)'));
  // a new image: the tree in latest.json matches every directory but the new one, whose three keys are asked for
  const field = await shown(root, 'field', svg('field'));
  server.requests = [];
  await assert.rejects(make(root, { strict: true }), new RegExp(`content/settlement-of-iceland: the store lacks the images of ${field.dir}, harita upload --story settlement-of-iceland puts them there`));
  assert.deepEqual(server.requests.filter(r => !r.includes('/meta/')).sort(), keysOf(root, field).map(k => `GET /pub/${k}`).sort());
  // a folder moved to content/shared/images/ keeps its keys, which the stored tree lists, so the check asks for none
  await put(root);
  fs.mkdirSync(path.join(root, 'content/shared/images'), { recursive: true });
  fs.renameSync(path.join(root, farm.dir), path.join(root, 'content/shared/images', farm.id));
  server.requests = [];
  await make(root, { strict: true });
  assert.equal(server.requests.filter(r => !r.includes('/meta/')).length, 0);
});

test('a --local-assets build links an image without its original to its url, else to the store', async () => {
  const root = project(), farm = await shown(root, 'farm', svg('farm')), field = await shown(root, 'field', svg('field'));
  fs.rmSync(path.join(root, farm.dir, 'image.svg'));
  fs.rmSync(path.join(root, field.dir, 'image.svg'));
  append(root, `${farm.dir}/image.yaml`, 'url: https://example.org/farm.svg');
  await make(root, { localAssets: true });
  const B = bundleOf(root);
  assert.deepEqual([B.images[farm.id].src, B.images[farm.id].thumb], ['https://example.org/farm.svg', 'https://example.org/farm.svg']);
  assert.equal(B.images[field.id].src, `${BASE}/pub/${keysOf(root, field)[0]}`);
  assert.equal(B.terrain.tiles, '../assets/terrain/v1/{z}/{x}/{y}.png');
});

test('a build without assets or --local-assets names the assets block', async () => {
  reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-store-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  await assert.rejects(make(root), /site\.yaml: add an assets block with the url, bucket and endpoint of the store for the images and elevation tiles, or build with --local-assets/);
});

test('a strict build fails while git tracks an image file under content/', async () => {
  const root = project(), farm = await shown(root, 'farm', svg('farm'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', path.join(farm.dir, 'image.svg'));
  await assert.rejects(make(root, { strict: true, localAssets: true }), new RegExp(`content/: git tracks 1 image file, which belong in the asset store: ${farm.dir}/image\\.svg`));
  git('rm', '-q', '--cached', path.join(farm.dir, 'image.svg'));
  await make(root, { strict: true, localAssets: true });
});

test('an image folder without its original builds, checks and writes its catalogue', async () => {
  const root = project(), farm = await shown(root, 'farm', svg('farm'));
  fs.rmSync(path.join(root, farm.dir, 'image.svg'));
  await make(root);
  assert.ok(bundleOf(root).images[farm.id]);
  assert.deepEqual(check({ root, story: 'settlement-of-iceland', log: quiet }), []);
  edit(root, `${STORY}/story.yaml`, 'languages: [en]', 'languages: [en, tr]');
  for (const dir of [path.join(root, STORY, 'pages'), path.join(root, 'content/shared/battles/althing-1012/pages')])
    for (const f of fs.readdirSync(dir, { recursive: true })) if (f.endsWith('en.md')) fs.copyFileSync(path.join(dir, f), path.join(dir, f.replace(/en\.md$/, 'tr.md')));
  i18n({ root, lang: 'tr', story: 'settlement-of-iceland', log: quiet });
  assert.match(fs.readFileSync(path.join(root, farm.dir, 'i18n/tr.yaml'), 'utf8'), /^image\.caption: ""$/m);
});

test('harita image with a url writes url, file and sha256, and matches a folder without its original by sha256', async () => {
  const root = project(), bytes = await jpeg(16, 8);
  // a pull request attachment: no extension in the path, the type in the answer
  server.files.set('assets/7d1c', { bytes, type: 'image/jpeg' });
  const id = await image({ root, file: `${BASE}/files/assets/7d1c`, name: 'farm', caption: 'The farm', story: 'settlement-of-iceland', log: quiet });
  const dir = `${STORY}/shared/images/${id}`;
  assert.match(yamlOf(root, dir), new RegExp(`^caption: The farm\nurl: ${BASE}/files/assets/7d1c\nfile: image\\.jpg\nsha256: [0-9a-f]{64}\n$`));
  assert.ok(fs.readFileSync(path.join(root, dir, 'image.jpg')).equals(bytes));
  // the same bytes from another story move the folder where both see it, and its keys stay
  fs.rmSync(path.join(root, dir, 'image.jpg'));
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  fs.rmSync(path.join(root, 'content/second-story/shared/images'), { recursive: true });
  edit(root, 'content/second-story/story.yaml', 'id: settlement-of-iceland', 'id: second-story');
  const keys = keysOf(root, { id, dir }, '.jpg');
  assert.equal(await image({ root, file: write(root, 'farm.jpg', bytes), name: 'farm', caption: 'x', story: 'second-story', log: quiet }), id);
  assert.deepEqual(keysOf(root, { id, dir: `content/shared/images/${id}` }, '.jpg'), keys);
  // a new sha256 drops url, which downloads the old bytes
  fs.writeFileSync(path.join(root, `content/shared/images/${id}/image.jpg`), await jpeg(16, 9));
  rehash({ root, log: quiet });
  assert.doesNotMatch(yamlOf(root, `content/shared/images/${id}`), /^url:/m);
});

test('a build writes redirects.json with both paths of every image folder', async () => {
  const root = project(), farm = await shown(root, 'farm', await jpeg(64, 32), '.jpg'), plan = await shown(root, 'plan', svg('plan'));
  fs.mkdirSync(path.join(root, 'content/shared/images'), { recursive: true });
  fs.renameSync(path.join(root, plan.dir), path.join(root, 'content/shared/images', plan.id));
  await make(root);
  const [farmOrig] = keysOf(root, farm, '.jpg'), [planOrig] = keysOf(root, { id: plan.id, dir: `content/shared/images/${plan.id}` });
  assert.deepEqual(JSON.parse(read(root, 'redirects.json')), {
    [`/images/${farm.id}.jpg`]: `${BASE}/pub/${farmOrig}`, [`/images/${plan.id}.svg`]: `${BASE}/pub/${planOrig}`,
    [`/settlement-of-iceland/images/${farm.id}.jpg`]: `${BASE}/pub/${farmOrig}`, [`/settlement-of-iceland/images/${plan.id}.svg`]: `${BASE}/pub/${planOrig}`,
  });
  // a --local-assets build points at the copies in dist/assets/
  await make(root, { localAssets: true });
  assert.equal(JSON.parse(read(root, 'redirects.json'))[`/images/${farm.id}.jpg`], `/assets/${farmOrig}`);
});

const site = (root, opts = {}) => deploy({ root, log: quiet, progress: quiet, wait: 1, ...opts });
const distFiles = root => fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter(f => fs.statSync(path.join(root, 'dist', f)).isFile()).map(f => f.split(path.sep).join('/')).sort();
const sitePuts = () => server.requests.filter(r => r.startsWith('PUT /site/')).map(r => r.slice('PUT /site/'.length));

test('harita deploy puts dist/ in the pages bucket, scripts first, skips what matches and deletes what dist/ lacks', async () => {
  const root = project({ url: 'https://example.org/' });
  append(root, 'site.yaml', 'pages:\n  bucket: site');
  await shown(root, 'farm', svg('farm'));
  await make(root);
  const files = distFiles(root), lines = [];
  assert.ok(files.length > 14, 'the listing pages');
  const first = await site(root, { log: l => lines.push(l) });
  assert.deepEqual([...server.site.keys()].sort(), files);
  assert.deepEqual(first.uploaded.slice().sort(), files);
  assert.equal(server.site.get('index.html').type, 'text/html; charset=utf-8');
  assert.equal(server.site.get('settlement-of-iceland/story.js').type, 'text/javascript; charset=utf-8');
  assert.equal(server.site.get('redirects.json').type, 'application/json');
  assert.ok([...server.site.values()].every(o => o.cache === 'public, max-age=600'));
  const order = sitePuts(), lastScript = order.findLastIndex(k => /\.js$/.test(k)), firstPage = order.findIndex(k => k.endsWith('.html'));
  assert.ok(lastScript < firstPage, 'every script went before the first page');
  assert.match(lines.at(-1), new RegExp(`^uploaded ${files.length} files \\(\\d+\\.\\d MB\\), deleted 0, 0 were in the bucket$`));
  // nothing changed: the listing alone, and no PUT
  server.requests = [];
  const again = await site(root);
  assert.deepEqual([again.uploaded, again.deleted, again.kept], [[], [], files.length]);
  assert.ok(server.requests.every(r => r.startsWith('GET /site/')));
  // one page changed and one file gone
  edit(root, 'dist/settlement-of-iceland/en/landnam/index.html', '</body>', '<!-- edited --></body>');
  fs.rmSync(path.join(root, 'dist/settlement-of-iceland/en.md'));
  server.requests = [];
  const third = await site(root, { log: l => lines.push(l) });
  assert.deepEqual([third.uploaded, third.deleted, third.kept], [['settlement-of-iceland/en/landnam/index.html'], ['settlement-of-iceland/en.md'], files.length - 2]);
  assert.ok(server.site.get('settlement-of-iceland/en/landnam/index.html').bytes.includes('<!-- edited -->') && !server.site.has('settlement-of-iceland/en.md'));
  assert.equal(lines.at(-1), `uploaded 1 file (0.0 MB), deleted 1, ${files.length - 2} were in the bucket`);
});

test('harita deploy --dry-run lists what would go and writes nothing, and without pages names the pages block', async () => {
  const root = project();
  append(root, 'site.yaml', 'pages:\n  bucket: site');
  await make(root);
  server.site.set('old/index.html', { bytes: Buffer.from('old'), type: 'text/html' });
  const lines = [], r = await site(root, { dryRun: true, log: l => lines.push(l) });
  assert.deepEqual(r.uploaded.slice().sort(), distFiles(root));
  assert.deepEqual(r.deleted, ['old/index.html']);
  assert.ok(lines.includes('upload index.html') && lines.includes('delete old/index.html'));
  assert.match(lines.at(-1), /^would upload \d+ files \(\d\.\d MB\), delete 1, 0 are in the bucket$/);
  assert.deepEqual([...server.site.keys()], ['old/index.html']);
  const bare = project();
  await make(bare);
  await assert.rejects(site(bare), /site\.yaml: add a pages block with the bucket that holds the site, harita deploy writes dist\/ there/);
  const key = process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_ACCESS_KEY_ID;
  try { await assert.rejects(site(root), /harita deploy writes with the S3 credentials of an API token for the bucket: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/); } finally { process.env.AWS_ACCESS_KEY_ID = key; }
});

test('a request that fails on the network names the error code after its retries', async () => {
  // a port that was listening a moment ago and refuses now
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise(r => closed.close(r));
  const reader = storeReader(`http://127.0.0.1:${port}/`, { wait: 1 });
  await assert.rejects(reader.has('images/x'), new RegExp(`^Error: http://127\\.0\\.0\\.1:${port}/images/x: ECONNREFUSED`));
});
