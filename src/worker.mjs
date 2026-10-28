// The Worker that serves the site from the pages bucket. A content project deploys `export default site()` with the
// bucket bound as SITE. It answers paths as harita dev does, see routes.mjs, and keeps each answer in the data
// centre's cache for the ten minutes a reader's browser keeps it.
import { resolve } from './routes.mjs';

const CACHE = 'public, max-age=600';
// a folder of dist/vendor/ names its package's version, so its files never change
const cacheFor = key => /^vendor\/[^/]+@[^/]+\//.test(key) ? 'public, max-age=31536000, immutable' : CACHE;

// The answer to a request's URL from the bucket, with the object's Content-Type and ETag.
async function answer(bucket, url) {
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
  // the object a path names is read once: the check and the answer share it
  const objects = new Map();
  const exists = async key => { if (!objects.has(key)) objects.set(key, await bucket.get(key)); return Boolean(objects.get(key)); };
  const redirect = async p => (await (await bucket.get('redirects.json'))?.json())?.[p] ?? null;
  const r = await resolve(path, exists, { redirect, query: url.search });
  if (r.location) return new Response(null, { status: 301, headers: { location: r.location, 'cache-control': CACHE } });
  const obj = objects.get(r.key) ?? await bucket.get(r.key);
  if (!obj) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': CACHE } });
  return new Response(obj.body, { status: r.status, headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', etag: obj.httpEtag, 'cache-control': cacheFor(r.key) } });
}

// A 304 for a page the browser holds, else the answer, without its body for HEAD.
function reply(request, res) {
  const etag = res.headers.get('etag'), given = request.headers.get('if-none-match');
  if (res.status === 200 && etag && given && given.split(',').map(s => s.trim()).some(t => t === etag || t === '*'))
    return new Response(null, { status: 304, headers: { etag, 'cache-control': res.headers.get('cache-control') } });
  return request.method === 'HEAD' ? new Response(null, res) : res;
}

// The Worker: fetch(request, env, ctx) with env.SITE the bucket. The data centre's cache holds each URL's answer.
export function site() {
  return {
    async fetch(request, env, ctx) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      const url = new URL(request.url), cache = globalThis.caches?.default ?? null, cacheKey = new Request(url.href);
      let res = cache ? await cache.match(cacheKey) : null;
      if (!res) {
        res = await answer(env.SITE, url);
        if (cache) { const keep = cache.put(cacheKey, res.clone()); ctx?.waitUntil ? ctx.waitUntil(keep) : await keep; }
      }
      return reply(request, res);
    },
  };
}
