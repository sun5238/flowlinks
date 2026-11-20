function comparePosition(a, b) {
  return a.line - b.line || a.character - b.character;
}

function advance(start, text) {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length === 1
    ? { line: start.line, character: start.character + lines[0].length }
    : { line: start.line + lines.length - 1, character: lines.at(-1).length };
}

function transformPosition(position, change) {
  const { start, end } = change.range;
  if (comparePosition(position, start) < 0) return position;
  const insertedEnd = advance(start, change.text);
  if (comparePosition(position, end) <= 0 && comparePosition(start, end) !== 0) return insertedEnd;
  if (position.line === end.line) {
    return { line: insertedEnd.line, character: insertedEnd.character + position.character - end.character };
  }
  return { line: position.line + insertedEnd.line - end.line, character: position.character };
}

function clamp(position, document) {
  const line = Math.max(0, Math.min(position.line, document.lineCount - 1));
  return { line, character: Math.max(0, Math.min(position.character, document.lineAt(line).text.length)) };
}

function trackDocumentChanges(graph, uri, changes, document) {
  if (changes.length === 0 || !graph.hasNodesInUri(uri)) return false;
  const ordered = [...changes].sort((a, b) => comparePosition(b.range.start, a.range.start));
  let changed = false;
  for (const node of graph.nodesForUri(uri)) {
    let start = { line: node.line, character: node.character };
    let end = { line: node.endLine, character: node.endCharacter };
    for (const change of ordered) {
      start = transformPosition(start, change);
      end = transformPosition(end, change);
    }
    start = clamp(start, document);
    end = clamp(end, document);
    if (comparePosition(end, start) < 0) end = start;
    if (start.line !== node.line || start.character !== node.character || end.line !== node.endLine || end.character !== node.endCharacter) {
      graph.updatePosition(node.id, start, end);
      changed = true;
    }
  }
  return changed;
}

module.exports = { transformPosition, trackDocumentChanges };
