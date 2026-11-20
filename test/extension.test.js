const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { ReadingGraph } = require('../src/graph');

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

function mockHost(source) {
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
  const uri = {
    scheme: 'file', fsPath: '/test/main.rs', path: '/test/main.rs',
    toString: () => 'file:///test/main.rs',
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
      file: fsPath => ({ fsPath, toString: () => `file://${fsPath}` }),
      parse: input => input === uri.toString() ? uri : { ...uri, toString: () => input },
    },
    workspace: {
      getWorkspaceFolder: () => ({}),
      asRelativePath: resource => resource.fsPath,
      openTextDocument: async () => document,
      onDidChangeTextDocument: listener => { callbacks.edit = listener; return { dispose() {} }; },
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
        assert.equal(options.modal, true);
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

test('move down keeps the new parent expanded so the moved node remains visible', async () => {
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

  const before = host.reveals.length;
  await run('moveDown', provider.nodeElement(b.id));
  assert.equal(provider.graph.get(b.id).parentId, a.id);
  assert.equal(provider.getTreeItem(provider.nodeElement(a.id)).collapsibleState, host.mock.TreeItemCollapsibleState.Collapsed);
  assert.equal(host.expanded.has(`node:${a.id}`), true, 'the moved node must stay visible in the new parent');
  assert.ok(host.reveals.slice(before).some(row => row.element.nodeId === b.id));
  const beforeUp = host.reveals.length;
  await run('moveUp', provider.nodeElement(b.id));
  assert.equal(provider.graph.get(b.id).parentId, provider.graph.get(a.id).groupId);
  assert.ok(host.reveals.slice(beforeUp).some(row => row.element.nodeId === b.id));
  await extension.deactivate();
});
