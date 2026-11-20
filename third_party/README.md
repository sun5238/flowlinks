# Included Parser Components

- `vendor/web-tree-sitter/tree-sitter.cjs` and `tree-sitter.wasm` come from
  `web-tree-sitter` 0.25.10. Its MIT license is in `web-tree-sitter-LICENSE`.
- `grammars/tree-sitter-c.wasm` and `tree-sitter-rust.wasm` come from
  `tree-sitter-wasms` 0.1.13. Its Unlicense notice is in
  `tree-sitter-wasms-LICENSE`. The source grammars are Tree-sitter's C and Rust
  grammars (https://github.com/tree-sitter/tree-sitter-c and
  https://github.com/tree-sitter/tree-sitter-rust). The grammars' MIT notices
  are retained in `tree-sitter-c-LICENSE` and `tree-sitter-rust-LICENSE`.

The downloaded `bookmark-flow` and `code-flow` repositories are not bundled
with this extension. The extension's graph, view, and command implementations
are independent.
