const path = require('node:path');

class SourceDecorations {
  constructor(vscode, graph, extensionPath) {
    this.vscode = vscode;
    this.graph = graph;
    this.type = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(path.join(extensionPath, 'assets', 'gutter.svg')),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('charts.green'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  updateEditor(editor) {
    if (!editor) return;
    const uri = editor.document.uri.toString();
    const marks = this.graph.nodesForUri(uri)
      .filter(node => node.line < editor.document.lineCount)
      .map(node => ({
        range: new this.vscode.Range(node.line, 0, node.line, 0),
        hoverMessage: node.name,
      }));
    editor.setDecorations(this.type, marks);
  }

  updateVisible() {
    for (const editor of this.vscode.window.visibleTextEditors) this.updateEditor(editor);
  }

  dispose() {
    this.type.dispose();
  }
}

module.exports = { SourceDecorations };
