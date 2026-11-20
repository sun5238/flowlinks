const MIME = 'application/vnd.code.tree.flowlinks.tree';

class GraphTreeProvider {
  constructor(vscode, graph, onChange) {
    this.vscode = vscode;
    this.graph = graph;
    this.onChange = onChange;
    this.dropMimeTypes = [MIME];
    this.dragMimeTypes = [MIME];
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.previousSiblings = new Set();
    this.nextSiblings = new Set();
    this.updateSiblingPositions();
  }

  dispose() {
    this.emitter.dispose();
  }

  refresh() {
    this.updateSiblingPositions();
    this.emitter.fire(undefined);
  }

  updateSiblingPositions() {
    this.previousSiblings.clear();
    this.nextSiblings.clear();
    const siblingLists = [...this.graph.groups().map(group => group.children), ...this.graph.nodes().map(node => node.children)];
    for (const siblings of siblingLists) {
      for (let index = 0; index < siblings.length; index++) {
        if (index > 0) this.previousSiblings.add(siblings[index]);
        if (index < siblings.length - 1) this.nextSiblings.add(siblings[index]);
      }
    }
  }

  nodeElement(nodeId) {
    return { kind: 'node', nodeId };
  }

  groupElement(groupId) {
    return { kind: 'group', groupId };
  }

  sourceLocation(node) {
    const uri = this.vscode.Uri.parse(node.uri);
    return `${this.vscode.workspace.asRelativePath(uri, true)}:${node.line + 1}:${node.character + 1}`;
  }

  nodeTooltip(node) {
    const tip = new this.vscode.MarkdownString();
    tip.supportThemeIcons = true;
    tip.appendMarkdown('**');
    tip.appendText(node.name);
    tip.appendMarkdown('**\n\n$(file-code) ');
    tip.appendText(this.sourceLocation(node));
    if (node.note) {
      tip.appendMarkdown('\n\n---\n\n**Note**\n\n');
      tip.appendText(node.note);
    }
    return tip;
  }

  getTreeItem(element) {
    const { vscode, graph } = this;
    if (element.kind === 'group') {
      const group = graph.getGroup(element.groupId);
      const item = new vscode.TreeItem(group?.name || 'Removed group',
        group?.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `group:${element.groupId}`;
      item.contextValue = `graphGroup|${graph.data.activeGroupId === element.groupId ? 'activeGroup' : 'inactiveGroup'}`;
      item.iconPath = new vscode.ThemeIcon(graph.data.activeGroupId === element.groupId ? 'folder-opened' : 'folder');
      if (group) {
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(graph.data.activeGroupId === group.id ? '**Active group**\n\n' : '**Group**\n\n');
        tip.appendText(group.name);
        item.tooltip = tip;
      }
      return item;
    }
    if (element.kind === 'message') {
      const sender = graph.get(element.senderId);
      const message = sender?.messages.find(entry => entry.id === element.messageId);
      const receiver = message && graph.get(message.targetId);
      const label = receiver
        ? `${receiver.name}${message.label ? `: ${message.label}` : ''}`
        : 'Message';
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = `message:${element.senderId}:${element.messageId}`;
      item.contextValue = 'graphMessage';
      item.iconPath = new vscode.ThemeIcon('link');
      if (message && receiver) {
        const tip = new vscode.MarkdownString();
        tip.supportThemeIcons = true;
        tip.appendMarkdown('**Message**\n\n');
        tip.appendText(sender.name);
        tip.appendMarkdown(' $(arrow-right) ');
        tip.appendText(receiver.name);
        tip.appendMarkdown('\n\n$(file-code) ');
        tip.appendText(this.sourceLocation(receiver));
        if (message.label) {
          tip.appendMarkdown('\n\n**Label**  \n');
          tip.appendText(message.label);
        }
        item.tooltip = tip;
        item.command = {
          command: 'flowlinks.revealReceiver',
          title: 'Reveal Receiver',
          arguments: [message.targetId],
        };
      }
      return item;
    }

    const node = graph.get(element.nodeId);
    const expandable = node && (node.children.length > 0 || node.messages.length > 0);
    const item = new vscode.TreeItem(
      node?.name || 'Removed node',
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = `node:${element.nodeId}`;
    item.contextValue = [
      'graphNode',
      this.previousSiblings.has(element.nodeId) ? 'canMoveUp' : '',
      this.nextSiblings.has(element.nodeId) ? 'canMoveDown' : '',
    ].filter(Boolean).join('|');
    item.iconPath = new vscode.ThemeIcon('circle-filled');
    if (node) {
      item.tooltip = this.nodeTooltip(node);
      item.command = {
        command: 'flowlinks.jumpToNode',
        title: 'Jump to Source',
        arguments: [node.id],
      };
    }
    return item;
  }

  getChildren(element) {
    if (!element) return this.graph.data.groupOrder.map(id => this.groupElement(id));
    if (element.kind === 'message') return [];
    if (element.kind === 'group') {
      return (this.graph.getGroup(element.groupId)?.children || []).map(id => this.nodeElement(id));
    }
    const node = this.graph.get(element.nodeId);
    if (!node) return [];
    return [
      ...node.children.map(id => this.nodeElement(id)),
      ...node.messages.map(message => ({ kind: 'message', senderId: node.id, messageId: message.id })),
    ];
  }

  getParent(element) {
    if (element.kind === 'group') return undefined;
    if (element.kind === 'message') return this.nodeElement(element.senderId);
    const node = this.graph.get(element.nodeId);
    if (!node) return undefined;
    return this.graph.getGroup(node.parentId)
      ? this.groupElement(node.parentId) : this.nodeElement(node.parentId);
  }

  handleDrag(source, dataTransfer) {
    if (source.length !== 1 || source[0].kind !== 'node') return;
    dataTransfer.set(MIME, new this.vscode.DataTransferItem({ nodeId: source[0].nodeId }));
  }

  async handleDrop(target, dataTransfer) {
    const dragged = dataTransfer.get(MIME)?.value;
    if (!dragged || !target || !['node', 'group'].includes(target.kind)) return;
    try {
      if (this.graph.moveOnto(dragged.nodeId, target.kind === 'group' ? target.groupId : target.nodeId)) {
        this.graph.setActiveGroup(this.graph.get(dragged.nodeId).groupId);
        await this.onChange(dragged.nodeId);
      }
    } catch (error) {
      await this.vscode.window.showWarningMessage(error.message);
    }
  }
}

module.exports = { GraphTreeProvider };
