// The harita command: exit codes and the usage line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { build } from './_kitap.mjs';

const BIN = fileURLToPath(new URL('../bin/harita.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

test('no command prints usage and exits 2', () => {
  const r = run(os.tmpdir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage: harita build/);
});

test('an unknown flag prints the usage and exits 2', () => {
  const r = run(os.tmpdir(), 'build', '--strcit');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option '--strcit'/);
  assert.match(r.stderr, /usage: harita build/);
});

test('build in a folder without content exits 1 with the error alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cli-'));
  const r = run(root, 'build');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'error: content/: no story.yaml found, run this from a content project\n');
});

test('build in the example exits 0 and writes dist/', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cli-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  // fill the elevation cache with a stand-in tile first, so the command finds every tile and stays offline
  const tile = PNG.sync.write(new PNG({ width: 256, height: 256 }));
  await build({ root, log: () => {}, elevation: async () => tile, localAssets: true });
  const r = run(root, 'build', '--local-assets');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote dist\/settlement-of-iceland\/ \(story\.js/);
  assert.ok(fs.existsSync(path.join(root, 'dist/index.html')));
  assert.equal(run(root, 'patterns').status, 0);
});

test('check prints ok and exits 0, or the problems and exits 1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cli-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  let r = run(root, 'check', 'settlement-of-iceland');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'ok\n');
  fs.rmSync(path.join(root, 'content/settlement-of-iceland/pages/010-landnam/text/en.md'));
  r = run(root, 'check', 'settlement-of-iceland', 'landnam');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /010-landnam: text\/en\.md is missing\n1 problem\n$/);
});

test('coast prints the shore points inside a box, western longitudes included', () => {
  const r = run(os.tmpdir(), 'coast', 'Spain', '-5.6', '35.9', '-5.2', '36.3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[-5\.\d{3},3[56]\.\d{3}\]/);
});

test('image writes a story image folder and prints its name, or the usage when the caption is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cli-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'farm.png'), PNG.sync.write(new PNG({ width: 4, height: 4 })));
  const r = run(root, 'image', 'farm.png', 'farm', '--caption', 'The farm', '--story', 'settlement-of-iceland');
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.match(/name it as (farm-[0-9a-f]{6})\n$/)[1];
  assert.match(fs.readFileSync(path.join(root, 'content/settlement-of-iceland/shared/images', id, 'image.yaml'), 'utf8'), /^caption: The farm\nfile: image\.png\nsha256: [0-9a-f]{64}\n$/);
  assert.match(run(root, 'rehash').stdout, /^wrote the file and sha256 of 0 image folders\n$/);
  assert.match(run(root, 'image', 'farm.png', 'farm').stderr, /^error: usage: kitap image <file or url> <name> --caption <text>/);
});

test('zones prints the pairs it finds and where the review page is', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cli-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  const r = run(root, 'zones');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'no pairs, see .cache/kitap/zones.html\n');
  assert.ok(fs.existsSync(path.join(root, '.cache/kitap/zones.html')));
});

test('zones refuses a zone id without its own --replace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harita-cli-'));
  fs.cpSync(EXAMPLE, root, { recursive: true });
  const r = run(root, 'zones', '--share', 'a/x', '--replace', 'b/y', 'c/z');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^harita zones takes no zone ids here: write --replace before each one/);
});
