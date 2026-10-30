// Moves the map's fields of every story.yaml and page.yaml under a harita: key, keeping the comments and the order
// of the lines. Run once in a content project when it moves from harita 0.5 to kitap: node nest-map-fields.mjs [root]
import fs from 'fs';
import path from 'path';

const STORY = ['extent', 'land', 'countries', 'hillshade', 'families', 'smoothing', 'max_zoom', 'labels'];
const PAGE = ['bbox', 'zones', 'routes', 'markers', 'battle', 'camera', 'emblem', 'map_sources'];

// The top level entries of a YAML file as runs of lines: a key's line and the indented lines and comments below it.
// Comments above a key belong to it. The file is rewritten with the map's runs indented under harita:.
export function nest(text, keys) {
  if (/^harita:/m.test(text)) return text;
  const lines = text.split('\n'), runs = [];
  let cur = { key: null, lines: [] };
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w-]*):/);
    if (m) { runs.push(cur); cur = { key: m[1], lines: [line] }; }
    else if (/^\S/.test(line) && !line.startsWith('#') && line.trim()) { cur.lines.push(line); } // a document marker or the like
    else cur.lines.push(line);
  }
  runs.push(cur);
  // leading comments of a run go with it, trailing blank lines stay with the run before
  const moved = runs.filter(r => r.key && keys.includes(r.key)), kept = runs.filter(r => !(r.key && keys.includes(r.key)));
  if (!moved.length) return text;
  const indent = r => r.lines.map(l => l.trim() ? '  ' + l : l);
  const out = [...kept.flatMap(r => r.lines)];
  while (out.length && !out.at(-1).trim()) out.pop();
  out.push('harita:', ...moved.flatMap(indent));
  while (out.length && !out.at(-1).trim()) out.pop();
  return out.join('\n') + '\n';
}

const root = path.resolve(process.argv[2] ?? '.');
let n = 0;
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name);
  if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(f); continue; }
  const keys = e.name === 'story.yaml' ? STORY : e.name === 'page.yaml' ? PAGE : null;
  if (!keys) continue;
  const text = fs.readFileSync(f, 'utf8'), next = nest(text, keys);
  if (next !== text) { fs.writeFileSync(f, next); n++; }
} };
walk(path.join(root, 'content'));
console.log(`nested the map fields of ${n} files under harita:`);
