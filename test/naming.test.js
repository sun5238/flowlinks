const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NodeNamer } = require('../src/naming');

const namer = new NodeNamer();

function document(source, languageId) {
  return {
    uri: { fsPath: `/src/main.${languageId === 'rust' ? 'rs' : 'c'}` },
    languageId,
    getText: () => source,
    lineAt: line => ({ text: source.split('\n')[line] }),
  };
}

function selection(source, needle, occurrence = 0) {
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) offset = source.indexOf(needle, offset + 1);
  const prefix = source.slice(0, offset);
  const active = { line: prefix.split('\n').length - 1, character: prefix.split('\n').at(-1).length };
  return { active, start: active, end: active, isEmpty: true };
}

test('Rust definitions, self method, explicit type and plain functions', async () => {
  const source = `impl Worker {
    fn handle(&self) {
        self.send(req);
        Worker::start(req);
        send(req);
    }
}`;
  const doc = document(source, 'rust');
  assert.equal(await namer.suggest(doc, selection(source, 'handle(')), 'handle');
  assert.equal(await namer.suggest(doc, selection(source, 'self.send(')), 'Worker::send');
  assert.equal(await namer.suggest(doc, selection(source, 'Worker::start(')), 'Worker::start');
  assert.equal(await namer.suggest(doc, selection(source, 'send(req)', 1)), 'send');
});

test('C function call and function definition are named separately', async () => {
  const source = `void entry(void) {
    send(req);
    ops->send(req);
}`;
  const doc = document(source, 'c');
  assert.equal(await namer.suggest(doc, selection(source, 'entry(')), 'entry');
  assert.equal(await namer.suggest(doc, selection(source, 'send(req);')), 'send');
  assert.equal(await namer.suggest(doc, selection(source, 'ops->send(')), 'ops->send(req)');
});

test('unknown receiver accepts only qualified LSP static name, otherwise code text', async () => {
  const source = 'fn f() { client.run(req); }';
  const doc = document(source, 'rust');
  const atCall = selection(source, 'client.run(');
  assert.equal(await namer.suggest(doc, atCall, async () => 'Worker::run'), 'Worker::run');
  assert.equal(await namer.suggest(doc, atCall, async () => undefined), 'client.run(req)');
  assert.equal(await namer.suggest(doc, atCall, async () => 'run'), 'client.run(req)');
});

test('dynamic receiver and C function pointers keep their source expression', async () => {
  const rust = 'fn dispatch(worker: &dyn Handler) { worker.run(); }';
  const c = 'void dispatch(void) { (*callback)(request); }';
  assert.equal(await namer.suggest(document(rust, 'rust'), selection(rust, 'worker.run(')), 'worker.run()');
  assert.equal(await namer.suggest(document(c, 'c'), selection(c, '(*callback)(')), '(*callback)(request)');
});

test('qualified name can be derived from a Rust method definition', async () => {
  const source = 'impl Worker { fn run(&self) {} }';
  const position = selection(source, 'run(').active;
  assert.equal(await namer.nameAtDefinition(document(source, 'rust'), position), 'Worker::run');
});

test('missing parser asset still uses the bookmarked source', async () => {
  const source = 'fn f() { send(data); }';
  const missing = new NodeNamer('/path/that/does/not/exist');
  assert.equal(await missing.suggest(document(source, 'rust'), selection(source, 'send(')), source);
});

test('large source files skip synchronous parsing and retain quick source fallback', async () => {
  const source = `/*${'x'.repeat(300_000)}*/\nfn run() { send(data); }`;
  const doc = document(source, 'rust');
  const start = performance.now();
  assert.equal(await namer.suggest(doc, selection(source, 'send('), async () => undefined), 'fn run() { send(data); }');
  assert.ok(performance.now() - start < 500, 'large source naming must not block the extension host');
});

test('nested calls use the expression closest to the cursor', async () => {
  const source = 'fn f() { send(encode(req)); }';
  const doc = document(source, 'rust');
  assert.equal(await namer.suggest(doc, selection(source, 'send(')), 'send');
  assert.equal(await namer.suggest(doc, selection(source, 'encode(')), 'encode');
});

test('bookmarks on the indentation of a call line still use its callee', async () => {
  const source = 'fn entry() {\n    send(req);\n}';
  const doc = document(source, 'rust');
  const indentation = { line: 1, character: 0 };
  assert.equal(await namer.suggest(doc, { active: indentation, start: indentation, end: indentation, isEmpty: true }), 'send');
});

test('unsupported languages fall back to bookmark source', async () => {
  const source = 'invoke(data);';
  assert.equal(await namer.suggest(document(source, 'plaintext'), selection(source, 'invoke')), source);
});
