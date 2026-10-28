// harita deploy: puts dist/ in the pages bucket the Worker serves, see worker.mjs. The files the bucket lacks or holds
// in another version go up, scripts and stylesheets first, and the keys dist/ no longer holds go.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { check, Site } from './schema.mjs';
import { storeWriter, pool } from './store.mjs';
import { typeOf } from './routes.mjs';
import { mb, plural, progressLine } from './util.mjs';

const CACHE = 'public, max-age=600';

// Puts root/dist in site.yaml's pages.bucket, in the account of assets.endpoint, and deletes the keys
// dist/ lacks. dryRun lists what would go and change and writes nothing. Returns the keys uploaded and deleted, and
// how many were in the bucket as they are.
export async function deploy({ root = process.cwd(), dryRun = false, log = console.log, progress = progressLine, wait } = {}) {
  const siteFile = path.join(root, 'site.yaml');
  const site = fs.existsSync(siteFile) ? check(Site, yaml.load(fs.readFileSync(siteFile, 'utf8')), 'site.yaml') : {};
  if (!site.pages) throw new Error('site.yaml: add a pages block with the bucket that holds the site, harita deploy writes dist/ there');
  if (!site.assets) throw new Error('site.yaml: pages needs the assets block, whose endpoint is the account that holds the pages bucket');
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html is missing, harita build writes the site to deploy');
  const writer = storeWriter({ endpoint: site.assets.endpoint, bucket: site.pages.bucket }, { command: 'harita deploy', wait });
  // a dot starts the folder a build writes a story to before it swaps it in, and the files editors and Finder leave
  const files = fs.readdirSync(dist, { recursive: true }).map(f => f.split(path.sep).join('/'))
    .filter(f => !f.split('/').some(s => s.startsWith('.')) && fs.statSync(path.join(dist, f)).isFile()).sort();
  const held = new Map((await writer.list()).map(o => [o.key, o.etag]));
  const md5 = f => crypto.createHash('md5').update(fs.readFileSync(path.join(dist, f))).digest('hex');
  const changed = files.filter(f => held.get(f) !== md5(f)), gone = [...held.keys()].filter(k => !files.includes(k)).sort();
  const kept = files.length - changed.length, bytes = changed.reduce((n, f) => n + fs.statSync(path.join(dist, f)).size, 0);
  if (dryRun) {
    for (const f of changed) log(`upload ${f}`);
    for (const k of gone) log(`delete ${k}`);
    log(`would upload ${plural(changed.length, 'file')} (${mb(bytes)}), delete ${gone.length.toLocaleString('en')}, ${kept.toLocaleString('en')} are in the bucket`);
    return { uploaded: changed, deleted: gone, kept };
  }
  // a page links its scripts, fonts and glyphs by version, so they go first and a new page finds them in the bucket
  const script = f => /\.(js|css)$/.test(f) || f.startsWith('vendor/');
  const cur = { what: 'dist', n: 0, total: changed.length, bytes: 0 };
  const put = async f => {
    const body = fs.readFileSync(path.join(dist, f));
    await writer.put(f, body, typeOf(f), CACHE);
    cur.n++; cur.bytes += body.length;
    progress({ ...cur, done: false });
  };
  for (const batch of [changed.filter(script), changed.filter(f => !script(f))]) await pool(batch, 8, put);
  progress({ ...cur, done: true });
  await pool(gone, 8, k => writer.delete(k));
  log(`uploaded ${plural(changed.length, 'file')} (${mb(bytes)}), deleted ${gone.length.toLocaleString('en')}, ${kept.toLocaleString('en')} were in the bucket`);
  return { uploaded: changed, deleted: gone, kept };
}
