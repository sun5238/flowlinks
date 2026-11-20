const path = require('node:path');
const { Parser, Language } = require('../vendor/web-tree-sitter/tree-sitter.cjs');

const GRAMMARS = { c: 'tree-sitter-c.wasm', rust: 'tree-sitter-rust.wasm' };
const MAX_PARSE_CHARACTERS = 256 * 1024;
const MAX_PARSE_MS = 75;

function shorten(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 72);
}

function at(position, node) {
  return position.line === node.startPosition.row && position.character <= node.endPosition.column;
}

function containing(node, type) {
  for (let cursor = node; cursor; cursor = cursor.parent) {
    if (cursor.type === type) return cursor;
  }
  return undefined;
}

function cDeclaratorName(node) {
  for (let cursor = node; cursor;) {
    if (cursor.type === 'identifier') return cursor;
    cursor = cursor.childForFieldName('declarator') || cursor.namedChildren[0];
  }
  return undefined;
}

function enclosingDefinition(node, languageId, position) {
  for (let cursor = node; cursor; cursor = cursor.parent) {
    if (languageId === 'rust' && cursor.type === 'function_item') {
      const name = cursor.childForFieldName('name');
      if (name && at(position, name) && position.line === name.startPosition.row) return { name: name.text, node: cursor };
    }
    if (languageId === 'c' && cursor.type === 'function_definition') {
      const name = cDeclaratorName(cursor.childForFieldName('declarator'));
      if (name && at(position, name) && position.line === name.startPosition.row) return { name: name.text, node: cursor };
    }
  }
  return undefined;
}

function definitionOwner(node, languageId) {
  if (languageId !== 'rust') return undefined;
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (cursor.type === 'impl_item') return cursor.childForFieldName('type')?.text;
    if (cursor.type === 'trait_item') return cursor.childForFieldName('name')?.text;
  }
  return undefined;
}

function callAt(node, languageId) {
  const call = containing(node, 'call_expression');
  if (!call) return undefined;
  const fn = call.childForFieldName('function');
  if (!fn) return undefined;
  if (fn.type === 'identifier' || fn.type === 'scoped_identifier') {
    return { name: shorten(fn.text), complete: true, position: fn.startPosition, source: call.text };
  }
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    const receiver = fn.childForFieldName(languageId === 'rust' ? 'value' : 'argument');
    if (languageId === 'rust' && receiver?.text === 'self' && field) {
      const owner = definitionOwner(call, languageId);
      if (owner) return { name: `${owner}::${field.text}`, complete: true, position: field.startPosition, source: call.text };
    }
    return { name: field?.text || fn.text, complete: false, position: field?.startPosition || fn.startPosition, source: call.text };
  }
  return { name: shorten(fn.text), complete: false, position: fn.startPosition, source: call.text };
}

function sourceAt(document, selection, expression) {
  if (expression) return shorten(expression);
  if (!selection.isEmpty) {
    const selected = shorten(document.getText(selection));
    if (selected) return selected;
  }
  const line = document.lineAt(selection.active.line).text;
  const start = Math.max(0, selection.active.character - 32);
  return shorten(line.slice(start, start + 96)) || `${path.basename(document.uri.fsPath || document.uri.path || '')}:${selection.active.line + 1}`;
}

class NodeNamer {
  constructor(grammarDirectory = path.join(__dirname, '..', 'grammars')) {
    this.grammarDirectory = grammarDirectory;
    this.languages = new Map();
    this.initialized = undefined;
  }

  async language(languageId) {
    const grammar = GRAMMARS[languageId];
    if (!grammar) return undefined;
    if (!this.initialized) this.initialized = Parser.init();
    await this.initialized;
    if (!this.languages.has(languageId)) {
      this.languages.set(languageId, Language.load(path.join(this.grammarDirectory, grammar)));
    }
    return this.languages.get(languageId);
  }

  async withTree(document, visit) {
    const source = document.getText();
    if (source.length > MAX_PARSE_CHARACTERS) return undefined;
    let language;
    try {
      language = await this.language(document.languageId);
    } catch {
      return undefined;
    }
    if (!language) return undefined;
    const parser = new Parser();
    let tree;
    try {
      parser.setLanguage(language);
      const started = performance.now();
      tree = parser.parse(source, null, {
        progressCallback: () => performance.now() - started > MAX_PARSE_MS,
      });
      if (!tree) return undefined;
      return visit(tree);
    } catch {
      return undefined;
    } finally {
      tree?.delete();
      parser.delete();
    }
  }

  async syntaxAt(document, position) {
    return this.withTree(document, tree => {
      const point = { row: position.line, column: position.character };
      const node = tree.rootNode.namedDescendantForPosition(point);
      if (!node) return undefined;
      const call = callAt(node, document.languageId);
      if (call) return call;
      const definition = enclosingDefinition(node, document.languageId, position);
      if (definition) return { name: definition.name, complete: true, position: definition.node.startPosition };
      const line = document.lineAt(position.line).text;
      const nearby = tree.rootNode.descendantsOfType(
        'call_expression',
        { row: position.line, column: 0 },
        { row: position.line, column: line.length }
      ).filter(candidate => candidate && candidate.startPosition.row === position.line)
        .reduce((best, candidate) => {
          if (!best) return candidate;
          return Math.abs(candidate.startPosition.column - position.character) <
            Math.abs(best.startPosition.column - position.character) ? candidate : best;
        }, undefined);
      return nearby && callAt(nearby, document.languageId);
    });
  }

  async nameAtDefinition(document, position) {
    return this.withTree(document, tree => {
      const node = tree.rootNode.namedDescendantForPosition({ row: position.line, column: position.character });
      if (!node) return undefined;
      for (let cursor = node; cursor; cursor = cursor.parent) {
        if (cursor.type === 'function_item' || cursor.type === 'function_definition') {
          const name = cursor.type === 'function_item'
            ? cursor.childForFieldName('name')?.text
            : cDeclaratorName(cursor.childForFieldName('declarator'))?.text;
          if (!name) return undefined;
          const owner = definitionOwner(cursor, document.languageId);
          return owner ? `${owner}::${name}` : name;
        }
      }
      return undefined;
    });
  }

  async suggest(document, selection, resolveDefinition) {
    const syntax = await this.syntaxAt(document, selection.active);
    if (syntax?.complete && syntax.name) return syntax.name;
    if (resolveDefinition) {
      try {
        const resolved = await resolveDefinition(syntax?.position || selection.active, syntax);
        if (resolved && (!syntax || !syntax.name || resolved.includes('::'))) return shorten(resolved);
      } catch {
        // The source text is the reliable fallback when a language provider fails.
      }
    }
    return sourceAt(document, selection, syntax?.source);
  }
}

module.exports = { NodeNamer, sourceAt };
