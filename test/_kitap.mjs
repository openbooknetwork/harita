// The book's commands as the tests call them: kitap's, run with the map engine, so a test reads as before the split.
import { fileURLToPath } from 'url';
import engine from '../src/index.mjs';
const ENGINE_PATH = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
import * as kitap from '@openbooknetwork/kitap';
import { buildPages as kitapBuildPages, storyAssets as kitapStoryAssets } from '@openbooknetwork/kitap/src/build.mjs';
import { patterns as haritaPatterns } from '../src/palette.mjs';

const withEngine = fn => (opts = {}) => fn({ engine, ...opts });
export const build = withEngine(kitap.build);
export const check = withEngine(kitap.check);
export const i18n = withEngine(kitap.i18n);
export const upload = withEngine(kitap.upload);
export const dev = (opts = {}) => kitap.dev({ engine: ENGINE_PATH, ...opts });
export const buildPages = withEngine(kitapBuildPages);
export const storyAssets = withEngine(kitapStoryAssets);
export const patterns = withEngine(haritaPatterns);
export const { image, rehash, deploy, describe, resolve } = kitap;
export { zones } from '../src/zones.mjs';
export * as schema from '../src/schema.mjs';
export { storeReader } from '@openbooknetwork/kitap/src/store.mjs';
export { webpSizes } from '@openbooknetwork/kitap/src/upload.mjs';
export { site } from '@openbooknetwork/kitap/src/worker.mjs';
// a story's bundle with the map's fields beside the book's, as the tests read it
export const flat = B => ({ ...B, ...B.harita, pages: B.pages.map(p => ({ ...p, ...p.harita })) });
