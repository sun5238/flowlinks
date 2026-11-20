const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReadingGraph } = require('../src/graph');
const { trackDocumentChanges } = require('../src/anchor');
const { encodeNote, decodeNote } = require('../src/note-text');

function add(graph, name, line = 0, character = 0, groupId = graph.data.activeGroupId || graph.addGroup('Main').id) {
  return graph.addNode({ uri: 'file:///code/main.rs', line, character, name, groupId }).node;
}

function mockDocument(lines) {
  return { lineCount: lines.length, lineAt: index => ({ text: lines[index] }) };
}

test('roots, promotion, demotion and drag change only call parents', () => {
  const graph = new ReadingGraph();
  const a = add(graph, 'a', 0);
  const b = add(graph, 'b', 1);
  const c = add(graph, 'c', 2);
  graph.setNote(b.id, 'reader note');
  graph.moveOnto(b.id, a.id);
  graph.moveOnto(c.id, b.id);
  assert.deepEqual(graph.get(a.id).children, [b.id]);
  assert.equal(graph.moveUp(c.id), true);
  assert.deepEqual(graph.get(a.id).children, [b.id, c.id]);
  assert.equal(graph.moveDown(c.id), true);
  assert.deepEqual(graph.get(b.id).children, [c.id]);
  assert.equal(graph.get(b.id).note, 'reader note');
  assert.throws(() => graph.moveOnto(a.id, c.id), /descendant/);
  graph.validate();
});

test('promoting a direct child of a root places it after the old parent', () => {
  const graph = new ReadingGraph();
  const a = add(graph, 'a', 0);
  const b = add(graph, 'b', 1);
  const c = add(graph, 'c', 2);
  graph.moveOnto(c.id, a.id);
  graph.moveUp(c.id);
  assert.deepEqual(graph.getGroup(a.groupId).children, [a.id, c.id, b.id]);
});

test('parallel messages, rename and deletion preserve other bookmarks', () => {
  const graph = new ReadingGraph();
  const a = add(graph, 'sender', 0);
  const b = add(graph, 'receiver', 1);
  const c = add(graph, 'child', 2);
  graph.moveOnto(c.id, b.id);
  const first = graph.addMessage(a.id, b.id, 'Ready');
  graph.addMessage(a.id, b.id, 'Retry');
  assert.equal(graph.addMessage(a.id, b.id, 'Ready').added, false);
  graph.renameNode(b.id, 'renamed');
  assert.equal(graph.get(a.id).messages[0].targetId, b.id);
  assert.throws(() => graph.editMessage(a.id, first.message.id, 'Retry'), /already exists/);
  graph.deleteNode(b.id);
  assert.equal(graph.get(b.id), undefined);
  assert.equal(graph.get(c.id).parentId, b.groupId);
  assert.deepEqual(graph.get(a.id).messages, []);
  graph.validate();
});

test('deleting a nested node promotes its children without deleting the group', () => {
  const graph = new ReadingGraph();
  const parent = add(graph, 'parent', 0);
  const middle = add(graph, 'middle', 1);
  const child = add(graph, 'child', 2);
  graph.moveOnto(middle.id, parent.id);
  graph.moveOnto(child.id, middle.id);
  graph.deleteNode(middle.id);
  assert.equal(graph.get(child.id).parentId, parent.id);
  assert.deepEqual(graph.get(parent.id).children, [child.id]);
  assert.ok(graph.getGroup(parent.groupId));
  graph.validate();
});

test('location names are unique but stable under edits and manual renames', () => {
  const graph = new ReadingGraph();
  const a = add(graph, 'send()', 0);
  const b = add(graph, 'send()', 1);
  assert.notEqual(a.name, b.name);
  assert.equal(graph.addNode({ uri: a.uri, line: 0, character: 0, name: 'other', groupId: a.groupId }).added, false);
  assert.throws(() => graph.renameNode(b.id, a.name), /already/);
  graph.updatePosition(a.id, { line: 6, character: 0 }, { line: 6, character: 0 });
  assert.equal(graph.get(a.id).name, 'send()');
  assert.deepEqual(new ReadingGraph(graph.snapshot()).snapshot(), graph.snapshot());
});

test('long colliding names keep their numeric suffixes visible', () => {
  const graph = new ReadingGraph();
  const names = [0, 1, 2].map(character => add(graph, 'very_long_name_'.repeat(7), 0, character).name);
  assert.equal(new Set(names).size, 3);
  assert.match(names[2], /#2$/);
  assert.ok(names.every(name => name.length <= 72));
});

test('location and name indexes stay correct on rename, deletion and restoration', () => {
  const graph = new ReadingGraph();
  const one = add(graph, 'send', 1);
  const two = add(graph, 'receive', 2);
  assert.deepEqual(graph.nodesForUri(one.uri).map(node => node.id), [one.id, two.id]);
  assert.equal(graph.hasNodesInUri('file:///other.rs'), false);
  graph.renameNode(one.id, 'dispatch');
  graph.deleteNode(two.id);
  assert.deepEqual(graph.nodesForUri(one.uri).map(node => node.id), [one.id]);
  graph.deleteNode(one.id);
  assert.equal(graph.hasNodesInUri(one.uri), false);
  assert.equal(add(graph, 'send', 3).name, 'send');
  const restored = new ReadingGraph(graph.snapshot());
  assert.equal(restored.hasNodesInUri(one.uri), true);
});

test('groups are explicit roots, independent of source nodes', () => {
  const graph = new ReadingGraph();
  assert.throws(() => add(graph, 'dispatch', 0, 0, 'missing'), /Group/);
  const group = graph.addGroup('Request path');
  const root = add(graph, 'dispatch', 0);
  graph.setNote(root.id, 'human explanation');
  assert.equal(graph.get(root.id).parentId, group.id);
  assert.equal(graph.moveUp(root.id), false);
  graph.renameGroup(group.id, 'Worker path');
  assert.equal(graph.get(root.id).name, 'dispatch');
  assert.equal(new ReadingGraph(graph.snapshot()).getGroup(group.id).name, 'Worker path');
  assert.equal(graph.get(root.id).note, 'human explanation');
});

test('legacy roots become groups without losing bookmarks, notes, links or labels', () => {
  const graph = new ReadingGraph();
  const root = add(graph, 'entry', 0);
  const taken = add(graph, 'Request path', 1);
  const child = add(graph, 'send', 2);
  graph.moveOnto(child.id, root.id);
  graph.addMessage(child.id, taken.id, 'Ready');
  graph.setNote(root.id, 'reader note');
  const legacy = { version: 1, nodes: graph.snapshot().nodes, roots: [root.id, taken.id] };
  for (const node of Object.values(legacy.nodes)) delete node.groupId;
  legacy.nodes[root.id].parentId = null;
  legacy.nodes[taken.id].parentId = null;
  legacy.nodes[root.id].flowLabel = 'Request path';
  legacy.nodes[child.id].flowLabel = 'Request path';
  legacy.nodes[taken.id].flowLabel = '';

  const restored = new ReadingGraph(legacy);
  assert.equal(restored.migrated, true);
  assert.equal(restored.groups().length, 2);
  assert.equal(restored.groups()[0].name, 'Request path');
  assert.equal(restored.groups()[1].name, 'Request path (2)');
  assert.deepEqual(restored.groups()[0].children, [root.id]);
  assert.equal(restored.get(root.id).name, 'entry');
  assert.equal(restored.get(taken.id).name, 'Request path');
  assert.equal(restored.get(root.id).note, 'reader note');
  assert.deepEqual(restored.get(root.id).children, [child.id]);
  assert.equal(restored.get(child.id).name, 'Request path (main.rs:3)');
  assert.equal(restored.get(child.id).messages[0].targetId, taken.id);
  assert.ok(restored.nodes().every(node => !Object.hasOwn(node, 'flowLabel')));
  assert.equal(new ReadingGraph(restored.snapshot()).migrated, false);
  restored.validate();
});

test('same source bookmark can belong to two groups and moving it updates its whole subtree', () => {
  const graph = new ReadingGraph();
  const first = graph.addGroup('First');
  const a = add(graph, 'send', 2, 0, first.id);
  const child = add(graph, 'child', 3);
  graph.moveOnto(child.id, a.id);
  const second = graph.addGroup('Second');
  const b = add(graph, 'send', 2, 0, second.id);
  assert.notEqual(a.id, b.id);
  assert.equal(graph.findAt(a.uri, 2, 0, first.id).id, a.id);
  assert.equal(graph.findAt(a.uri, 2, 0, second.id).id, b.id);
  assert.throws(() => graph.moveOnto(a.id, second.id), /already bookmarked/);
  assert.equal(graph.get(a.id).groupId, first.id);
  graph.deleteNode(b.id);
  graph.moveOnto(a.id, second.id);
  assert.equal(graph.get(a.id).groupId, second.id);
  assert.equal(graph.get(child.id).groupId, second.id);
  assert.equal(graph.get(a.id).parentId, second.id);
  graph.validate();
});

test('deleting a group removes its full subtree and all incoming message links', () => {
  const graph = new ReadingGraph();
  const first = graph.addGroup('First');
  const sender = add(graph, 'sender', 0);
  graph.setNote(sender.id, 'first note');
  const child = add(graph, 'child', 1);
  graph.moveOnto(child.id, sender.id);
  const second = graph.addGroup('Second');
  const receiver = add(graph, 'receiver', 2);
  graph.addMessage(receiver.id, child.id, 'FromSecond');
  graph.addMessage(sender.id, receiver.id, 'ToSecond');
  graph.deleteGroup(first.id);
  assert.equal(graph.get(sender.id), undefined);
  assert.equal(graph.get(child.id), undefined);
  assert.equal(graph.hasNodesInUri(sender.uri), true);
  assert.deepEqual(graph.get(receiver.id).messages, []);
  assert.deepEqual(graph.groups().map(group => group.id), [second.id]);
  assert.equal(graph.data.activeGroupId, second.id);
  graph.deleteGroup(second.id);
  assert.deepEqual(graph.nodes(), []);
  assert.equal(graph.hasNodesInUri(sender.uri), false);
  assert.equal(graph.data.activeGroupId, null);
  graph.validate();
});

test('deep call hierarchy restores without recursive stack overflow', () => {
  const nodes = {};
  for (let i = 0; i < 8000; i++) {
    const id = `n${i}`;
    nodes[id] = {
      id, uri: 'file:///code/deep.rs', line: i, character: 0,
      endLine: i, endCharacter: 0, name: id, note: '',
      parentId: i === 0 ? null : `n${i - 1}`,
      children: i === 7999 ? [] : [`n${i + 1}`], messages: [],
    };
  }
  const graph = new ReadingGraph({ version: 1, nodes, roots: ['n0'] });
  assert.equal(graph.nodes().length, 8000);
  assert.equal(graph.get('n7999').parentId, 'n7998');
  assert.equal(graph.get('n0').parentId, graph.groups()[0].id);
  graph.deleteGroup(graph.groups()[0].id);
  assert.deepEqual(graph.nodes(), []);
  graph.validate();
});

test('tracking insertion, replacement and deletion keeps graph node and note', () => {
  const graph = new ReadingGraph();
  const node = add(graph, 'start()', 1, 2);
  graph.setNote(node.id, 'kept');
  trackDocumentChanges(graph, node.uri, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'new\n' }], mockDocument(['new', 'top', 'start()', 'bottom']));
  assert.equal(graph.get(node.id).line, 2);
  trackDocumentChanges(graph, node.uri, [{ range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } }, text: '' }], mockDocument(['new', 'top', 'bottom']));
  assert.equal(graph.get(node.id).line, 2);
  assert.equal(graph.get(node.id).note, 'kept');
});

test('multi-cursor changes use original document coordinates and keep character offsets', () => {
  const graph = new ReadingGraph();
  const node = add(graph, 'send', 2, 3);
  trackDocumentChanges(graph, node.uri, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x\n' },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, text: 'y\n' },
  ], mockDocument(['x', 'a', 'b', 'y', 'send(request)', 'd']));
  assert.equal(graph.get(node.id).line, 4);
  assert.equal(graph.get(node.id).character, 3);
  trackDocumentChanges(graph, node.uri, [
    { range: { start: { line: 4, character: 1 }, end: { line: 4, character: 1 } }, text: 'abc' },
  ], mockDocument(['x', 'a', 'b', 'y', 'sabcecnd(request)', 'd']));
  assert.equal(graph.get(node.id).character, 6);
});

test('typing in files without graph nodes needs no graph scan', () => {
  const graph = {
    hasNodesInUri: () => false,
    nodesForUri: () => { throw new Error('all nodes must not be scanned'); },
  };
  assert.equal(trackDocumentChanges(graph, 'file:///other.rs', [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x' },
  ], mockDocument(['x'])), false);
});

test('note escape round-trip leaves literal backslashes intact', () => {
  const note = 'first\nsecond\\n and \\t';
  assert.equal(decodeNote(encodeNote(note)), note);
  assert.equal(decodeNote('first\\nsecond'), 'first\nsecond');
  assert.equal(decodeNote('literal\\\\n'), 'literal\\n');
});
