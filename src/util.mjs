// Small helpers the build, harita zones and harita image share.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const listDirs = p => fs.existsSync(p) ? fs.readdirSync(p).filter(d => fs.statSync(path.join(p, d)).isDirectory()).sort() : [];
// a folder's id: its name without the number that orders it
export const idOf = name => name.replace(/^\d+-/, '');
export const boxesMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
export const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;
export const plural = (n, word) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;
// Progress of an upload: on a terminal one line rewritten in place, elsewhere a line every thousand objects. what names
// the story or the folder going up, and done clears the line once its summary is about to print.
export const progressLine = ({ what, n, total, bytes, done }) => {
  const line = `${what}: ${n.toLocaleString('en')} of ${total.toLocaleString('en')} objects, ${mb(bytes)}`;
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${done ? '' : line}`);
  else if (!done && n % 1000 === 0) console.log(line);
};
