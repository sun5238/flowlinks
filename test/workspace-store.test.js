const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { ReadingGraph } = require('../src/graph');
const { WorkspaceStore } = require('../src/workspace-store');

function store(root) {
  const vscode = {
    Uri: {
      parse: uri => ({ scheme: 'file', fsPath: fileURLToPath(uri) }),
      file: file => ({ toString: () => pathToFileURL(file).toString() }),
    },
  };
  return new WorkspaceStore(vscode, { uri: { fsPath: root } });
}

function graph(root) {
  const result = new ReadingGraph();
  const group = result.addGroup('Request');
  result.addNode({ uri: pathToFileURL(path.join(root, 'src', 'main.rs')).toString(),
    line: 2, character: 0, name: 'entry', groupId: group.id });
  return result;
}

test('shared file uses relative source paths across different mounts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowlinks-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = store(root);
  const initial = graph(root);
  assert.deepEqual(await first.load(initial.snapshot()), initial.snapshot());
  await first.save(initial.snapshot());
  const raw = JSON.parse(await fs.readFile(first.file, 'utf8'));
  assert.deepEqual(Object.values(raw.graph.nodes)[0].uri, { relativePath: 'src/main.rs' });

  const otherRoot = path.join(root, 'different-mount');
  const second = store(otherRoot);
  const loaded = new ReadingGraph(second.decode(await fs.readFile(first.file, 'utf8')));
  assert.equal(loaded.nodes()[0].uri, pathToFileURL(path.join(otherRoot, 'src', 'main.rs')).toString());
  assert.equal(loaded.nodes()[0].line, 2);
});

test('a stale instance can replace the complete shared snapshot', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowlinks-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = store(root);
  const second = store(root);
  await first.load();
  await second.load();
  const initial = graph(root);
  await first.save(initial.snapshot());
  const stale = graph(root);
  stale.addGroup('Last writer');
  await second.save(stale.snapshot());
  assert.deepEqual(new ReadingGraph(await first.refresh()).groups().map(group => group.name), ['Request', 'Last writer']);
  assert.equal((await fs.readdir(first.directory)).filter(name => name.startsWith('flowlinks.conflict-')).length, 0);
  assert.equal(JSON.parse(await fs.readFile(first.file, 'utf8')).format, 'flowlinks-workspace-v1');
});

test('invalid shared data is rejected without replacing it or falling back to old state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowlinks-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shared = store(root);
  await fs.mkdir(shared.directory);
  await fs.writeFile(shared.file, '{broken');
  await assert.rejects(shared.load(graph(root).snapshot()), SyntaxError);
  assert.equal(await fs.readFile(shared.file, 'utf8'), '{broken');
});

test('a delayed read does not undo a newer local write', async () => {
  const shared = store('/test');
  let complete;
  shared.readRaw = () => new Promise(resolve => { complete = resolve; });
  const reading = shared.refresh();
  shared.base = 'newer';
  complete('older');
  assert.equal(await reading, undefined);
  assert.equal(shared.base, 'newer');
});
