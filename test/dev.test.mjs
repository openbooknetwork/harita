// The watcher: which changes rebuild which stories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { build, dev } from '../src/index.mjs';

const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const STORY = 'content/settlement-of-iceland';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('dev rebuilds the story that changed, and every story when site.yaml changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-dev-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  fs.cpSync(path.join(root, STORY), path.join(root, 'content/second-story'), { recursive: true });
  fs.writeFileSync(path.join(root, 'content/second-story/story.yaml'), read(root, 'content/second-story/story.yaml').replace('id: settlement-of-iceland', 'id: second-story'));
  // fill the elevation cache with a stand-in tile first, so the builds dev starts stay offline
  const tile = PNG.sync.write(new PNG({ width: 256, height: 256 }));
  await build({ root, log: () => {}, elevation: async () => tile, localAssets: true });

  let ok = 0;
  const server = dev({ root, port: 0, log: l => { if (l.startsWith('build ok')) ok++; } });
  const builds = async n => { for (let i = 0; i < 300 && ok < n; i++) await sleep(100); assert.equal(ok, n, `build ${n} finished`); };
  try {
    await builds(1);
    // a mark in the first story's page shows whether a build writes it again
    const mark = () => fs.appendFileSync(path.join(root, 'dist/settlement-of-iceland/index.html'), '<!-- kept -->');
    const kept = () => read(root, 'dist/settlement-of-iceland/index.html').endsWith('<!-- kept -->');
    mark();
    fs.appendFileSync(path.join(root, 'content/second-story/pages/010-landnam/text/en.md'), '\nA line for the second story.\n');
    await builds(2);
    assert.ok(kept(), 'the first story stays as it was');
    assert.ok(read(root, 'dist/second-story/en/landnam/index.html').includes('A line for the second story.'));
    fs.writeFileSync(path.join(root, 'site.yaml'), read(root, 'site.yaml').replace('Example histories', 'Renamed histories'));
    await builds(3);
    assert.ok(read(root, 'dist/index.html').includes('Renamed histories'));
    assert.ok(!kept(), 'a site.yaml change rebuilds every story');
    // as on GitHub Pages: a folder without its slash redirects, an unknown path gets 404.html
    const at = p => fetch(`http://localhost:${server.address().port}${p}`, { redirect: 'manual' });
    const moved = await at('/settlement-of-iceland/en');
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/settlement-of-iceland/en/');
    const missing = await at('/settlement-of-iceland/en/nowhere/');
    assert.equal(missing.status, 404);
    assert.ok((await missing.text()).includes('There is no page at this address.'));
    assert.match((await at('/harita.js')).headers.get('content-type'), /^text\/javascript/);
    // a path in redirects.json goes to its target, as the Worker sends it
    fs.writeFileSync(path.join(root, 'dist/redirects.json'), JSON.stringify({ '/images/farm-abc123.jpg': 'https://assets.example.org/images/0/farm-abc123.jpg' }));
    const old = await at('/images/farm-abc123.jpg');
    assert.deepEqual([old.status, old.headers.get('location')], [301, 'https://assets.example.org/images/0/farm-abc123.jpg']);
  } finally {
    server.close();
  }
});
