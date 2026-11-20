const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReadingGraph } = require('../src/graph');
const { GraphTreeProvider } = require('../src/tree');

class EventEmitter {
  constructor() { this.event = () => {}; }
  fire() {}
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class DataTransferItem {
  constructor(value) { this.value = value; }
}

class MarkdownString {
  constructor() { this.value = ''; this.text = []; }
  appendMarkdown(value) { this.value += value; return this; }
  appendText(value) { this.text.push(value); this.value += value; return this; }
}

const vscode = {
  EventEmitter,
  TreeItem,
  MarkdownString,
  DataTransferItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(name) { this.name = name; } },
  Uri: { parse: uri => ({ fsPath: new URL(uri).pathname }) },
  workspace: { asRelativePath: uri => `project/${uri.fsPath.split('/').at(-1)}` },
  window: { showWarningMessage: async () => undefined },
};

function node(graph, name, line, groupId = graph.data.activeGroupId || graph.addGroup('Request path').id) {
  return graph.addNode({ uri: 'file:///code/x.rs', line, character: 0, name, groupId }).node;
}

test('groups own source nodes, calls and message links without a source bookmark of their own', () => {
  const graph = new ReadingGraph();
  const group = graph.addGroup('Request path');
  const root = node(graph, 'entry', 0);
  const child = node(graph, 'send', 1);
  const receiver = node(graph, 'receive', 2);
  graph.setNote(child.id, 'first line\nsecond line');
  graph.setNote(root.id, 'overview');
  graph.moveOnto(child.id, root.id);
  graph.addMessage(child.id, receiver.id, 'JobReady');
  const provider = new GraphTreeProvider(vscode, graph, () => {});

  const roots = provider.getChildren();
  assert.deepEqual(roots.map(row => row.groupId), [group.id]);
  assert.equal(provider.getTreeItem(roots[0]).label, 'Request path');
  assert.equal(provider.getTreeItem(roots[0]).iconPath.name, 'folder-opened');
  assert.equal(provider.getTreeItem(roots[0]).command, undefined);
  const entryElement = provider.getChildren(roots[0])[0];
  const childElement = provider.getChildren(entryElement)[0];
  assert.equal(provider.getParent(childElement).nodeId, root.id);
  assert.equal(provider.getParent(entryElement).groupId, group.id);
  assert.equal(provider.getTreeItem(childElement).label, 'send');
  assert.equal(provider.getTreeItem(childElement).iconPath.name, 'circle-filled');
  assert.ok(provider.getTreeItem(childElement).tooltip instanceof MarkdownString);
  assert.deepEqual(provider.getTreeItem(childElement).tooltip.text,
    ['send', 'project/x.rs:2:1', 'first line\nsecond line']);
  assert.equal(provider.getTreeItem(childElement).description, undefined);
  assert.deepEqual(provider.getTreeItem(entryElement).tooltip.text,
    ['entry', 'project/x.rs:1:1', 'overview']);
  assert.match(provider.getTreeItem(entryElement).tooltip.value, /\*\*Note\*\*/);
  const reference = provider.getChildren(childElement)[0];
  assert.equal(provider.getTreeItem(reference).label, 'receive: JobReady');
  assert.equal(provider.getTreeItem(reference).iconPath.name, 'link');
  assert.deepEqual(provider.getTreeItem(reference).tooltip.text,
    ['send', 'receive', 'project/x.rs:3:1', 'JobReady']);
  assert.deepEqual(provider.getTreeItem(reference).command.arguments, [receiver.id]);
  assert.deepEqual(provider.getChildren(reference), []);
  assert.doesNotMatch(provider.getTreeItem(entryElement).contextValue, /canMoveUp/);
  assert.match(provider.getTreeItem(roots[0]).contextValue, /graphGroup/);
  assert.match(provider.getTreeItem(childElement).contextValue, /canMoveUp/);
  graph.moveUp(child.id);
  assert.equal(provider.getTreeItem(childElement).label, 'send');
  assert.equal(provider.getParent(childElement).groupId, group.id);
});

test('rendering a large sibling list does not search siblings for every row', () => {
  const graph = new ReadingGraph();
  graph.addGroup('Main');
  const roots = Array.from({ length: 250 }, (_, line) => node(graph, `entry${line}`, line));
  const provider = new GraphTreeProvider(vscode, graph, () => {});
  graph.siblings = () => { throw new Error('repeated linear sibling lookup during rendering'); };
  for (const root of roots) provider.getTreeItem(provider.nodeElement(root.id));
});

test('a nested node with a preceding sibling exposes both move directions', () => {
  const graph = new ReadingGraph();
  graph.addGroup('Main');
  const parent = node(graph, 'parent', 0);
  const first = node(graph, 'first', 1);
  const second = node(graph, 'second', 2);
  graph.moveOnto(first.id, parent.id);
  graph.moveOnto(second.id, parent.id);
  const provider = new GraphTreeProvider(vscode, graph, () => {});
  const context = provider.getTreeItem(provider.nodeElement(second.id)).contextValue;
  assert.match(context, /canMoveUp/);
  assert.match(context, /canMoveDown/);
  assert.doesNotMatch(provider.getTreeItem(provider.nodeElement(parent.id)).contextValue, /canMoveUp/);
});

test('dragging onto a node or group changes ownership, but message rows reject drops', async () => {
  const graph = new ReadingGraph();
  const first = graph.addGroup('First');
  const sender = node(graph, 'sender', 0);
  const target = node(graph, 'target', 1);
  const second = graph.addGroup('Second');
  graph.addMessage(sender.id, target.id, 'ready');
  let saves = 0;
  const provider = new GraphTreeProvider(vscode, graph, async () => { saves++; });
  const transfer = new Map();
  provider.handleDrag([provider.nodeElement(target.id)], transfer);
  await provider.handleDrop(provider.nodeElement(sender.id), transfer);
  assert.equal(graph.get(target.id).parentId, sender.id);
  assert.equal(saves, 1);
  const reference = provider.getChildren(provider.nodeElement(sender.id))[1];
  await provider.handleDrop(reference, transfer);
  assert.equal(saves, 1);
  await provider.handleDrop(provider.nodeElement(target.id), transfer);
  assert.equal(saves, 1);
  await provider.handleDrop(provider.groupElement(second.id), transfer);
  assert.equal(graph.get(target.id).groupId, second.id);
  assert.equal(graph.data.activeGroupId, second.id);
  assert.equal(saves, 2);
  assert.equal(provider.getTreeItem(provider.groupElement(first.id)).iconPath.name, 'folder');
});
