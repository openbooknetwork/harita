// The scripts, fonts and map glyphs the pages load, copied from harita's packages into dist/vendor/, so a page loads
// nothing from another host. A package's folder names its version, so a browser can keep its files for good.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// a package's folder and version, found up from its main file, since some packages export no package.json
function pkg(name) {
  for (let dir = path.dirname(require.resolve(name)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) { const meta = JSON.parse(fs.readFileSync(file, 'utf8')); if (meta.name === name && meta.version) return { dir, version: meta.version }; }
  }
  throw new Error(`harita: the package ${name} is missing, reinstall harita`);
}
const folder = name => `${name.split('/').pop()}@${pkg(name).version}`;

const SCRIPTS = { maplibre: ['maplibre-gl', 'dist/maplibre-gl.js'], topojson: ['topojson-client', 'dist/topojson-client.min.js'], turf: ['@turf/turf', 'turf.min.js'] };
// the subsets the pages need: Latin, and Latin Extended for Turkish and the other languages written in Latin letters
const FONTS = [
  { family: 'Fraunces', name: '@fontsource-variable/fraunces', css: 'opsz.css', files: /^fraunces-latin(-ext)?-opsz-normal$/ },
  { family: 'Public Sans', name: '@fontsource-variable/public-sans', css: 'index.css', files: /^public-sans-latin(-ext)?-wght-normal$/ },
];
// the label font for the map, in harita's glyphs/ folder: Noto Sans from the Protomaps basemaps assets
export const GLYPH_FONT = 'noto-sans';

// each script's path under dist/, for the story page's <script> tags
export const scriptPaths = () => Object.fromEntries(Object.entries(SCRIPTS).map(([k, [name, file]]) => [k, `vendor/${folder(name)}/${path.basename(file)}`]));

const licence = dir => ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));

export function writeVendor(dist) {
  const out = path.join(dist, 'vendor');
  fs.rmSync(out, { recursive: true, force: true });
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
  for (const [name, file] of Object.values(SCRIPTS)) {
    const { dir } = pkg(name), to = path.join(out, folder(name));
    copy(path.join(dir, file), path.join(to, path.basename(file)));
    const lic = licence(dir) ?? licence(path.join(dir, path.dirname(file)));
    if (lic) copy(lic, path.join(to, path.basename(lic)));
  }
  // the packages' @font-face rules for the subsets above, under the family names the pages use
  const rules = [];
  for (const f of FONTS) {
    const { dir } = pkg(f.name), to = folder(f.name);
    for (const block of fs.readFileSync(path.join(dir, f.css), 'utf8').split('/* ').slice(1)) {
      const id = block.slice(0, block.indexOf(' */'));
      if (!f.files.test(id)) continue;
      copy(path.join(dir, 'files', `${id}.woff2`), path.join(out, to, `${id}.woff2`));
      rules.push(block.slice(block.indexOf('@font-face')).trim()
        .replace(/font-family: '[^']*'/, `font-family: '${f.family}'`).replace(/url\(\.\/files\//, `url(${to}/`));
    }
    copy(licence(dir), path.join(out, to, 'LICENSE'));
  }
  fs.writeFileSync(path.join(out, 'fonts.css'), rules.join('\n') + '\n');
  fs.cpSync(path.join(PKG, 'glyphs', GLYPH_FONT), path.join(out, 'glyphs', GLYPH_FONT), { recursive: true });
}
