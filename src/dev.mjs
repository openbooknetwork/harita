// Watch content and src; rebuild on change; serve dist/ with a reload hook for open tabs.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, typeOf } from './routes.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELOAD = `<script>(()=>{let v=null;setInterval(async()=>{try{const r=await fetch('/__version');const t=await r.text();if(v===null)v=t;else if(t!==v)location.reload();}catch{}},1000)})()</script>`;

// Serve root/dist on the port and rebuild on changes: a change in one story's folder rebuilds that story and the main
// page, any other change every story. Returns the http server. Builds run in a child process, so package edits apply,
// and with --local-assets, so the images on this machine show before they are uploaded.
// story serves that one story as a site of its own, built into out, by default dist/.
export function dev({ root = process.cwd(), port = Number(process.env.PORT) || 8080, log = console.log, story = null, out = null } = {}) {
  const DIST = out ? path.resolve(root, out) : path.join(root, 'dist'), CONTENT = path.join(root, 'content');
  const WATCH = [CONTENT, path.join(root, 'i18n'), path.join(root, 'plugins'), path.join(PKG, 'src')].filter(fs.existsSync);

  // what the next build covers: every story, or the story folders changed since the last build
  let version = 0, building = false, queued = false, all = true, changed = new Set();
  function build() {
    if (building) { queued = true; return; }
    building = true;
    const t0 = Date.now(), wasAll = all, stories = [...changed];
    all = false; changed = new Set();
    const scope = story ? ['--story', story, ...(out ? ['--out', out] : [])] : wasAll ? [] : stories.flatMap(s => ['--only', s]);
    const p = spawn(process.execPath, [path.join(PKG, 'bin', 'harita.mjs'), 'build', '--local-assets', ...scope], { stdio: 'inherit', cwd: root });
    p.on('exit', code => {
      building = false;
      if (code === 0) { version = Date.now(); log(`build ok in ${Date.now() - t0} ms, tabs reload`); }
      else {
        // the next build retries what this one covered, so a story saved alongside the broken one is not left behind
        all ||= wasAll; for (const s of stories) changed.add(s);
        log('build failed, fix the error above and save again');
      }
      if (queued) { queued = false; build(); }
    });
  }

  let timer = null;
  const onChange = (dir, file) => {
    if (file && /(^|\/)\./.test(file)) return; // editor swap files and the like
    const story = dir === CONTENT && file?.includes(path.sep) ? file.split(path.sep)[0] : null;
    if (story && fs.existsSync(path.join(CONTENT, story, 'story.yaml'))) changed.add(story); else all = true;
    clearTimeout(timer); timer = setTimeout(build, 150);
  };
  const watchers = WATCH.map(dir => fs.watch(dir, { recursive: true }, (_, file) => onChange(dir, file)));
  // site.yaml sits beside dist/ and node_modules/, so the project folder is watched on its own level, for that file
  watchers.push(fs.watch(root, (_, file) => { if (file === 'site.yaml') onChange(root, file); }));

  const server = http.createServer(async (req, res) => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    let url = req.url.slice(0, req.url.length - query.length);
    try { url = decodeURIComponent(url); } catch {}
    if (url === '/__version') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(String(version)); }
    if (url === '/' && !fs.existsSync(path.join(DIST, 'index.html'))) {
      const stories = fs.existsSync(DIST) ? fs.readdirSync(DIST).filter(d => fs.existsSync(path.join(DIST, d, 'index.html'))) : [];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Stories</title><h1>Stories</h1><ul>${stories.map(s => `<li><a href="/${s}/">${s}</a></li>`).join('')}</ul>${RELOAD}`);
    }
    // the same answers as the Worker on the site: index pages, the slash redirect, redirects.json and 404.html
    const fileOf = key => path.join(DIST, key);
    const exists = key => { const f = fileOf(key); return f.startsWith(DIST + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile(); };
    const redirect = p => { const f = fileOf('redirects.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8'))[p] ?? null : null; };
    const r = await resolve(url, exists, { redirect, query });
    if (r.location) { res.writeHead(301, { location: r.location }); return res.end(); }
    const file = fileOf(r.key), status = r.status;
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(status, { 'content-type': typeOf(file), 'cache-control': 'no-store' });
    if (ext === '.html') return res.end(fs.readFileSync(file, 'utf8').replace('</body>', RELOAD + '</body>'));
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, () => {
    log(`serving ${path.relative(root, DIST)}/ at http://localhost:${server.address().port}/ and watching ${[...WATCH.map(d => path.basename(d)), 'site.yaml'].join(', ')}`);
    build();
  });
  server.on('close', () => { for (const w of watchers) w.close(); clearTimeout(timer); });
  return server;
}
