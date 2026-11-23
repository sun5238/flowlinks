const path = require('node:path');
const vscode = require('vscode');
const { ReadingGraph } = require('./graph');
const { GraphTreeProvider } = require('./tree');
const { SourceDecorations } = require('./decorations');
const { NodeNamer } = require('./naming');
const { trackDocumentChanges } = require('./anchor');
const { encodeNote, decodeNote } = require('./note-text');
const { GraphPersistence } = require('./persistence');
const { WorkspaceStore } = require('./workspace-store');

const STORAGE_KEY = 'flowlinks.state.v1';
let persistence;

function itemNodeId(argument) {
  return typeof argument === 'string' ? argument : argument?.kind === 'node' ? argument.nodeId : undefined;
}

function displayLocation(node) {
  const uri = vscode.Uri.parse(node.uri);
  return `${path.basename(uri.fsPath || uri.path)}:${node.line + 1}`;
}

function getPosition(point) {
  return new vscode.Position(point.row ?? point.line, point.column ?? point.character);
}

async function resolveStaticName(namer, document, point) {
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const positions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, getPosition(point));
        if (!Array.isArray(positions) || positions.length === 0) return undefined;
        const targets = new Map();
        for (const location of positions) {
          const uri = location.targetUri || location.uri;
          const start = (location.targetSelectionRange || location.targetRange || location.range)?.start;
          if (uri && start) targets.set(`${uri.toString()}:${start.line}:${start.character}`, { uri, start });
        }
        if (targets.size !== 1) return undefined;
        const { uri, start } = [...targets.values()][0];
        if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
        const definitionDocument = await vscode.workspace.openTextDocument(uri);
        return namer.nameAtDefinition(definitionDocument, start);
      })(),
      new Promise(resolve => { timeout = setTimeout(() => resolve(undefined), 900); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function activate(context) {
  let graph;
  const store = WorkspaceStore.forWorkspace(vscode);
  try {
    const legacy = context.workspaceState.get(STORAGE_KEY);
    graph = new ReadingGraph(store ? await store.load(legacy) : legacy);
    if (store && legacy !== undefined) {
      if (store.base === null) {
        await store.save(graph.snapshot());
      } else {
        const backup = await store.backUpLegacy(new ReadingGraph(legacy).snapshot());
        void vscode.window.showWarningMessage(`FlowLinks found separate old data in this VS Code environment. It was saved to ${backup} for manual review; the shared workspace data takes precedence.`);
      }
      await context.workspaceState.update(STORAGE_KEY, undefined);
    }
  } catch (error) {
    await vscode.window.showErrorMessage(`FlowLinks could not load its saved data; nothing was changed: ${error.message}`);
    return;
  }

  const namer = new NodeNamer();
  const decorations = new SourceDecorations(vscode, graph, context.extensionPath);
  let lastSaveErrorAt = 0;
  let clearing = false;
  persistence = new GraphPersistence(
    () => graph.snapshot(),
    state => store ? store.save(state) : context.workspaceState.update(STORAGE_KEY, state),
    error => {
      const now = Date.now();
      if (now - lastSaveErrorAt >= 10_000) {
        lastSaveErrorAt = now;
        void vscode.window.showErrorMessage(`FlowLinks could not save its data: ${error.message}`);
      }
    }
  );
  let provider;

  function changed(updateDecorations = false) {
    provider.refresh();
    if (updateDecorations) decorations.updateVisible();
    persistence.schedule();
    return persistence.flush();
  }

  provider = new GraphTreeProvider(vscode, graph, async movedId => {
    await changed();
    if (movedId) await revealAfterMove(movedId);
  });
  const view = vscode.window.createTreeView('flowlinks.tree', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view, provider, decorations);

  let pendingSync = Promise.resolve();
  function syncFromDisk() {
    const next = pendingSync.catch(() => {}).then(async () => {
      if (!store || clearing || persistence.dirty || persistence.writing) return;
      const snapshot = await store.refresh();
      if (snapshot === undefined) return;
      graph = new ReadingGraph(snapshot);
      provider.graph = graph;
      decorations.graph = graph;
      provider.refresh();
      decorations.updateVisible();
    });
    pendingSync = next;
    return next;
  }

  if (store) {
    context.subscriptions.push(store.watch(() => {
      void syncFromDisk().catch(error => vscode.window.showErrorMessage(`FlowLinks could not reload shared data: ${error.message}`));
    }));
  }

  function register(command, handler) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
      if (clearing) return undefined;
      try {
        if (store) {
          await persistence.flush();
          await syncFromDisk();
        }
        return await handler(...args);
      } catch (error) {
        await vscode.window.showErrorMessage(`FlowLinks: ${error.message}`);
        return undefined;
      }
    }));
  }

  async function focusNode(id) {
    if (!graph.get(id)) return;
    await view.reveal(provider.nodeElement(id), { select: true, focus: true });
  }

  async function revealAfterMove(id) {
    const node = graph.get(id);
    if (!node) return;
    const parent = graph.get(node.parentId);
    await view.reveal(parent ? provider.nodeElement(parent.id) : provider.groupElement(node.parentId), { expand: true });
    await focusNode(id);
  }

  async function createGroup() {
    const name = await vscode.window.showInputBox({
      title: 'Create Group',
      placeHolder: 'Reading path name',
      validateInput: value => {
        if (!value.trim()) return 'A group name is required';
        if (value.trim().length > 72) return 'Group names are limited to 72 characters';
        if (graph.groups().some(group => group.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase())) {
          return 'That group name is already in use';
        }
        return undefined;
      },
    });
    if (name === undefined) return undefined;
    const group = graph.addGroup(name);
    await changed();
    if (!graph.getGroup(group.id)) return undefined;
    await view.reveal(provider.groupElement(group.id), { select: true, focus: true });
    return group;
  }
  register('flowlinks.createGroup', createGroup);

  async function activateGroup(id) {
    if (graph.setActiveGroup(id)) await changed();
    await view.reveal(provider.groupElement(id), { select: true, focus: true });
  }
  register('flowlinks.setActiveGroup', async argument => {
    if (argument?.kind === 'group' && graph.getGroup(argument.groupId)) await activateGroup(argument.groupId);
  });
  register('flowlinks.selectGroup', async () => {
    const groups = graph.groups();
    if (groups.length === 0) {
      await vscode.window.showInformationMessage('Create a group before selecting one.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      groups.map(group => ({ label: group.name, description: group.id === graph.data.activeGroupId ? 'Active' : '', id: group.id })),
      { title: 'Switch Active Group' }
    );
    if (picked) await activateGroup(picked.id);
  });

  register('flowlinks.renameGroup', async argument => {
    const group = graph.getGroup(argument?.groupId);
    if (!group) return;
    const name = await vscode.window.showInputBox({
      title: 'Rename Group',
      value: group.name,
      validateInput: value => {
        if (!value.trim()) return 'A group name is required';
        if (value.trim().length > 72) return 'Group names are limited to 72 characters';
        if (graph.groups().some(other => other.id !== group.id && other.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase())) {
          return 'That group name is already in use';
        }
        return undefined;
      },
    });
    if (name === undefined || name.trim() === group.name) return;
    graph.renameGroup(group.id, name);
    await changed();
  });

  register('flowlinks.deleteGroup', async argument => {
    const group = graph.getGroup(argument?.groupId);
    if (!group) return;
    const count = graph.nodes().filter(node => node.groupId === group.id).length;
    const choice = await vscode.window.showWarningMessage(
      `Delete group "${group.name}" and its ${count} node${count === 1 ? '' : 's'}?`,
      { modal: true, detail: 'This permanently removes those bookmarks, notes, and message links. Source files are not changed.' },
      'Delete Group'
    );
    if (choice !== 'Delete Group') return;
    graph.deleteGroup(group.id);
    await changed(true);
  });

  register('flowlinks.addNode', async argument => {
    const editor = vscode.window.activeTextEditor;
    let groupId = argument?.kind === 'group' ? argument.groupId : graph.data.activeGroupId;
    if (!groupId) {
      const choice = await vscode.window.showInformationMessage('Create a group before adding a node.', 'Create Group');
      if (choice !== 'Create Group') return;
      groupId = (await createGroup())?.id;
      if (!groupId) return;
    }
    if (!graph.getGroup(groupId)) return;
    if (!editor || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
      await vscode.window.showInformationMessage('Open a source file in the workspace to add a node.');
      return;
    }
    const selection = editor.selection;
    const start = selection.start;
    const existing = graph.findAt(editor.document.uri.toString(), start.line, start.character, groupId);
    if (existing) {
      if (graph.setActiveGroup(groupId)) await changed();
      await focusNode(existing.id);
      return;
    }
    const name = await namer.suggest(
      editor.document,
      { start, end: selection.end, active: selection.isEmpty ? selection.active : start, isEmpty: selection.isEmpty },
      position => resolveStaticName(namer, editor.document, position)
    );
    const { node } = graph.addNode({
      uri: editor.document.uri.toString(),
      line: start.line,
      character: start.character,
      endLine: selection.end.line,
      endCharacter: selection.end.character,
      name,
      groupId,
    });
    graph.setActiveGroup(groupId);
    await changed(true);
    await focusNode(node.id);
  });

  register('flowlinks.expandAll', async () => {
    const branches = graph.groups().length + graph.nodes().filter(node => node.children.length || node.messages.length).length;
    if (branches > 400) {
      const choice = await vscode.window.showWarningMessage(
        `Expand ${branches} branches? This may take a while.`, { modal: true }, 'Expand All'
      );
      if (choice !== 'Expand All') return;
    }
    const expand = async token => {
      const pending = graph.groups().reverse().map(group => provider.groupElement(group.id));
      let processed = 0;
      while (pending.length) {
        if (token.isCancellationRequested) return;
        const element = pending.pop();
        const children = provider.getChildren(element).filter(child => child.kind !== 'message');
        if (children.length || (element.kind === 'node' && graph.get(element.nodeId)?.messages.length)) {
          await view.reveal(element, { expand: true });
        }
        for (const child of children.reverse()) pending.push(child);
        if (++processed % 40 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    };
    if (branches > 80) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'FlowLinks: Expand All', cancellable: true },
        (_progress, token) => expand(token)
      );
    } else {
      await expand({ isCancellationRequested: false });
    }
  });

  register('flowlinks.jumpToNode', async argument => {
    const node = graph.get(itemNodeId(argument));
    if (!node) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const startLine = Math.min(node.line, document.lineCount - 1);
    const endLine = Math.min(node.endLine, document.lineCount - 1);
    const start = new vscode.Position(startLine, Math.min(node.character, document.lineAt(startLine).text.length));
    const end = new vscode.Position(endLine, Math.min(node.endCharacter, document.lineAt(endLine).text.length));
    editor.selection = new vscode.Selection(start, end.isBefore(start) ? start : end);
    editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });

  register('flowlinks.revealReceiver', async targetId => {
    if (graph.get(targetId)) await focusNode(targetId);
  });

  async function editNodeName(argument) {
    const node = graph.get(itemNodeId(argument));
    if (!node) return;
    const next = await vscode.window.showInputBox({
      title: 'Edit Node Name',
      value: node.name,
      validateInput: value => {
        if (!value.trim()) return 'A name is required';
        if (graph.nodes().some(other => other.id !== node.id && other.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase())) {
          return 'That name is already used in this graph';
        }
        return undefined;
      },
    });
    if (next === undefined || next.trim() === node.name) return;
    graph.renameNode(node.id, next);
    await changed(true);
  }
  register('flowlinks.editNodeName', editNodeName);
  register('flowlinks.renameNode', editNodeName);

  async function editNodeNote(argument) {
    const node = graph.get(itemNodeId(argument));
    if (!node) return;
    const input = await vscode.window.showInputBox({
      title: `Edit Node Note: ${node.name}`,
      value: encodeNote(node.note),
      prompt: 'Use \\n for a new line, \\\\ for a literal backslash.',
    });
    if (input === undefined) return;
    graph.setNote(node.id, decodeNote(input));
    await changed();
  }
  register('flowlinks.editNodeNote', editNodeNote);
  register('flowlinks.editNote', editNodeNote);

  register('flowlinks.deleteNode', async argument => {
    let id = itemNodeId(argument);
    if (!id) {
      const nodes = graph.nodes();
      if (nodes.length === 0) {
        await vscode.window.showInformationMessage('There are no graph nodes to delete.');
        return;
      }
      const choice = await vscode.window.showQuickPick(
        nodes.sort((a, b) => a.name.localeCompare(b.name))
          .map(node => ({ label: node.name, description: `${graph.getGroup(node.groupId).name} / ${displayLocation(node)}`, id: node.id })),
        { title: 'Delete Node', matchOnDescription: true }
      );
      if (!choice) return;
      id = choice.id;
    }
    if (!graph.get(id)) return;
    graph.deleteNode(id);
    await changed(true);
  });

  register('flowlinks.moveUp', async argument => {
    const id = itemNodeId(argument);
    if (graph.get(id) && graph.moveUp(id)) {
      await changed();
      await revealAfterMove(id);
    }
  });

  register('flowlinks.moveDown', async argument => {
    const id = itemNodeId(argument);
    if (graph.get(id) && graph.moveDown(id)) {
      await changed();
      await revealAfterMove(id);
    }
  });

  register('flowlinks.addMessage', async argument => {
    const sender = graph.get(itemNodeId(argument));
    if (!sender) return;
    if (graph.nodes().length < 2) {
      await vscode.window.showInformationMessage('Add a receiving node before creating a message.');
      return;
    }
    const target = await vscode.window.showQuickPick(
      graph.nodes().filter(node => node.id !== sender.id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(node => ({ label: node.name, description: `${graph.getGroup(node.groupId).name} / ${displayLocation(node)}`, id: node.id })),
      { title: `Receiver for ${sender.name}`, matchOnDescription: true }
    );
    if (!target) return;
    const label = await vscode.window.showInputBox({ title: 'Message Label', placeHolder: 'Optional' });
    if (label === undefined) return;
    const { added } = graph.addMessage(sender.id, target.id, label);
    if (added) await changed();
  });

  register('flowlinks.editMessage', async element => {
    if (element?.kind !== 'message') return;
    const message = graph.requireMessage(element.senderId, element.messageId);
    const next = await vscode.window.showInputBox({ title: 'Message Label', value: message.label });
    if (next === undefined) return;
    graph.editMessage(element.senderId, message.id, next);
    await changed();
  });

  register('flowlinks.deleteMessage', async element => {
    if (element?.kind !== 'message') return;
    graph.deleteMessage(element.senderId, element.messageId);
    await changed();
  });

  register('flowlinks.clearWorkspaceData', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Delete all FlowLinks groups, nodes, notes, and message links in this workspace?',
      { modal: true, detail: 'This cannot be undone. Source files will not be changed.' },
      'Delete All'
    );
    if (choice !== 'Delete All') return;

    clearing = true;
    try {
      await persistence.flush();
      const previous = graph;
      const empty = new ReadingGraph();
      graph = empty;
      provider.graph = empty;
      decorations.graph = empty;
      try {
        if (store) await store.save(empty.snapshot());
        else await context.workspaceState.update(STORAGE_KEY, undefined);
      } catch (error) {
        graph = previous;
        provider.graph = previous;
        decorations.graph = previous;
        throw error;
      } finally {
        provider.refresh();
        decorations.updateVisible();
      }
    } finally {
      clearing = false;
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (clearing) return;
      const uri = event.document.uri.toString();
      if (!graph.hasNodesInUri(uri)) return;
      const before = new Map(graph.nodesForUri(uri).map(node => [node.id, node.line]));
      if (trackDocumentChanges(graph, uri, event.contentChanges, event.document)) {
        if (graph.nodesForUri(uri).some(node => before.get(node.id) !== node.line)) {
          provider.refresh();
          decorations.updateVisible();
        }
        persistence.schedule();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.updateVisible()),
    vscode.window.onDidChangeActiveTextEditor(editor => decorations.updateEditor(editor))
  );
  decorations.updateVisible();
  if (graph.migrated && !store) persistence.schedule();
}

async function deactivate() {
  if (persistence) {
    await persistence.flush();
    persistence = undefined;
  }
}

module.exports = { activate, deactivate };
