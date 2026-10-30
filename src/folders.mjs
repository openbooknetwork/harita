// The map's library kinds under shared/: a battle folder holds battle.yaml or pages, a zone folder zone.geojson.
import fs from 'fs';
import path from 'path';
export { libraryItems, storyFolders } from '@openbooknetwork/kitap';

export const isBattle = d => fs.existsSync(path.join(d, 'battle.yaml')) || fs.existsSync(path.join(d, 'pages'));
export const isZone = d => fs.existsSync(path.join(d, 'zone.geojson'));
