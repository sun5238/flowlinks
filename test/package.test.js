const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('packager uses an allowlist and no subprocess', () => {
  const script = path.resolve(__dirname, '..', 'scripts', 'package_vsix.py');
  assert.ok(existsSync(script));
  const source = readFileSync(script, 'utf8');
  assert.match(source, /FILES = \(/);
  assert.match(source, /zipfile\.ZipFile/);
  assert.doesNotMatch(source, /subprocess|bookmark-flow\/|code-flow\//);
});

test('packaging command and extension identity are declared', () => {
  assert.equal(manifest.scripts.package, 'python3 scripts/package_vsix.py');
  assert.equal(manifest.publisher, 'FlowLinks');
  assert.equal(manifest.main, './src/extension.js');
});
