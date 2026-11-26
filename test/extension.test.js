const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { ReadingGraph } = require('../src/graph');
const { WorkspaceStore } = require('../src/workspace-store');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isBefore(other) { return this.line < other.line || this.line === other.line && this.character < other.character; }
}

class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}

class Selection extends Range {
  constructor(start, end = start) { super(start, end); this.active = end; }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

class EventEmitter {
  constructor() { this.event = () => {}; }
  fire() {}
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
}

class MarkdownString {
  constructor() { this.value = ''; }
  appendMarkdown(value) { this.value += value; return this; }
  appendText(value) { this.value += value; return this; }
}

function mockHost(source, root) {
  const handlers = new Map();
  const callbacks = {};
  const saved = new Map();
  const prompts = [];
  const informationMessages = [];
  const infoReplies = [];
  const quickPickReplies = [];
  const reveals = [];
  const expanded = new Set();
  const errors = [];
  const confirmations = [];
  const progressControl = { cancelAfter: Infinity, started: 0 };
  const sourcePath = root ? path.join(root, 'main.rs') : '/test/main.rs';
  const uri = {
    scheme: 'file', fsPath: sourcePath, path: sourcePath,
    toString: () => pathToFileURL(sourcePath).toString(),
  };
  const document = {
    uri,
    languageId: 'rust',
    text: source,
    get lineCount() { return this.text.split('\n').length; },
    getText(range) {
      if (!range) return this.text;
      if (range.start.line === range.end.line) return this.lineAt(range.start.line).text.slice(range.start.character, range.end.character);
      return this.text;
    },
    lineAt(line) { return { text: this.text.split('\n')[line] }; },
  };
  const editor = {
    document,
    selection: new Selection(new Position(0, 0)),
    setDecorations(_type, marks) { this.marks = marks; },
    revealRange(range) { this.revealed = range; },
  };
  const mock = {
    Position, Range, Selection, EventEmitter, TreeItem, MarkdownString,
    ThemeIcon: class { constructor(name) { this.name = name; } },
    ThemeColor: class { constructor(name) { this.name = name; } },
    DataTransferItem: class { constructor(value) { this.value = value; } },
    OverviewRulerLane: { Right: 4 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    ProgressLocation: { Notification: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    Uri: {
      file: fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => pathToFileURL(fsPath).toString() }),
      parse: input => input === uri.toString() ? uri : { scheme: 'file', fsPath: fileURLToPath(input), toString: () => input },
    },
    RelativePattern: class { constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: root ? [{ uri: { scheme: 'file', fsPath: root } }] : undefined,
      getWorkspaceFolder: () => ({}),
      asRelativePath: resource => resource.fsPath,
      openTextDocument: async () => document,
      onDidChangeTextDocument: listener => { callbacks.edit = listener; return { dispose() {} }; },
      createFileSystemWatcher: () => ({
        onDidCreate: listener => { callbacks.file = listener; return { dispose() {} }; },
        onDidChange: listener => { callbacks.file = listener; return { dispose() {} }; },
        onDidDelete: listener => { callbacks.file = listener; return { dispose() {} }; },
        dispose() {},
      }),
    },
    window: {
      activeTextEditor: editor,
      visibleTextEditors: [editor],
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createTreeView: (id, options) => {
        mock.treeView = { id, options, reveal: async (element, details) => {
          reveals.push({ element, details });
          let parent = options.treeDataProvider.getParent(element);
          while (parent) {
            expanded.add(parent.kind === 'group' ? `group:${parent.groupId}` : `node:${parent.nodeId}`);
            parent = options.treeDataProvider.getParent(parent);
          }
          if (details?.expand) expanded.add(element.kind === 'group' ? `group:${element.groupId}` : `node:${element.nodeId}`);
        }, dispose() {} };
        return mock.treeView;
      },
      showErrorMessage: async text => { errors.push(text); },
      showWarningMessage: async (_text, options) => {
        if (options) assert.equal(options.modal, true);
        return confirmations.shift();
      },
      showInformationMessage: async text => { informationMessages.push(text); return infoReplies.shift(); },
      showTextDocument: async () => editor,
      showInputBox: async () => prompts.shift(),
      showQuickPick: async items => {
        const label = quickPickReplies.shift() || 'receive';
        return items.find(item => item.label === label);
      },
      withProgress: async (_options, task) => {
        progressControl.started++;
        return task({}, { get isCancellationRequested() { return reveals.length >= progressControl.cancelAfter; } });
      },
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id, handler) => { handlers.set(id, handler); return { dispose() {} }; },
      executeCommand: async () => [],
    },
  };
  const context = {
    extensionPath: path.resolve(__dirname, '..'),
    subscriptions: [],
    workspaceState: {
      get: key => saved.get(key),
      update: async (key, value) => {
        if (value === undefined) saved.delete(key);
        else saved.set(key, structuredClone(value));
      },
    },
  };
  return { mock, context, handlers, callbacks, saved, prompts, informationMessages, infoReplies,
    quickPickReplies, reveals, expanded, errors, confirmations, progressControl, editor, document };
}

function cursor(editor, needle) {
  const source = editor.document.text;
  const before = source.slice(0, source.indexOf(needle));
  editor.selection = new Selection(new Position(before.split('\n').length - 1, before.split('\n').at(-1).length));
}

function loadExtension(host) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? host.mock : original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/extension')];
    return require('../src/extension');
  } finally {
    Module._load = original;
  }
}

test('extension workflow captures, reparents, links, navigates, tracks and persists', async () => {
  const host = mockHost('fn entry() { send(req); }\nfn receive() {}');
  const previousIdData = new ReadingGraph().snapshot();
  host.saved.set('sourceReadingGraph.state.v1', previousIdData);
  const extension = loadExtension(host);

  await extension.activate(host.context);
  const run = (command, ...args) => host.handlers.get(`flowlinks.${command}`)(...args);
  await run('addNode');
  assert.match(host.informationMessages.at(-1), /Create a group before adding a node/);
  assert.equal(host.saved.has('flowlinks.state.v1'), false);
  host.infoReplies.push('Create Group');
  host.prompts.push('Request path');
  cursor(host.editor, 'entry(');
  await run('addNode');
  cursor(host.editor, 'send(');
  await run('addNode');
  host.prompts.push('Worker path');
  await run('createGroup');
  cursor(host.editor, 'receive(');
  await run('addNode');

  const snapshot = () => host.saved.get('flowlinks.state.v1');
  let graph = new ReadingGraph(snapshot());
  assert.deepEqual(graph.nodes().map(node => node.name), ['entry', 'send', 'receive']);
  assert.deepEqual(graph.groups().map(group => group.name), ['Request path', 'Worker path']);
  assert.equal(graph.data.activeGroupId, graph.groups()[1].id);
  assert.equal(host.editor.marks.length, 3);

  const provider = host.mock.treeView.options.treeDataProvider;
  const requestGroup = graph.groups()[0];
  const workerGroup = graph.groups()[1];
  const entry = graph.nodes().find(node => node.name === 'entry');
  const send = graph.nodes().find(node => node.name === 'send');
  const receive = graph.nodes().find(node => node.name === 'receive');
  assert.equal(provider.getTreeItem(provider.groupElement(requestGroup.id)).label, 'Request path');
  host.prompts.push('API request');
  await run('renameGroup', provider.groupElement(requestGroup.id));
  host.prompts.push('send_async');
  await run('editNodeName', provider.nodeElement(send.id));
  const transfer = new Map();
  provider.handleDrag([provider.nodeElement(send.id)], transfer);
  const beforeDrag = host.reveals.length;
  await provider.handleDrop(provider.nodeElement(entry.id), transfer);
  assert.ok(host.reveals.slice(beforeDrag).some(row => row.element.nodeId === entry.id && row.details.expand === true));
  assert.ok(host.reveals.slice(beforeDrag).some(row => row.element.nodeId === send.id));

  host.prompts.push('first\\nsecond');
  await run('editNodeNote', provider.nodeElement(send.id));
  graph = new ReadingGraph(snapshot());
  assert.equal(graph.get(send.id).parentId, entry.id);
  assert.equal(graph.get(send.id).name, 'send_async');
  assert.equal(graph.getGroup(requestGroup.id).name, 'API request');
  assert.equal(graph.get(entry.id).name, 'entry');
  assert.equal(provider.getTreeItem(provider.groupElement(requestGroup.id)).label, 'API request');
  assert.equal(graph.get(send.id).note, 'first\nsecond');
  assert.equal(provider.getTreeItem(provider.nodeElement(send.id)).description, 'first second');

  host.prompts.push('JobReady');
  await run('addMessage', provider.nodeElement(send.id));
  graph = new ReadingGraph(snapshot());
  assert.equal(graph.get(send.id).messages[0].targetId, receive.id);
  assert.equal(graph.get(receive.id).groupId, workerGroup.id);
  const leaf = provider.getChildren(provider.nodeElement(send.id))[0];
  const command = provider.getTreeItem(leaf).command;
  await run('revealReceiver', ...command.arguments);
  assert.equal(host.reveals.at(-1).element.nodeId, receive.id);
  await run('jumpToNode', receive.id);
  assert.equal(host.editor.selection.start.line, 1);

  await run('expandAll');
  assert.ok(host.reveals.some(row => row.element.kind === 'group' && row.details.expand === true));
  assert.ok(host.reveals.some(row => row.element.nodeId === entry.id && row.details.expand === true));
  host.quickPickReplies.push('API request');
  await run('selectGroup');
  assert.equal(provider.graph.data.activeGroupId, requestGroup.id);
  cursor(host.editor, 'receive(');
  await run('addNode');
  graph = new ReadingGraph(snapshot());
  assert.equal(graph.nodes().length, 4);
  assert.equal(graph.nodesForUri(receive.uri).filter(node => node.line === receive.line).length, 2);
  assert.ok(graph.nodes().some(node => node.groupId === requestGroup.id && node.id !== entry.id && node.id !== send.id));
  assert.equal(host.editor.marks.length, 4);

  host.document.text = 'fn receive() {}';
  host.callbacks.edit({
    document: host.document,
    contentChanges: [{ range: { start: new Position(0, 0), end: new Position(1, 0) }, text: '' }],
  });
  graph = provider.graph;
  assert.equal(graph.get(send.id).line, 0);
  assert.equal(graph.get(send.id).note, 'first\nsecond');
  assert.equal(graph.get(send.id).messages.length, 1);

  await run('deleteNode');
  graph = new ReadingGraph(snapshot());
  assert.equal(graph.get(receive.id), undefined);
  assert.equal(graph.get(send.id).parentId, entry.id);
  assert.equal(graph.get(send.id).note, 'first\nsecond');
  assert.deepEqual(graph.get(send.id).messages, []);
  host.confirmations.push(undefined);
  await run('clearWorkspaceData');
  assert.equal(new ReadingGraph(snapshot()).nodes().length, 3);
  const update = host.context.workspaceState.update;
  host.context.workspaceState.update = async (key, value) => {
    if (value === undefined) throw new Error('storage unavailable');
    return update(key, value);
  };
  host.confirmations.push('Delete All');
  await run('clearWorkspaceData');
  assert.equal(new ReadingGraph(snapshot()).nodes().length, 3);
  assert.equal(provider.getChildren().length, 2);
  assert.equal(host.editor.marks.length, 3);
  assert.match(host.errors.at(-1), /storage unavailable/);
  host.context.workspaceState.update = update;
  host.confirmations.push('Delete All');
  await run('clearWorkspaceData');
  assert.equal(host.saved.has('flowlinks.state.v1'), false);
  assert.deepEqual(host.saved.get('sourceReadingGraph.state.v1'), previousIdData);
  assert.deepEqual(provider.getChildren(), []);
  assert.equal(host.editor.marks.length, 0);
  host.prompts.push('Fresh group');
  await run('createGroup');
  cursor(host.editor, 'receive(');
  await run('addNode');
  assert.equal(new ReadingGraph(snapshot()).nodes().length, 1);
  assert.equal(host.editor.marks.length, 1);
  assert.equal(host.errors.length, 1);
  await extension.deactivate();
});

test('separate VS Code environments share, migrate, and refresh one workspace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowlinks-extension-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = mockHost('fn entry() {}', root);
  const original = new ReadingGraph();
  original.addGroup('Migrated');
  first.saved.set('flowlinks.state.v1', original.snapshot());
  const extensionA = loadExtension(first);
  await extensionA.activate(first.context);
  const file = path.join(root, '.vscode', 'flowlinks.json');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).format, 'flowlinks-workspace-v1');
  cursor(first.editor, 'entry(');
  await first.handlers.get('flowlinks.addNode')();

  const second = mockHost('fn entry() {}', root);
  const extensionB = loadExtension(second);
  await extensionB.activate(second.context);
  const provider = second.mock.treeView.options.treeDataProvider;
  assert.equal(provider.graph.nodes().length, 1);
  assert.equal(provider.graph.groups()[0].name, 'Migrated');

  first.prompts.push('Shared');
  await first.handlers.get('flowlinks.createGroup')();
  second.callbacks.file();
  for (let i = 0; i < 100 && provider.graph.groups().length !== 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(provider.graph.groups().map(group => group.name), ['Migrated', 'Shared']);
  cursor(second.editor, 'entry(');
  await second.handlers.get('flowlinks.addNode')();
  const sharedStore = new WorkspaceStore(second.mock, second.mock.workspace.workspaceFolders[0]);
  assert.equal(new ReadingGraph(await sharedStore.load()).nodes().length, 2);

  second.confirmations.push('Delete All');
  await second.handlers.get('flowlinks.clearWorkspaceData')();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).graph.groupOrder.length, 0);
  await extensionA.deactivate();
  await extensionB.deactivate();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
});

test('a delayed edit from another window becomes the last shared write', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowlinks-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = mockHost('fn entry() {}', root);
  const extensionA = loadExtension(first);
  await extensionA.activate(first.context);
  first.prompts.push('Base');
  await first.handlers.get('flowlinks.createGroup')();

  const second = mockHost('fn entry() {}', root);
  const extensionB = loadExtension(second);
  await extensionB.activate(second.context);
  let answer;
  let prompted;
  const waiting = new Promise(resolve => { prompted = resolve; });
  second.mock.window.showInputBox = async () => {
    prompted();
    return new Promise(resolve => { answer = resolve; });
  };
  const pending = second.handlers.get('flowlinks.createGroup')();
  await waiting;
  first.prompts.push('Newer');
  await first.handlers.get('flowlinks.createGroup')();
  answer('Stale');
  await pending;

  const shared = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'flowlinks.json'), 'utf8'));
  assert.deepEqual(shared.graph.groupOrder.map(id => shared.graph.groups[id].name), ['Base', 'Stale']);
  assert.deepEqual(second.mock.treeView.options.treeDataProvider.graph.groups().map(group => group.name), ['Base', 'Stale']);
  first.callbacks.file();
  const provider = first.mock.treeView.options.treeDataProvider;
  for (let i = 0; i < 100 && provider.graph.groups().at(-1).name !== 'Stale'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(provider.graph.groups().map(group => group.name), ['Base', 'Stale']);
  const backups = (await fs.readdir(path.join(root, '.vscode'))).filter(name => name.startsWith('flowlinks.conflict-'));
  assert.equal(backups.length, 0);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
  await extensionA.deactivate();
  await extensionB.deactivate();
});

test('an environment with separate old data backs it up before using the shared file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowlinks-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = mockHost('fn entry() {}', root);
  const extensionA = loadExtension(first);
  await extensionA.activate(first.context);
  first.prompts.push('Shared');
  await first.handlers.get('flowlinks.createGroup')();

  const second = mockHost('fn entry() {}', root);
  const original = new ReadingGraph();
  original.addGroup('Old environment');
  second.saved.set('flowlinks.state.v1', original.snapshot());
  const extensionB = loadExtension(second);
  await extensionB.activate(second.context);
  const provider = second.mock.treeView.options.treeDataProvider;
  assert.deepEqual(provider.graph.groups().map(group => group.name), ['Shared']);
  assert.equal(second.saved.has('flowlinks.state.v1'), false);
  const backups = (await fs.readdir(path.join(root, '.vscode'))).filter(name => name.startsWith('flowlinks.legacy-'));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(await fs.readFile(path.join(root, '.vscode', backups[0]), 'utf8'));
  assert.equal(backup.graph.groups[backup.graph.groupOrder[0]].name, 'Old environment');
  await extensionA.deactivate();
  await extensionB.deactivate();
});

test('activation upgrades legacy group titles and flushes them on deactivate', async () => {
  const host = mockHost('fn entry() {}');
  const graph = new ReadingGraph();
  const group = graph.addGroup('Temporary');
  const root = graph.addNode({ uri: host.document.uri.toString(), line: 0, character: 3, name: 'entry', groupId: group.id }).node;
  const legacy = { version: 1, nodes: graph.snapshot().nodes, roots: [root.id] };
  legacy.nodes[root.id].parentId = null;
  delete legacy.nodes[root.id].groupId;
  legacy.nodes[root.id].flowLabel = 'Request path';
  host.saved.set('flowlinks.state.v1', legacy);
  const extension = loadExtension(host);

  await extension.activate(host.context);
  const provider = host.mock.treeView.options.treeDataProvider;
  const rootGroup = provider.getChildren()[0];
  assert.equal(provider.getTreeItem(rootGroup).label, 'Request path');
  assert.equal(provider.getChildren(rootGroup)[0].nodeId, root.id);
  await extension.deactivate();
  assert.equal(host.saved.get('flowlinks.state.v1').version, 2);
  assert.equal(host.saved.get('flowlinks.state.v1').nodes[root.id].name, 'entry');
  assert.equal(Object.hasOwn(host.saved.get('flowlinks.state.v1').nodes[root.id], 'flowLabel'), false);
});

test('deleting a group confirms first, then clears bookmarks and cross-group messages', async () => {
  const host = mockHost('fn entry() {}\nfn receive() {}');
  const extension = loadExtension(host);
  await extension.activate(host.context);
  const run = (command, ...args) => host.handlers.get(`flowlinks.${command}`)(...args);
  host.prompts.push('First');
  await run('createGroup');
  cursor(host.editor, 'entry(');
  await run('addNode');
  host.prompts.push('Second');
  await run('createGroup');
  cursor(host.editor, 'receive(');
  await run('addNode');
  const provider = host.mock.treeView.options.treeDataProvider;
  let graph = new ReadingGraph(host.saved.get('flowlinks.state.v1'));
  const [first, second] = graph.groups();
  const [sender, receiver] = graph.nodes();
  host.prompts.push('Ready');
  await run('addMessage', provider.nodeElement(sender.id));

  host.confirmations.push(undefined);
  await run('deleteGroup', provider.groupElement(second.id));
  assert.equal(provider.graph.nodes().length, 2);
  assert.equal(host.editor.marks.length, 2);
  host.confirmations.push('Delete Group');
  await run('deleteGroup', provider.groupElement(second.id));
  graph = new ReadingGraph(host.saved.get('flowlinks.state.v1'));
  assert.equal(graph.get(receiver.id), undefined);
  assert.equal(graph.get(sender.id).messages.length, 0);
  assert.deepEqual(graph.groups().map(group => group.id), [first.id]);
  assert.equal(graph.data.activeGroupId, first.id);
  assert.equal(host.editor.marks.length, 1);
  cursor(host.editor, 'receive(');
  await run('addNode', provider.groupElement(first.id));
  assert.equal(provider.graph.nodes().length, 2);
  assert.ok(provider.graph.nodes().every(node => node.groupId === first.id));
  assert.deepEqual(host.errors, []);
  await extension.deactivate();
});

test('expand all yields to cancellation on a deep tree', async () => {
  const host = mockHost('fn entry() {}');
  const graph = new ReadingGraph();
  const group = graph.addGroup('Deep');
  let parentId = group.id;
  for (let i = 0; i < 100; i++) {
    const node = graph.addNode({ uri: host.document.uri.toString(), line: i, character: 0, name: `step${i}`, groupId: group.id }).node;
    if (i > 0) graph.moveOnto(node.id, parentId);
    parentId = node.id;
  }
  host.saved.set('flowlinks.state.v1', graph.snapshot());
  const extension = loadExtension(host);
  await extension.activate(host.context);
  host.progressControl.cancelAfter = host.reveals.length + 10;
  await host.handlers.get('flowlinks.expandAll')();
  assert.equal(host.progressControl.started, 1);
  assert.ok(host.reveals.length <= host.progressControl.cancelAfter);
  assert.ok(host.reveals.some(row => row.details.expand === true));
  assert.deepEqual(host.errors, []);
  await extension.deactivate();
});

test('sibling arrows reorder without reparenting while drag expands the new parent', async () => {
  const host = mockHost('fn a() {}\nfn b() {}');
  const extension = loadExtension(host);
  await extension.activate(host.context);
  const run = (command, ...args) => host.handlers.get(`flowlinks.${command}`)(...args);
  host.prompts.push('Path');
  await run('createGroup');
  cursor(host.editor, 'a(');
  await run('addNode');
  cursor(host.editor, 'b(');
  await run('addNode');
  const provider = host.mock.treeView.options.treeDataProvider;
  const [a, b] = provider.graph.nodes();
  assert.equal(provider.getTreeItem(provider.nodeElement(a.id)).collapsibleState, host.mock.TreeItemCollapsibleState.None);
  assert.equal(host.expanded.has(`node:${a.id}`), false);

  await run('moveDown', provider.nodeElement(a.id));
  assert.deepEqual(provider.graph.getGroup(a.groupId).children, [b.id, a.id]);
  assert.equal(provider.graph.get(a.id).parentId, a.groupId);
  assert.equal(provider.graph.get(b.id).parentId, b.groupId);
  await run('moveUp', provider.nodeElement(a.id));
  assert.deepEqual(provider.graph.getGroup(a.groupId).children, [a.id, b.id]);

  const transfer = new Map();
  provider.handleDrag([provider.nodeElement(b.id)], transfer);
  const beforeDrag = host.reveals.length;
  await provider.handleDrop(provider.nodeElement(a.id), transfer);
  assert.equal(provider.graph.get(b.id).parentId, a.id);
  assert.equal(provider.getTreeItem(provider.nodeElement(a.id)).collapsibleState, host.mock.TreeItemCollapsibleState.Collapsed);
  assert.equal(host.expanded.has(`node:${a.id}`), true, 'a newly reparented node must remain visible');
  assert.ok(host.reveals.slice(beforeDrag).some(row => row.element.nodeId === a.id && row.details.expand === true));
  assert.ok(host.reveals.slice(beforeDrag).some(row => row.element.nodeId === b.id));
  await extension.deactivate();
});

test('deleting a message row removes only that link and preserves both bookmarks', async () => {
  const graph = new ReadingGraph();
  const group = graph.addGroup('Path');
  const [a, b, c] = ['a', 'b', 'c'].map((name, line) => graph.addNode({
    uri: 'file:///test/main.rs', line, character: 0, name, groupId: group.id,
  }).node);
  graph.moveOnto(b.id, a.id);
  graph.setNote(b.id, 'important');
  const first = graph.addMessage(b.id, c.id, 'Ready').message;
  const second = graph.addMessage(b.id, c.id, 'Retry').message;
  const host = mockHost('a\nb\nc');
  host.saved.set('flowlinks.state.v1', graph.snapshot());
  const extension = loadExtension(host);
  await extension.activate(host.context);
  const provider = host.mock.treeView.options.treeDataProvider;
  const row = provider.getChildren(provider.nodeElement(b.id))[0];
  assert.equal(provider.getTreeItem(row).contextValue, 'graphMessage');
  assert.equal(row.messageId, first.id);
  await host.handlers.get('flowlinks.deleteMessage')(row);

  const saved = new ReadingGraph(host.saved.get('flowlinks.state.v1'));
  assert.deepEqual(saved.getGroup(group.id).children, [a.id, c.id]);
  assert.deepEqual(saved.get(a.id).children, [b.id]);
  assert.equal(saved.get(b.id).parentId, a.id);
  assert.ok(saved.get(c.id));
  assert.equal(saved.get(b.id).note, 'important');
  assert.deepEqual(saved.get(b.id).messages, [second]);
  assert.deepEqual(provider.getChildren(provider.nodeElement(b.id)).filter(item => item.kind === 'message').map(item => item.messageId), [second.id]);
  saved.validate();
  await extension.deactivate();
});
