// harita i18n <lang> [--story id]: builds quietly to collect every string, then writes the <lang>.yaml catalogues of
// each story, of each battle, image and zone folder a story uses, and of the site, keeping the translations there.
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { buildPages, uiCatalogue } from './build.mjs';
import { flatten, catalogueText } from './i18n.mjs';

export function i18n({ root = process.cwd(), lang, story, log = console.log } = {}) {
  if (!lang) throw new Error('usage: harita i18n <lang> [--story id]');
  // one story builds alone into a folder thrown away after, so a half edited story elsewhere does not stop it
  const out = story && fs.mkdtempSync(path.join(os.tmpdir(), 'harita-i18n-'));
  let r;
  try { r = buildPages({ root, log: () => {}, story, out, localAssets: true }); } finally { if (out) fs.rmSync(out, { recursive: true, force: true }); }
  const written = [];
  const write = (file, entries, heading) => {
    const existing = fs.existsSync(file) ? flatten(yaml.load(fs.readFileSync(file, 'utf8')) ?? {}) : {};
    const { text, filled, total } = catalogueText(lang, entries, existing, heading);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    log(`wrote ${path.relative(root, file)}: ${filled} of ${total} strings translated`);
    written.push(file);
  };
  for (const [id, { dir, entries }] of Object.entries(r.i18n.stories)) write(path.join(root, dir, 'i18n', lang + '.yaml'), entries, `${lang} strings for the story "${id}".`);
  // a battle's, image folder's or zone folder's catalogues sit in its folder, for each language a story using it has
  for (const [dir, f] of Object.entries(r.i18n.folders)) {
    if (lang === f.defaultLang || !f.langs.includes(lang)) continue;
    write(path.join(root, dir, 'i18n', lang + '.yaml'), f.entries, `${lang} strings for the ${f.kind} "${f.id}".`);
  }
  if (!story) write(path.join(root, 'i18n', lang + '.yaml'), r.i18n.site, `${lang} strings for the site.`);
  if (!story && lang !== 'en') {
    const u = uiCatalogue(root, lang, r.themes), file = path.join(root, 'i18n', 'ui', lang + '.yaml');
    if (u.missing.length || fs.existsSync(file)) {
      const { text, filled, total } = catalogueText(lang, u.entries, u.existing, `${lang} interface strings: buttons, labels, messages, theme names. Overrides what harita ships.`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
      log(`wrote ${path.relative(root, file)}: ${filled} of ${total} strings translated`); written.push(file);
    } else log(`interface: harita ships all ${u.entries.length} strings for ${lang}`);
  }
  return written;
}
