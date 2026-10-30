// How the site answers a path: resolve of routes.mjs, and the Worker over a bucket held in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { resolve, site } from './_kitap.mjs';

const FILES = { 'index.html': 'text/html; charset=utf-8', 'en/index.html': 'text/html; charset=utf-8', 'saga/index.html': 'text/html; charset=utf-8', 'saga/en/index.html': 'text/html; charset=utf-8',
  'saga/en/landnam/index.html': 'text/html; charset=utf-8', 'harita.js': 'text/javascript; charset=utf-8', 'saga/story.js': 'text/javascript; charset=utf-8', '404.html': 'text/html; charset=utf-8',
  'robots.txt': 'text/plain; charset=utf-8', 'redirects.json': 'application/json' };
const REDIRECTS = { '/images/farm-1a2b3c.jpg': 'https://assets.example.org/images/0/farm-1a2b3c.jpg', '/saga/images/farm-1a2b3c.jpg': 'https://assets.example.org/images/0/farm-1a2b3c.jpg' };
const bodyOf = key => key === 'redirects.json' ? JSON.stringify(REDIRECTS) : key === '404.html' ? 'There is no page at this address.' : `the file ${key}`;

test('resolve serves index pages, redirects a folder path without its slash and the old image paths, and gives the 404 page for the rest', async () => {
  const exists = key => key in FILES, redirect = p => REDIRECTS[p] ?? null;
  const at = (p, query = '') => resolve(p, exists, { redirect, query });
  assert.deepEqual(await at('/'), { key: 'index.html', status: 200 });
  assert.deepEqual(await at('/saga/en/'), { key: 'saga/en/index.html', status: 200 });
  assert.deepEqual(await at('/harita.js'), { key: 'harita.js', status: 200 });
  assert.deepEqual(await at('/saga/en', '?x=1'), { location: '/saga/en/?x=1' });
  assert.deepEqual(await at('/saga'), { location: '/saga/' });
  assert.deepEqual(await at('/images/farm-1a2b3c.jpg'), { location: REDIRECTS['/images/farm-1a2b3c.jpg'] });
  for (const p of ['/saga/en/nowhere/', '/saga/en/nowhere', '/en/index.html/', '/../index.html', 'index.html', '/./index.html']) assert.deepEqual(await at(p), { key: '404.html', status: 404 }, p);
  // exists may be async, as a bucket's is
  assert.deepEqual(await resolve('/en/', async key => key in FILES), { key: 'en/index.html', status: 200 });
});

// A bucket in memory with the shape the Worker reads: get and head give an object with its body, ETag and type.
function bucket(files = FILES) {
  const object = key => ({ body: bodyOf(key), httpEtag: `"${crypto.createHash('md5').update(bodyOf(key)).digest('hex')}"`, httpMetadata: { contentType: files[key] }, json: async () => JSON.parse(bodyOf(key)) });
  return { reads: [], async get(key) { this.reads.push(key); return key in files ? object(key) : null; }, async head(key) { return key in files ? object(key) : null; } };
}
const worker = site();
const at = (p, init = {}, SITE = bucket()) => worker.fetch(new Request(`https://example.org${p}`, init), { SITE });

test("the Worker sends the object's type and ETag with ten minutes of cache, 304 on a match, 301s, and 404.html", async () => {
  const b = bucket(), page = await at('/saga/en/landnam/', {}, b);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'the file saga/en/landnam/index.html');
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'public, max-age=600');
  assert.match(page.headers.get('etag'), /^"[0-9a-f]{32}"$/);
  assert.deepEqual(b.reads, ['saga/en/landnam/index.html'], 'a page costs one read');
  const same = await at('/saga/en/landnam/', { headers: { 'if-none-match': page.headers.get('etag') } });
  assert.deepEqual([same.status, same.headers.get('etag'), await same.text()], [304, page.headers.get('etag'), '']);
  const script = await at('/saga/story.js');
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const head = await at('/harita.js', { method: 'HEAD' });
  assert.deepEqual([head.status, await head.text(), head.headers.get('content-type')], [200, '', 'text/javascript; charset=utf-8']);
  const moved = await at('/saga/en?step=2');
  assert.deepEqual([moved.status, moved.headers.get('location')], [301, '/saga/en/?step=2']);
  const old = await at('/saga/images/farm-1a2b3c.jpg');
  assert.deepEqual([old.status, old.headers.get('location')], [301, REDIRECTS['/saga/images/farm-1a2b3c.jpg']]);
  const missing = await at('/saga/en/nowhere/');
  assert.deepEqual([missing.status, missing.headers.get('content-type'), await missing.text()], [404, 'text/html; charset=utf-8', 'There is no page at this address.']);
  const encoded = await at('/saga/%65n/');
  assert.equal(encoded.status, 200);
  assert.equal((await at('/', { method: 'POST' })).status, 405);
  // a bucket without 404.html says so in plain text
  const { '404.html': _, ...rest } = FILES;
  assert.deepEqual([(await at('/nowhere', {}, bucket(rest))).status, await (await at('/nowhere', {}, bucket(rest))).text()], [404, 'not found']);
});
