// Families that share a page must differ in colour or in pattern.
// patterns() reports the pairs that do not, and with fix writes a pattern into story.yaml for one family of each pair.
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { check, Story } from './schema.mjs';
import { pageZoneFamilies } from './build.mjs';
import { storyFolders } from './folders.mjs';

const PATTERNS = ['hatch', 'cross', 'dots'];
// CIELAB distance; at the 0.38 fill opacity the zones use, pairs under 30 were hard to tell apart in practice
export const DE_MIN = 30;

const lab = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [x, y, z] = [(0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883]
    .map(t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
export const deltaE = (a, b) => Math.round(Math.hypot(...lab(a).map((v, i) => v - lab(b)[i])));

// pages: [{ dir, families: [...] }]. Returns one finding per alike pair, with a pattern free on every page the
// weaker family (fewer pages) appears on, or null when all three are taken there.
export function alikePairs(families, pages) {
  const out = [], seen = new Set();
  const pagesOf = f => pages.filter(p => p.families.includes(f));
  for (const p of pages) for (const a of p.families) for (const b of p.families) {
    if (a >= b || seen.has(a + '/' + b)) continue;
    const fa = families[a], fb = families[b];
    if ((fa.pattern ?? null) !== (fb.pattern ?? null)) continue;
    const d = Math.min(deltaE(fa.color, fb.color), deltaE(fa.color_dark ?? fa.color, fb.color_dark ?? fb.color));
    if (d >= DE_MIN) continue;
    seen.add(a + '/' + b);
    const fix = pagesOf(a).length <= pagesOf(b).length ? a : b;
    const used = new Set(pagesOf(fix).flatMap(q => q.families).map(f => families[f].pattern).filter(Boolean));
    out.push({ a, b, dir: p.dir, distance: d, pattern: fa.pattern ?? 'plain', fix, suggestion: PATTERNS.find(x => !used.has(x)) ?? null });
  }
  return out;
}
export const describe = f => `families "${f.a}" and "${f.b}" look alike on ${f.dir}: colour distance ${f.distance}, both ${f.pattern}.`
  + (f.suggestion ? ` Give "${f.fix}" pattern: ${f.suggestion}, or run harita patterns --fix.` : ' All three patterns are taken on its pages, change a colour.');

// Insert "pattern: x" into the family's flow-style line in story.yaml, keeping comments and layout.
function writePattern(root, file, name, pattern) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex(l => new RegExp(`^\\s+${name}:\\s*\\{[^}]*\\}`).test(l));
  if (i < 0) throw new Error(`${path.relative(root, file)}: family "${name}" is not on one line as { ... }, add pattern: ${pattern} by hand`);
  lines[i] = lines[i].replace(/\s*\}/, `, pattern: ${pattern} }`);
  fs.writeFileSync(file, lines.join('\n'));
}

// Check every story under root/content. Returns the pairs still alike at the end, one entry per story and pair.
// With fix, each round writes one suggested pattern into story.yaml and checks again until no pair is left.
export function patterns({ root = process.cwd(), fix = false, log = console.log } = {}) {
  const content = path.join(root, 'content');
  const stories = storyFolders(content, p => path.relative(root, p));
  if (!stories.size) throw new Error('content/: no story.yaml found, run this from a content project');
  const left = [];
  for (const [id, dir] of stories) {
    const file = path.join(dir, 'story.yaml');
    for (let round = 0; round < 20; round++) {
      const story = check(Story, yaml.load(fs.readFileSync(file, 'utf8')), path.relative(root, file));
      // the families each page shows, read as the build reads the story, battles and shared zones included
      const pairs = alikePairs(story.families, pageZoneFamilies({ root, storyDir: dir }));
      if (!pairs.length) { if (!round) log(`${id}: every page's families differ in colour or pattern`); break; }
      const f = fix ? pairs.find(f => f.suggestion) : null;
      if (!f) { pairs.forEach(f => { log(`${id}: ${describe(f)}`); left.push({ story: id, ...f }); }); break; }
      writePattern(root, file, f.fix, f.suggestion);
      log(`${id}: "${f.fix}" gets pattern: ${f.suggestion}, it looked like "${f.fix === f.a ? f.b : f.a}" on ${f.dir}`);
    }
  }
  return left;
}
