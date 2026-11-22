import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE, VERSION } from '../src/version.ts';

const root = path.resolve(import.meta.dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8').trim();

test('Release: the version and name in the code match the files the release workflow reads', () => {
  assert.equal(VERSION, read('VERSION'));
  assert.equal(RELEASE, read('RELEASE_NAME'));
  for (const f of ['desktop/package.json', 'package.json', 'web/package.json', 'librarian/package.json']) {
    assert.equal(JSON.parse(read(f)).version, VERSION, f);
  }
  assert.equal(JSON.parse(read('desktop/src-tauri/tauri.conf.json')).version, VERSION);
  assert.match(read('desktop/src-tauri/Cargo.toml'), new RegExp(`^version = "${VERSION.replace(/[.]/g, '\\.')}"`, 'm'));
  assert.ok(fs.existsSync(path.join(root, 'docs/releases', `${RELEASE}.md`)), 'release notes exist');
});
