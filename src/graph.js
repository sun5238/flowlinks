const { randomUUID } = require('node:crypto');
const path = require('node:path');

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 72) || 'Bookmark';
}

function sourceContext(uri, line) {
  let file = uri;
  try {
    file = path.basename(new URL(uri).pathname);
  } catch {
    file = path.basename(uri);
  }
  return `${file}:${line + 1}`;
}

class ReadingGraph {
  constructor(saved) {
    this.data = saved === undefined
      ? { version: 2, nodes: {}, groups: {}, groupOrder: [], activeGroupId: null }
      : structuredClone(saved);
    this.migrated = this.data?.version === 1;
    if (this.migrated) {
      this.validateLegacy();
      this.migrateLegacy();
    }
    this.validate();
    this.byUri = new Map();
    this.nameKeys = new Set();
    for (const node of Object.values(this.data.nodes)) this.indexNode(node);
  }

  validateLegacy() {
    const { version, nodes, roots } = this.data || {};
    if (version !== 1 || !nodes || typeof nodes !== 'object' || !Array.isArray(roots)) {
      throw new Error('Unsupported or damaged reading graph');
    }

    const visited = new Set();
    const pending = roots.map(id => ({ id, parentId: null }));
    while (pending.length > 0) {
      const { id, parentId } = pending.pop();
      const node = nodes[id];
      if (!node || visited.has(id) || node.id !== id || node.parentId !== parentId ||
          typeof node.uri !== 'string' || typeof node.name !== 'string' ||
          !Array.isArray(node.children) || !Array.isArray(node.messages)) {
        throw new Error('Invalid reading graph hierarchy');
      }
      visited.add(id);
      for (const childId of node.children) pending.push({ id: childId, parentId: id });
    }
    if (visited.size !== Object.keys(nodes).length) throw new Error('Disconnected reading graph node');
    const names = new Set();
    for (const node of Object.values(nodes)) {
      const name = node.name.toLocaleLowerCase();
      if (names.has(name)) throw new Error('Duplicate reading graph node name');
      names.add(name);
      for (const message of node.messages) {
        if (!nodes[message.targetId]) throw new Error('Missing message receiver');
      }
    }
  }

  migrateLegacy() {
    const { nodes, roots } = this.data;
    const groups = {};
    const groupOrder = [];
    const groupNames = new Set();
    const nodeNames = new Set(Object.values(nodes).map(node => node.name.toLocaleLowerCase()));
    for (const rootId of roots) {
      const root = nodes[rootId];
      const base = normalizeName(typeof root.flowLabel === 'string' && root.flowLabel.trim() ? root.flowLabel : root.name);
      let name = base;
      for (let index = 2; groupNames.has(name.toLocaleLowerCase()); index++) {
        const suffix = ` (${index})`;
        name = `${base.slice(0, 72 - suffix.length)}${suffix}`;
      }
      groupNames.add(name.toLocaleLowerCase());
      const id = randomUUID();
      groups[id] = { id, name, children: [rootId] };
      groupOrder.push(id);
      root.parentId = id;
      const pending = [rootId];
      while (pending.length) {
        const node = nodes[pending.pop()];
        node.groupId = id;
        if (node.id !== rootId && typeof node.flowLabel === 'string' && node.flowLabel.trim()) {
          const proposed = normalizeName(node.flowLabel);
          nodeNames.delete(node.name.toLocaleLowerCase());
          let name = proposed;
          if (nodeNames.has(name.toLocaleLowerCase())) {
            const context = ` (${sourceContext(node.uri, node.line).slice(0, 32)})`;
            name = `${proposed.slice(0, 72 - context.length)}${context}`;
            for (let index = 2; nodeNames.has(name.toLocaleLowerCase()); index++) {
              const suffix = ` (${sourceContext(node.uri, node.line).slice(0, 24)}) #${index}`;
              name = `${proposed.slice(0, Math.max(1, 72 - suffix.length))}${suffix}`;
            }
          }
          node.name = name;
          nodeNames.add(name.toLocaleLowerCase());
        }
        delete node.flowLabel;
        pending.push(...node.children);
      }
    }
    this.data = { version: 2, nodes, groups, groupOrder, activeGroupId: groupOrder[0] || null };
  }

  validate() {
    const { version, nodes, groups, groupOrder, activeGroupId } = this.data || {};
    if (version !== 2 || !nodes || typeof nodes !== 'object' ||
        !groups || typeof groups !== 'object' || !Array.isArray(groupOrder) ||
        groupOrder.length !== Object.keys(groups).length ||
        (groupOrder.length === 0 ? activeGroupId !== null : !groups[activeGroupId])) {
      throw new Error('Unsupported or damaged FlowLinks data');
    }

    const visited = new Set();
    const groupNames = new Set();
    const pending = [];
    for (const id of groupOrder) {
      const group = groups[id];
      if (!group || group.id !== id || typeof group.name !== 'string' || !group.name.trim() ||
          !Array.isArray(group.children) || groupNames.has(group.name.toLocaleLowerCase())) {
        throw new Error('Invalid FlowLinks group');
      }
      groupNames.add(group.name.toLocaleLowerCase());
      for (const childId of group.children) pending.push({ id: childId, parentId: id, groupId: id });
    }
    while (pending.length) {
      const { id, parentId, groupId } = pending.pop();
      const node = nodes[id];
      if (!node || visited.has(id) || node.id !== id || node.parentId !== parentId || node.groupId !== groupId ||
          typeof node.uri !== 'string' || typeof node.name !== 'string' ||
          !Array.isArray(node.children) || !Array.isArray(node.messages)) {
        throw new Error('Invalid FlowLinks node hierarchy');
      }
      visited.add(id);
      for (const childId of node.children) pending.push({ id: childId, parentId: id, groupId });
    }
    if (visited.size !== Object.keys(nodes).length) throw new Error('Disconnected FlowLinks node');
    const names = new Set();
    for (const node of Object.values(nodes)) {
      const name = node.name.toLocaleLowerCase();
      if (names.has(name)) throw new Error('Duplicate FlowLinks node name');
      names.add(name);
      for (const message of node.messages) {
        if (!nodes[message.targetId]) throw new Error('Missing message receiver');
      }
    }
  }

  indexNode(node) {
    if (!this.byUri.has(node.uri)) this.byUri.set(node.uri, new Set());
    this.byUri.get(node.uri).add(node);
    this.nameKeys.add(node.name.toLocaleLowerCase());
  }

  nodesForUri(uri) {
    return this.byUri.has(uri) ? [...this.byUri.get(uri)] : [];
  }

  hasNodesInUri(uri) {
    return this.byUri.has(uri);
  }

  snapshot() {
    return structuredClone(this.data);
  }

  nodes() {
    return Object.values(this.data.nodes);
  }

  groups() {
    return this.data.groupOrder.map(id => this.data.groups[id]);
  }

  getGroup(id) {
    return this.data.groups[id];
  }

  requireGroup(id) {
    const group = this.getGroup(id);
    if (!group) throw new Error('Group no longer exists');
    return group;
  }

  addGroup(name) {
    const clean = normalizeName(name);
    if (!String(name).trim() || this.groups().some(group => group.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      throw new Error('A distinct group name is required');
    }
    const id = randomUUID();
    const group = { id, name: clean, children: [] };
    this.data.groups[id] = group;
    this.data.groupOrder.push(id);
    this.data.activeGroupId = id;
    return group;
  }

  renameGroup(id, name) {
    const group = this.requireGroup(id);
    const clean = normalizeName(name);
    if (!String(name).trim() || this.groups().some(other => other.id !== id && other.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      throw new Error('A distinct group name is required');
    }
    group.name = clean;
  }

  setActiveGroup(id) {
    this.requireGroup(id);
    if (this.data.activeGroupId === id) return false;
    this.data.activeGroupId = id;
    return true;
  }

  deleteGroup(id) {
    const group = this.requireGroup(id);
    const deleted = new Set();
    const pending = [...group.children];
    while (pending.length) {
      const nodeId = pending.pop();
      const node = this.requireNode(nodeId);
      deleted.add(nodeId);
      pending.push(...node.children);
      const indexed = this.byUri.get(node.uri);
      indexed.delete(node);
      if (indexed.size === 0) this.byUri.delete(node.uri);
      this.nameKeys.delete(node.name.toLocaleLowerCase());
      delete this.data.nodes[nodeId];
    }
    for (const node of this.nodes()) {
      node.messages = node.messages.filter(message => !deleted.has(message.targetId));
    }
    delete this.data.groups[id];
    this.data.groupOrder.splice(this.data.groupOrder.indexOf(id), 1);
    if (this.data.activeGroupId === id) this.data.activeGroupId = this.data.groupOrder.at(-1) || null;
  }

  get(id) {
    return this.data.nodes[id];
  }

  siblings(parentId) {
    return (this.getGroup(parentId) || this.requireNode(parentId)).children;
  }

  findAt(uri, line, character, groupId) {
    return this.nodesForUri(uri).find(node => node.groupId === groupId && node.line === line && node.character === character);
  }

  uniqueName(candidate, context, exceptId) {
    const used = value => {
      const name = value.toLocaleLowerCase();
      return this.nameKeys.has(name) && (!exceptId || this.get(exceptId)?.name.toLocaleLowerCase() !== name);
    };
    const base = normalizeName(candidate);
    if (!used(base)) return base;
    const suffix = ` (${normalizeName(context).slice(0, 32)})`;
    const withContext = `${base.slice(0, 72 - suffix.length)}${suffix}`;
    if (!used(withContext)) return withContext;
    for (let index = 2; ; index++) {
      const numbered = `${suffix} #${index}`;
      const next = `${base.slice(0, Math.max(1, 72 - numbered.length))}${numbered}`;
      if (!used(next)) return next;
    }
  }

  addNode({ uri, line, character, endLine = line, endCharacter = character, name, groupId }) {
    const group = this.requireGroup(groupId);
    const existing = this.findAt(uri, line, character, groupId);
    if (existing) return { node: existing, added: false };
    const id = randomUUID();
    const node = {
      id,
      uri,
      line,
      character,
      endLine,
      endCharacter,
      name: this.uniqueName(name, sourceContext(uri, line)),
      note: '',
      groupId,
      parentId: groupId,
      children: [],
      messages: [],
    };
    this.data.nodes[id] = node;
    group.children.push(id);
    this.indexNode(node);
    return { node, added: true };
  }

  renameNode(id, name) {
    const node = this.requireNode(id);
    const next = normalizeName(name);
    if (this.uniqueName(next, sourceContext(node.uri, node.line), id) !== next) {
      throw new Error('A node already has that name');
    }
    this.nameKeys.delete(node.name.toLocaleLowerCase());
    node.name = next;
    this.nameKeys.add(next.toLocaleLowerCase());
  }

  setNote(id, note) {
    this.requireNode(id).note = note;
  }

  updatePosition(id, start, end) {
    const node = this.requireNode(id);
    node.line = start.line;
    node.character = start.character;
    node.endLine = end.line;
    node.endCharacter = end.character;
  }

  requireNode(id) {
    const node = this.get(id);
    if (!node) throw new Error('Node no longer exists');
    return node;
  }

  detach(id) {
    const node = this.requireNode(id);
    const siblings = this.siblings(node.parentId);
    const index = siblings.indexOf(id);
    if (index < 0) throw new Error('Node is missing from its parent');
    siblings.splice(index, 1);
    node.parentId = null;
    return index;
  }

  moveOnto(id, parentId) {
    const node = this.requireNode(id);
    const parent = this.get(parentId);
    const group = this.getGroup(parentId);
    if (!parent && !group) throw new Error('Drop onto a node or group');
    if (node.parentId === parentId) return false;
    for (let cursor = parent; cursor; cursor = this.get(cursor.parentId)) {
      if (cursor.id === id) throw new Error('Cannot move a node beneath itself or its descendant');
    }
    const targetGroupId = group ? group.id : parent.groupId;
    if (node.groupId !== targetGroupId) {
      const occupied = new Set(this.nodes()
        .filter(entry => entry.groupId === targetGroupId)
        .map(entry => JSON.stringify([entry.uri, entry.line, entry.character])));
      const pending = [id];
      while (pending.length) {
        const current = this.requireNode(pending.pop());
        if (occupied.has(JSON.stringify([current.uri, current.line, current.character]))) {
          throw new Error('This location is already bookmarked in the target group');
        }
        pending.push(...current.children);
      }
    }
    this.detach(id);
    node.parentId = parentId;
    (parent || group).children.push(id);
    if (node.groupId !== targetGroupId) {
      const pending = [id];
      while (pending.length) {
        const current = this.requireNode(pending.pop());
        current.groupId = targetGroupId;
        pending.push(...current.children);
      }
    }
    return true;
  }

  moveUp(id) {
    const node = this.requireNode(id);
    const parent = this.get(node.parentId);
    if (!parent) return false;
    this.detach(id);
    node.parentId = parent.parentId;
    const siblings = this.siblings(parent.parentId);
    siblings.splice(siblings.indexOf(parent.id) + 1, 0, id);
    return true;
  }

  moveDown(id) {
    const node = this.requireNode(id);
    const siblings = this.siblings(node.parentId);
    const precedingId = siblings[siblings.indexOf(id) - 1];
    if (!precedingId) return false;
    this.detach(id);
    node.parentId = precedingId;
    this.requireNode(precedingId).children.push(id);
    return true;
  }

  deleteNode(id) {
    const node = this.requireNode(id);
    const parentId = node.parentId;
    const index = this.detach(id);
    for (const childId of node.children) this.get(childId).parentId = parentId;
    this.siblings(parentId).splice(index, 0, ...node.children);
    delete this.data.nodes[id];
    const indexed = this.byUri.get(node.uri);
    indexed.delete(node);
    if (indexed.size === 0) this.byUri.delete(node.uri);
    this.nameKeys.delete(node.name.toLocaleLowerCase());
    for (const survivor of this.nodes()) {
      survivor.messages = survivor.messages.filter(message => message.targetId !== id);
    }
  }

  addMessage(senderId, targetId, label = '') {
    const sender = this.requireNode(senderId);
    this.requireNode(targetId);
    const clean = label.trim();
    const existing = sender.messages.find(message => message.targetId === targetId && message.label === clean);
    if (existing) return { message: existing, added: false };
    const message = { id: randomUUID(), targetId, label: clean };
    sender.messages.push(message);
    return { message, added: true };
  }

  requireMessage(senderId, messageId) {
    const message = this.requireNode(senderId).messages.find(entry => entry.id === messageId);
    if (!message) throw new Error('Message no longer exists');
    return message;
  }

  editMessage(senderId, messageId, label) {
    const sender = this.requireNode(senderId);
    const message = this.requireMessage(senderId, messageId);
    const clean = label.trim();
    if (sender.messages.some(entry => entry !== message && entry.targetId === message.targetId && entry.label === clean)) {
      throw new Error('That message reference already exists');
    }
    message.label = clean;
  }

  deleteMessage(senderId, messageId) {
    this.requireMessage(senderId, messageId);
    const sender = this.requireNode(senderId);
    sender.messages = sender.messages.filter(entry => entry.id !== messageId);
  }
}

module.exports = { ReadingGraph, normalizeName };
