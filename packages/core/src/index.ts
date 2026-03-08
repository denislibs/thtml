/**
 * @thtml/core — Public API
 *
 * Main entry point for the thtml template engine.
 *
 * @example
 * ```ts
 * import { compile } from '@thtml/core';
 *
 * interface Ctx { title: string; items: string[] }
 *
 * const tmpl = compile<Ctx>(`
 *   <h1>{{ title }}</h1>
 *   <ul>
 *     {% for item of items %}
 *       <li>{{ item }}</li>
 *     {% endfor %}
 *   </ul>
 * `);
 *
 * const html = tmpl.render({ title: 'My list', items: ['Foo', 'Bar'] });
 * ```
 */

// ---------------------------------------------------------------------------
// Compiler (primary API)
// ---------------------------------------------------------------------------

export { compile, compileAST, Compiler, defineTemplate } from "./compiler.js";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export { parse, Parser, ParseError } from "./parser.js";

// ---------------------------------------------------------------------------
// Lexer / Tokenizer
// ---------------------------------------------------------------------------

export { tokenize, Lexer, LexerError, TokenType } from "./lexer.js";
export type { Token } from "./lexer.js";

// ---------------------------------------------------------------------------
// AST node types
// ---------------------------------------------------------------------------

export type {
  AnyNode,
  BaseNode,
  ChildNode,
  CommentNode,
  ExpressionNode,
  ForNode,
  IfNode,
  IncludeNode,
  Position,
  RawExpressionNode,
  RootNode,
  SetNode,
  Span,
  TextNode,
} from "./ast.js";

// AST type guards
export {
  isCommentNode,
  isExpressionNode,
  isForNode,
  isIfNode,
  isIncludeNode,
  isRawExpressionNode,
  isSetNode,
  isTextNode,
} from "./ast.js";

// ---------------------------------------------------------------------------
// Runtime helpers (re-exported for advanced use)
// ---------------------------------------------------------------------------

export {
  createRuntimeContext,
  escapeHtml,
  forEach,
  safeGet,
  StringBuffer,
  toRaw,
} from "./runtime.js";
export type { LoopMeta, RuntimeContext } from "./runtime.js";

// ---------------------------------------------------------------------------
// Public TypeScript types
// ---------------------------------------------------------------------------

export type {
  CompileOptions,
  Diagnostic,
  DiagnosticPosition,
  DiagnosticSeverity,
  RenderOptions,
  Template,
  TemplateLoader,
  TemplateMetadata,
} from "./types.js";
