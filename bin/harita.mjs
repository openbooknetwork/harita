#!/usr/bin/env node
// harita build | check | dev | i18n | image | rehash | upload | deploy | zones | patterns | coast, run from a content
// project folder. The book's commands are kitap's, run with the map engine; zones, patterns and coast are the map's.
import { fileURLToPath } from 'url';
import { run } from '@openbooknetwork/kitap/cli';
import engine, { patterns, zones, coast } from '../src/index.mjs';

const ENGINE_PATH = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const USAGE = ' | harita zones [--like <file>] [--same-story] [--share <story>/<id> [--replace <story>/<id>]...] [--apart <zone> <zone> --why <text>] | harita patterns [--fix] | harita coast <country> <w> <s> <e> <n>';
// coast reads its numbers as they are, since parseArgs takes a western longitude such as -5.2 for a flag
if (process.argv[2] === 'coast') {
  const [country, ...box] = process.argv.slice(3), nums = box.map(Number);
  if (!country || nums.length !== 4 || !nums.every(Number.isFinite)) { console.error(`usage: harita coast <country> <w> <s> <e> <n>`); process.exit(2); }
  try { for (const pts of coast(country, nums)) console.log(pts.map(([x, y]) => `[${x.toFixed(3)},${y.toFixed(3)}]`).join(' ')); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }
  process.exit(0);
}
await run(process.argv.slice(2), {
  name: 'harita', engine, enginePath: ENGINE_PATH, usage: USAGE,
  options: { fix: { type: 'boolean' }, like: { type: 'string' }, share: { type: 'string' }, replace: { type: 'string', multiple: true }, 'same-story': { type: 'boolean' }, apart: { type: 'boolean' }, why: { type: 'string' } },
  own: (cmd, [lang, ...rest], opt) => {
    if (cmd === 'zones' && (opt.apart ? rest.length > 1 : lang)) { console.error(`${opt.apart ? 'harita zones --apart takes two zones' : 'harita zones takes no zone ids here: write --replace before each one'}`); process.exit(2); }
    if (cmd === 'zones') { zones({ like: opt.like, share: opt.share, replace: opt.replace ?? [], sameStory: opt['same-story'], apart: opt.apart ? [lang, rest[0]] : null, why: opt.why }); return true; }
    if (cmd === 'patterns') {
      const left = patterns({ fix: opt.fix, engine });
      if (left.length && !opt.fix) { console.log('run harita patterns --fix to write the suggested patterns into story.yaml'); process.exit(1); }
      return true;
    }
    return false;
  },
});
