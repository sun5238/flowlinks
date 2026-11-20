const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

test('all contributed menu commands exist and runtime assets are bundled', () => {
  assert.equal(manifest.name, 'flowlinks');
  assert.equal(manifest.publisher, 'local-flowlinks');
  assert.equal(manifest.displayName, 'FlowLinks');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, 'FlowLinks');
  assert.equal(manifest.repository.url, 'https://github.com/sun5238/flowlinks.git');
  assert.ok(manifest.keywords.includes('bookmark'));
  const commands = new Set(manifest.contributes.commands.map(entry => entry.command));
  for (const entries of Object.values(manifest.contributes.menus)) {
    for (const entry of entries) assert.ok(commands.has(entry.command), entry.command);
  }
  for (const asset of [
    manifest.main,
    'assets/flow-graph.svg',
    'assets/flow-graph.png',
    'assets/gutter.svg',
    'vendor/web-tree-sitter/tree-sitter.cjs',
    'vendor/web-tree-sitter/tree-sitter.wasm',
    'grammars/tree-sitter-c.wasm',
    'grammars/tree-sitter-rust.wasm',
  ]) assert.ok(existsSync(path.join(root, asset)), asset);
  assert.equal(manifest.icon, 'assets/flow-graph.png');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'assets/flow-graph.svg');
  assert.ok(readFileSync(path.join(root, 'assets/flow-graph.png')).readUInt32BE(0) === 0x89504e47);
  assert.match(readFileSync(path.join(root, 'assets/flow-graph.svg'), 'utf8'), /stroke-dasharray/);
  assert.doesNotMatch(readFileSync(path.join(root, 'src/tree.js'), 'utf8'), /ThemeIcon\('bookmark'\)/);
});

test('marketplace README describes installation in Chinese without local packages', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /## 安装/);
  assert.match(readme, /## 使用流程/);
  assert.match(readme, /扩展.*搜索 \*\*FlowLinks\*\*/);
  assert.doesNotMatch(readme, /VSIX|\.vsix|npm run package/);
});

test('marketplace publishing has no stored token and excludes local files', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  const ignores = readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /publish --oidc/);
  assert.doesNotMatch(workflow, /VSCE_PAT|AZURE_DEVOPS_EXT_PAT/);
  for (const pattern of ['.env', '.npmrc', 'test/**', 'dist/**', '.github/**']) {
    assert.ok(ignores.split('\n').includes(pattern), pattern);
  }
});

test('inline actions remain available in the right-click menu, including both move arrows', () => {
  const menu = manifest.contributes.menus;
  for (const name of ['moveUp', 'moveDown', 'editNodeNote', 'addMessage', 'deleteNode']) {
    const actions = menu['view/item/context'].filter(entry => entry.command === `flowlinks.${name}`);
    assert.ok(actions.some(entry => entry.group.startsWith('inline@')), name);
    assert.ok(actions.some(entry => !entry.group.startsWith('inline@')), name);
    assert.ok(actions.every(entry => entry.when.includes('viewItem')), name);
  }
  assert.ok(menu['view/item/context'].some(entry => entry.command === 'flowlinks.editMessage' && entry.group.startsWith('inline@')));
  assert.ok(menu['view/item/context'].some(entry => entry.command === 'flowlinks.editMessage' && !entry.group.startsWith('inline@')));
  for (const name of ['createGroup', 'selectGroup', 'expandAll', 'addNode']) {
    assert.ok(menu['view/title'].some(entry => entry.command === `flowlinks.${name}`), name);
  }
  for (const name of ['addNode', 'renameGroup', 'setActiveGroup', 'deleteGroup']) {
    assert.ok(menu['view/item/context'].some(entry => entry.command === `flowlinks.${name}` && entry.when.includes('graphGroup')), name);
  }
  const addNode = manifest.contributes.commands.find(entry => entry.command === 'flowlinks.addNode');
  assert.equal(addNode.title, 'Add Node');
  assert.equal(addNode.category, 'FlowLinks');
  assert.ok(menu['editor/context'].some(entry => entry.command === addNode.command));
  assert.ok(!menu.commandPalette.some(entry => entry.command === 'flowlinks.deleteNode'));
  assert.ok(!menu.commandPalette.some(entry => entry.command === 'flowlinks.clearWorkspaceData'));
  assert.ok(menu['view/title'].some(entry => entry.command === 'flowlinks.clearWorkspaceData'));
  assert.ok(menu['view/item/context'].some(entry => entry.command === 'flowlinks.editNodeName' && entry.when.includes('graphNode')));
  assert.ok(!manifest.contributes.commands.some(entry => entry.command === 'flowlinks.setFlowLabel'));
  assert.ok(manifest.contributes.commands.some(entry => entry.command === 'flowlinks.renameGroup' && entry.title === 'Rename Group'));
  assert.ok(manifest.contributes.commands.some(entry => entry.command === 'flowlinks.editNodeName' && entry.title.includes('Name')));
  assert.ok(manifest.contributes.commands.some(entry => entry.command === 'flowlinks.editNodeNote' && entry.title.includes('Note')));
});
