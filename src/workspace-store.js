const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ReadingGraph } = require('./graph');

const FILE_NAME = 'flowlinks.json';

class WorkspaceStore {
  constructor(vscode, folder) {
    this.vscode = vscode;
    this.folder = folder;
    this.directory = path.join(folder.uri.fsPath, '.vscode');
    this.file = path.join(this.directory, FILE_NAME);
    this.base = null;
  }

  static forWorkspace(vscode) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0].uri.scheme !== 'file') return undefined;
    return new WorkspaceStore(vscode, folders[0]);
  }

  async readRaw() {
    try {
      return await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  decode(raw) {
    const saved = JSON.parse(raw);
    if (saved.format !== 'flowlinks-workspace-v1' || !saved.graph?.nodes) {
      throw new Error('Unsupported or damaged shared FlowLinks data');
    }
    const graph = structuredClone(saved.graph);
    for (const node of Object.values(graph.nodes)) {
      if (node.uri && typeof node.uri === 'object') {
        const relative = node.uri.relativePath;
        if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split('/').includes('..') ||
            relative.includes('\\')) {
          throw new Error('Invalid shared FlowLinks source path');
        }
        node.uri = this.vscode.Uri.file(path.join(this.folder.uri.fsPath, ...relative.split('/'))).toString();
      }
    }
    return new ReadingGraph(graph).snapshot();
  }

  encode(snapshot) {
    const nodes = {};
    for (const [id, node] of Object.entries(snapshot.nodes)) {
      const uri = this.vscode.Uri.parse(node.uri);
      if (uri.scheme === 'file') {
        const relative = path.relative(this.folder.uri.fsPath, uri.fsPath);
        if (relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
          nodes[id] = { ...node, uri: { relativePath: relative.split(path.sep).join('/') } };
          continue;
        }
      }
      nodes[id] = node;
    }
    const graph = { ...snapshot, nodes };
    return `${JSON.stringify({ format: 'flowlinks-workspace-v1', graph }, null, 2)}\n`;
  }

  async load(fallback) {
    const raw = await this.readRaw();
    if (raw === null) {
      this.base = null;
      return fallback;
    }
    const snapshot = this.decode(raw);
    this.base = raw;
    return snapshot;
  }

  async refresh() {
    const expected = this.base;
    const raw = await this.readRaw();
    if (this.base !== expected) return undefined;
    if (raw === this.base) return undefined;
    const snapshot = raw === null ? new ReadingGraph().snapshot() : this.decode(raw);
    this.base = raw;
    return snapshot;
  }

  async atomicWrite(file, contents) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, contents, { flag: 'wx' });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async save(snapshot) {
    await fs.mkdir(this.directory, { recursive: true });
    const serialized = this.encode(snapshot);
    await this.atomicWrite(this.file, serialized);
    this.base = serialized;
  }

  async backUpLegacy(snapshot) {
    await fs.mkdir(this.directory, { recursive: true });
    const backup = path.join(this.directory, `flowlinks.legacy-${randomUUID()}.json`);
    await this.atomicWrite(backup, this.encode(snapshot));
    return backup;
  }

  watch(onChange) {
    const watcher = this.vscode.workspace.createFileSystemWatcher(
      new this.vscode.RelativePattern(this.folder, `.vscode/${FILE_NAME}`)
    );
    const listeners = [watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange)];
    return { dispose() { listeners.forEach(listener => listener.dispose()); watcher.dispose(); } };
  }
}

module.exports = { WorkspaceStore };
