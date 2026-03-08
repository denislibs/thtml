/**
 * AST node types for the thtml template engine.
 *
 * All nodes implement the BaseNode interface and use a discriminated union
 * via the `type` field. Span information tracks the exact source location of
 * every node for error reporting and source-map generation.
 */

// ---------------------------------------------------------------------------
// Position tracking
// ---------------------------------------------------------------------------

/**
 * A single point in source text.
 *
 * - `offset`  — 0-based byte offset from the start of the source string
 * - `line`    — 1-based line number
 * - `column`  — 0-based column number within the line
 */
export interface Position {
  /** 0-based byte offset from the start of the source string */
  offset: number;
  /** 1-based line number */
  line: number;
  /** 0-based column number within the line */
  column: number;
}

/** A half-open source range [start, end). */
export interface Span {
  start: Position;
  end: Position;
}

// ---------------------------------------------------------------------------
// Base node
// ---------------------------------------------------------------------------

/** Shared base for every AST node. */
export interface BaseNode {
  span: Span;
}

// ---------------------------------------------------------------------------
// Leaf nodes
// ---------------------------------------------------------------------------

/**
 * A verbatim chunk of HTML / text that is output as-is.
 *
 * Example source: `<div class="foo">`
 */
export interface TextNode extends BaseNode {
  type: "Text";
  value: string;
}

/**
 * A `{{ expression }}` interpolation node.
 *
 * - `escape: true`  — value will be HTML-escaped before output (default)
 * - `escape: false` — value is emitted as raw HTML (`{{ !expr }}` syntax)
 *
 * Example source: `{{ user.name }}`
 */
export interface ExpressionNode extends BaseNode {
  type: "Expression";
  /** Raw JavaScript / TypeScript expression string, e.g. "user.name" */
  expression: string;
  /** Whether the value should be HTML-escaped (default true). */
  escape: boolean;
}

/**
 * A `{{ !expression }}` raw interpolation node.
 *
 * Alias for `ExpressionNode` with `escape: false`. Exposed as a separate
 * interface so parser consumers can narrow on it via `type: "RawExpression"`.
 *
 * The underlying `type` discriminant is `"RawExpression"` to allow exhaustive
 * switches in code generators.
 *
 * Example source: `{{ !rawHtml }}`
 */
export interface RawExpressionNode extends BaseNode {
  type: "RawExpression";
  /** Raw JavaScript / TypeScript expression string (leading `!` already stripped). */
  expression: string;
}

// ---------------------------------------------------------------------------
// Block nodes
// ---------------------------------------------------------------------------

/**
 * `{% if condition %} ... {% else %} ... {% endif %}` block.
 *
 * - `alternate` is an empty array when there is no `{% else %}` branch.
 */
export interface IfNode extends BaseNode {
  type: "If";
  /** Raw condition expression, e.g. "isAdmin" or "user.age >= 18" */
  condition: string;
  /** Nodes inside the truthy branch */
  consequent: ChildNode[];
  /** Nodes inside the optional `{% else %}` branch (may be empty) */
  alternate: ChildNode[];
}

/**
 * `{% for item of iterable %} ... {% endfor %}` loop block.
 *
 * Supports an optional index binding:
 *   `{% for item, i of items %}`
 */
export interface ForNode extends BaseNode {
  type: "For";
  /** Loop item variable name, e.g. "item" */
  variable: string;
  /** Optional loop index variable name, e.g. "i" */
  indexVariable: string | null;
  /** Raw iterable expression, e.g. "items" or "user.posts" */
  iterable: string;
  body: ChildNode[];
}

/**
 * `{% set variable = expression %}` variable assignment.
 */
export interface SetNode extends BaseNode {
  type: "Set";
  /** Variable name to assign to */
  variable: string;
  /** Raw value expression */
  expression: string;
}

/**
 * `{% include "path/to/partial.thtml" %}` partial inclusion.
 */
export interface IncludeNode extends BaseNode {
  type: "Include";
  /** Path to the included template (quotes stripped) */
  path: string;
  /** Optional `with expression` context override */
  contextExpression: string | null;
}

/**
 * `{# comment #}` template comment — stripped at compile time.
 */
export interface CommentNode extends BaseNode {
  type: "Comment";
  content: string;
}

// ---------------------------------------------------------------------------
// Root node
// ---------------------------------------------------------------------------

/**
 * Top-level document node produced by the parser.
 */
export interface RootNode extends BaseNode {
  type: "Root";
  /**
   * Raw TypeScript source extracted from the `--- ... ---` frontmatter block,
   * or `null` if no frontmatter is present.
   */
  frontmatter: string | null;
  children: ChildNode[];
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/** Any node that may appear as a child of Root, If, or For. */
export type ChildNode =
  | TextNode
  | ExpressionNode
  | RawExpressionNode
  | IfNode
  | ForNode
  | SetNode
  | IncludeNode
  | CommentNode;

/** Any AST node (includes the root). */
export type AnyNode = RootNode | ChildNode;

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

export function isTextNode(node: AnyNode): node is TextNode {
  return node.type === "Text";
}

export function isExpressionNode(node: AnyNode): node is ExpressionNode {
  return node.type === "Expression";
}

export function isRawExpressionNode(node: AnyNode): node is RawExpressionNode {
  return node.type === "RawExpression";
}

export function isIfNode(node: AnyNode): node is IfNode {
  return node.type === "If";
}

export function isForNode(node: AnyNode): node is ForNode {
  return node.type === "For";
}

export function isSetNode(node: AnyNode): node is SetNode {
  return node.type === "Set";
}

export function isIncludeNode(node: AnyNode): node is IncludeNode {
  return node.type === "Include";
}

export function isCommentNode(node: AnyNode): node is CommentNode {
  return node.type === "Comment";
}
