#!/usr/bin/env node
// harita build | check | dev | i18n | image | rehash | upload | deploy | zones | patterns | coast, run from a content project folder.
import { parseArgs } from 'util';
import { build, check, dev, patterns, i18n, image, rehash, upload, deploy, zones } from '../src/index.mjs';
import { coast } from '../src/plans.mjs';

const USAGE = 'usage: harita build [--strict] [--local-assets] [--only <story> ...] [--story <id>] [--out <dir>] | harita check <story> [page id ...] | harita dev [--story <id>] [--out <dir>] [--port <n>] | harita i18n <lang> [--story id] | harita image <file or url> <name> --caption <text> [--credit <text>] [--source <url>] [--story <id>] | harita rehash | harita upload [--story <id>] [--dry-run] | harita deploy [--dry-run] | harita zones [--like <file>] [--same-story] [--share <story>/<id> [--replace <story>/<id>]...] [--apart <zone> <zone> --why <text>] | harita patterns [--fix] | harita coast <country> <w> <s> <e> <n>';
// coast reads its numbers as they are, since parseArgs takes a western longitude such as -5.2 for a flag
if (process.argv[2] === 'coast') {
  const [country, ...box] = process.argv.slice(3), nums = box.map(Number);
  if (!country || nums.length !== 4 || !nums.every(Number.isFinite)) { console.error(USAGE); process.exit(2); }
  try { for (const pts of coast(country, nums)) console.log(pts.map(([x, y]) => `[${x.toFixed(3)},${y.toFixed(3)}]`).join(' ')); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }
  process.exit(0);
}
let args;
try {
  args = parseArgs({ allowPositionals: true, options: { strict: { type: 'boolean' }, 'local-assets': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, fix: { type: 'boolean' }, story: { type: 'string' }, caption: { type: 'string' }, credit: { type: 'string' }, source: { type: 'string' }, like: { type: 'string' }, share: { type: 'string' }, replace: { type: 'string', multiple: true }, 'same-story': { type: 'boolean' }, apart: { type: 'boolean' }, why: { type: 'string' }, only: { type: 'string', multiple: true }, out: { type: 'string' }, port: { type: 'string' } } });
} catch (err) { // an unknown or incomplete flag
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
const { positionals: [cmd, lang, ...rest], values: opt } = args;
try {
  if (cmd === 'build') await build({ strict: opt.strict, localAssets: opt['local-assets'], only: opt.only, story: opt.story, out: opt.out });
  else if (cmd === 'check' && lang) {
    const problems = check({ story: lang, pages: rest });
    for (const m of problems) console.log(m);
    console.log(problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'}` : 'ok');
    process.exitCode = problems.length ? 1 : 0;
  }
  else if (cmd === 'i18n' && lang) i18n({ lang, story: opt.story });
  else if (cmd === 'image' && lang) await image({ file: lang, name: rest[0], caption: opt.caption, credit: opt.credit, source: opt.source, story: opt.story });
  else if (cmd === 'rehash') rehash();
  else if (cmd === 'upload') await upload({ story: opt.story, dryRun: opt['dry-run'] });
  else if (cmd === 'deploy') await deploy({ dryRun: opt['dry-run'] });
  else if (cmd === 'zones' && (opt.apart ? rest.length > 1 : lang)) { console.error(`${opt.apart ? 'harita zones --apart takes two zones' : 'harita zones takes no zone ids here: write --replace before each one'}\n${USAGE}`); process.exit(2); }
  else if (cmd === 'zones') zones({ like: opt.like, share: opt.share, replace: opt.replace ?? [], sameStory: opt['same-story'], apart: opt.apart ? [lang, rest[0]] : null, why: opt.why });
  else if (cmd === 'dev') dev({ story: opt.story, out: opt.out, ...(opt.port ? { port: Number(opt.port) } : {}) });
  else if (cmd === 'patterns') {
    const left = patterns({ fix: opt.fix });
    if (left.length && !opt.fix) { console.log('run harita patterns --fix to write the suggested patterns into story.yaml'); process.exit(1); }
  }
  else { console.error(USAGE); process.exit(2); }
} catch (err) { // content errors are expected, print them without a stack trace
  console.error(`error: ${err.message}`);
  process.exit(1);
}
