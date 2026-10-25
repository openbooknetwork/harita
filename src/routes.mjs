// How the site answers a path, shared by harita dev and the Worker, so a page behaves the same on a laptop and on
// the site. The module has no Node imports, so the Worker bundles it as it is.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export const typeOf = file => TYPES[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

const NOT_FOUND = { key: '404.html', status: 404 };

// The answer to a decoded path: { key, status } to serve, or { location } to redirect to with 301. A path ending in /
// serves its index.html. A path without its slash whose folder has an index.html redirects to the path with the
// slash, with query kept. A path redirect names redirects to its target. Any other path the site lacks gets 404.html.
// exists tells whether the site holds a key and redirect gives a path's target or null, and either may be async.
export async function resolve(path, exists, { redirect = () => null, query = '' } = {}) {
  const parts = path.split('/');
  if (parts[0] !== '' || parts.includes('..') || parts.includes('.')) return NOT_FOUND;
  if (path.endsWith('/')) { const key = path.slice(1) + 'index.html'; return await exists(key) ? { key, status: 200 } : NOT_FOUND; }
  const key = path.slice(1);
  if (await exists(key)) return { key, status: 200 };
  if (await exists(key + '/index.html')) return { location: path + '/' + query };
  const target = await redirect(path);
  return target ? { location: target } : NOT_FOUND;
}
