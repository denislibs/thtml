/**
 * Parser for thtml templates.
 *
 * Consumes the flat token stream produced by {@link Lexer} and builds a typed
 * AST rooted at {@link RootNode}.
 *
 * Grammar (simplified EBNF):
 *
 *   root        ::= frontmatter? child*
 *   frontmatter ::= FRONTMATTER_FENCE FRONTMATTER_CONTENT? FRONTMATTER_FENCE
 *   child       ::= text | expression | raw-expression | if-block
 *                 | for-block | set | include | comment
 *   text        ::= TEXT
 *   expression  ::= OPEN_EXPR EXPRESSION_CONTENT CLOSE_EXPR
 *                   (EXPRESSION_CONTENT begins with "!" for raw output)
 *   if-block    ::= OPEN_BLOCK "if" <cond> CLOSE_BLOCK
 *                     child*
 *                   (OPEN_BLOCK "else" CLOSE_BLOCK child*)?
 *                   OPEN_BLOCK "endif" CLOSE_BLOCK
 *   for-block   ::= OPEN_BLOCK "for" <var> ["," <idx>] "of" <iterable> CLOSE_BLOCK
 *                     child*
 *                   OPEN_BLOCK "endfor" CLOSE_BLOCK
 *   set         ::= OPEN_BLOCK "set" <ident> "=" <expr> CLOSE_BLOCK
 *   include     ::= OPEN_BLOCK "include" <string> ["with" <expr>] CLOSE_BLOCK
 *   comment     ::= OPEN_COMMENT COMMENT_CONTENT? CLOSE_COMMENT
 *
 * Error strategy:
 *   All errors are thrown as `ParseError` instances carrying the offending
 *   token. Messages include 1-based line and 0-based column numbers.
 */

import {
  type AnyNode,
  type ChildNode,
  type CommentNode,
  type ExpressionNode,
  type ForNode,
  type IfNode,
  type IncludeNode,
  type RawExpressionNode,
  type RootNode,
  type SetNode,
  type Span,
  type TextNode,
} from "./ast.js";
import { type Token, TokenType, tokenize } from "./lexer.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly token: Token,
    public readonly source: string
  ) {
    const { line, column } = token.span.start;
    super(`ParseError at line ${line}, column ${column}: ${message}`);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Stop-keyword sets used by parseChildren
// ---------------------------------------------------------------------------

/**
 * When parsing the body of an `if` block, stop at `else` or `endif`.
 * When parsing the body of an `else` branch, stop at `endif`.
 * When parsing the body of a `for` block, stop at `endfor`.
 */
const STOP_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  if: ["else", "endif"],
  else: ["endif"],
  for: ["endfor"],
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Recursive-descent parser that converts a token stream into a thtml AST.
 *
 * @example
 * ```ts
 * import { Parser } from '@thtml/core';
 * import { tokenize } from '@thtml/core';
 *
 * const tokens = tokenize(source);
 * const ast = new Parser(tokens, source).parse();
 * ```
 */
export class Parser {
  /** Current read position inside `tokens`. */
  private pos: number = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string
  ) {}

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  /**
   * Parse the token stream and return the root AST node.
   * Throws `ParseError` on any syntax error.
   */
  parse(): RootNode {
    this.pos = 0;

    const startToken = this.current();
    const frontmatter = this.parseFrontmatter();
    const children = this.parseChildren(null);

    // The last token before EOF gives us the end span.
    const lastConsumed = this.tokens[this.pos - 1] ?? startToken;

    return {
      type: "Root",
      frontmatter,
      children,
      span: this.makeSpan(startToken, lastConsumed),
    };
  }

  // -------------------------------------------------------------------------
  // Frontmatter  --- ... ---
  // -------------------------------------------------------------------------

  private parseFrontmatter(): string | null {
    if (!this.check(TokenType.FRONTMATTER_FENCE)) return null;

    this.consume(TokenType.FRONTMATTER_FENCE); // opening ---

    let content: string | null = null;
    if (this.check(TokenType.FRONTMATTER_CONTENT)) {
      content = this.consume(TokenType.FRONTMATTER_CONTENT).value;
    }

    // Tolerate missing closing fence (e.g., truncated source).
    if (this.check(TokenType.FRONTMATTER_FENCE)) {
      this.consume(TokenType.FRONTMATTER_FENCE); // closing ---
    }

    return content;
  }

  // -------------------------------------------------------------------------
  // Children list
  // -------------------------------------------------------------------------

  /**
   * Parse a sequence of child nodes until we hit a block whose keyword is in
   * `stopKeywords`, or until EOF.
   *
   * @param stopContext - the parent context key (e.g. "if", "for") whose
   *   associated stop-words should terminate parsing, or `null` at the root.
   */
  private parseChildren(stopContext: string | null): ChildNode[] {
    const children: ChildNode[] = [];
    const stops = stopContext !== null ? STOP_KEYWORDS[stopContext] ?? [] : [];

    while (!this.isEOF()) {
      // Look ahead for a stop keyword that ends the current block.
      if (stops.length > 0 && this.check(TokenType.OPEN_BLOCK)) {
        const kw = this.peekBlockKeyword();
        if (kw !== null && (stops as readonly string[]).includes(kw)) {
          break;
        }
      }

      const child = this.parseChild();
      if (child !== null) {
        children.push(child);
      }
    }

    return children;
  }

  // -------------------------------------------------------------------------
  // Single child dispatch
  // -------------------------------------------------------------------------

  private parseChild(): ChildNode | null {
    const token = this.current();

    switch (token.type) {
      case TokenType.TEXT:
        return this.parseText();

      case TokenType.OPEN_EXPR:
        return this.parseExpression();

      case TokenType.OPEN_BLOCK:
        return this.parseBlock();

      case TokenType.OPEN_COMMENT:
        return this.parseComment();

      // Stray frontmatter tokens should not appear in the document body,
      // but we skip them gracefully to avoid crashing on malformed input.
      case TokenType.FRONTMATTER_FENCE:
      case TokenType.FRONTMATTER_CONTENT:
        this.advance();
        return null;

      case TokenType.EOF:
        return null;

      default:
        throw new ParseError(
          `Unexpected token type "${this.tokenTypeName(token.type)}" ("${token.value}")`,
          token,
          this.source
        );
    }
  }

  // -------------------------------------------------------------------------
  // Text node
  // -------------------------------------------------------------------------

  private parseText(): TextNode {
    const token = this.consume(TokenType.TEXT);
    return {
      type: "Text",
      value: token.value,
      span: token.span,
    };
  }

  // -------------------------------------------------------------------------
  // Expression node  {{ expr }}  or  {{ !expr }}
  // -------------------------------------------------------------------------

  private parseExpression(): ExpressionNode | RawExpressionNode {
    const openToken = this.consume(TokenType.OPEN_EXPR);

    if (!this.check(TokenType.EXPRESSION_CONTENT)) {
      // Empty expression `{{ }}` — consume close and throw.
      const closeToken = this.current();
      throw new ParseError(
        'Empty expression — "{{ }}" has no content',
        closeToken,
        this.source
      );
    }

    const contentToken = this.consume(TokenType.EXPRESSION_CONTENT);
    const rawContent = contentToken.value.trim();

    const closeToken = this.consume(TokenType.CLOSE_EXPR);
    const span = this.makeSpan(openToken, closeToken);

    if (rawContent.startsWith("!")) {
      // Raw expression — no HTML escaping.
      const expression = rawContent.slice(1).trim();
      if (expression.length === 0) {
        throw new ParseError(
          'Empty raw expression — "{{ ! }}" has no expression after "!"',
          contentToken,
          this.source
        );
      }
      const node: RawExpressionNode = {
        type: "RawExpression",
        expression,
        span,
      };
      return node;
    }

    if (rawContent.length === 0) {
      throw new ParseError(
        'Empty expression — "{{ }}" has no content',
        contentToken,
        this.source
      );
    }

    const node: ExpressionNode = {
      type: "Expression",
      expression: rawContent,
      escape: true,
      span,
    };
    return node;
  }

  // -------------------------------------------------------------------------
  // Block dispatch  {% keyword ... %}
  // -------------------------------------------------------------------------

  private parseBlock(): ChildNode {
    const keyword = this.peekBlockKeyword();

    switch (keyword) {
      case "if":
        return this.parseIf();
      case "for":
        return this.parseFor();
      case "set":
        return this.parseSet();
      case "include":
        return this.parseInclude();
      default: {
        const token = this.current();
        throw new ParseError(
          `Unknown block keyword: "${keyword ?? "(none)"}" — expected "if", "for", "set", or "include"`,
          token,
          this.source
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // If block  {% if cond %} ... {% else %} ... {% endif %}
  // -------------------------------------------------------------------------

  private parseIf(): IfNode {
    const openToken = this.consume(TokenType.OPEN_BLOCK);
    const contentToken = this.consume(TokenType.BLOCK_CONTENT);
    this.consume(TokenType.CLOSE_BLOCK);

    // Content is e.g. "if isAdmin" or "if user.age >= 18"
    const rawContent = contentToken.value.trim();
    if (!rawContent.startsWith("if")) {
      throw new ParseError(
        `Expected "if <condition>", got "${rawContent}"`,
        contentToken,
        this.source
      );
    }
    const condition = rawContent.slice("if".length).trim();
    if (condition.length === 0) {
      throw new ParseError(
        '"if" block is missing its condition expression',
        contentToken,
        this.source
      );
    }

    // Parse the truthy branch — stop at `else` or `endif`.
    const consequent = this.parseChildren("if");

    let alternate: ChildNode[] = [];

    // Optional {% else %} branch.
    if (this.check(TokenType.OPEN_BLOCK) && this.peekBlockKeyword() === "else") {
      this.consume(TokenType.OPEN_BLOCK);
      // `else` block has BLOCK_CONTENT with just "else"; consume it.
      if (this.check(TokenType.BLOCK_CONTENT)) {
        this.consume(TokenType.BLOCK_CONTENT);
      }
      this.consume(TokenType.CLOSE_BLOCK);

      // Parse the falsy branch — stop at `endif`.
      alternate = this.parseChildren("else");
    }

    // Consume {% endif %}.
    this.expectBlock("endif");
    const closeToken = this.advance(); // consume the CLOSE_BLOCK of endif

    return {
      type: "If",
      condition,
      consequent,
      alternate,
      span: this.makeSpan(openToken, closeToken),
    };
  }

  // -------------------------------------------------------------------------
  // For block  {% for item[, index] of iterable %} ... {% endfor %}
  // -------------------------------------------------------------------------

  private parseFor(): ForNode {
    const openToken = this.consume(TokenType.OPEN_BLOCK);
    const contentToken = this.consume(TokenType.BLOCK_CONTENT);
    this.consume(TokenType.CLOSE_BLOCK);

    // Content is e.g. "for item of items" or "for item, i of items"
    const rawContent = contentToken.value.trim();
    if (!rawContent.startsWith("for")) {
      throw new ParseError(
        `Expected "for <var> of <iterable>", got "${rawContent}"`,
        contentToken,
        this.source
      );
    }

    const forBody = rawContent.slice("for".length).trim();

    // Locate " of " separator.  We search for ` of ` with surrounding spaces
    // to avoid false positives inside expressions like "offer".
    const ofMatch = / of /.exec(forBody);
    if (ofMatch === null || ofMatch.index === undefined) {
      throw new ParseError(
        `Invalid "for" syntax — expected "for <var> of <iterable>", got: "{% ${rawContent} %}"`,
        contentToken,
        this.source
      );
    }

    const matchIndex = ofMatch.index;
    const matchLength = ofMatch[0]?.length ?? 4; // " of " is 4 characters
    const lhs = forBody.slice(0, matchIndex).trim();
    const iterable = forBody.slice(matchIndex + matchLength).trim();

    if (lhs.length === 0) {
      throw new ParseError(
        '"for" loop is missing the loop variable name',
        contentToken,
        this.source
      );
    }
    if (iterable.length === 0) {
      throw new ParseError(
        '"for" loop is missing the iterable expression',
        contentToken,
        this.source
      );
    }

    let variable: string;
    let indexVariable: string | null = null;

    if (lhs.includes(",")) {
      const parts = lhs.split(",").map((p) => p.trim());
      variable = parts[0] ?? lhs;
      indexVariable = parts[1] !== undefined && parts[1].length > 0
        ? parts[1]
        : null;
    } else {
      variable = lhs;
    }

    // Validate identifiers (must be valid JS identifier characters).
    this.assertIdentifier(variable, contentToken);
    if (indexVariable !== null) {
      this.assertIdentifier(indexVariable, contentToken);
    }

    // Parse the loop body — stop at `endfor`.
    const body = this.parseChildren("for");

    // Consume {% endfor %}.
    this.expectBlock("endfor");
    const closeToken = this.advance(); // consume CLOSE_BLOCK of endfor

    return {
      type: "For",
      variable,
      indexVariable,
      iterable,
      body,
      span: this.makeSpan(openToken, closeToken),
    };
  }

  // -------------------------------------------------------------------------
  // Set node  {% set variable = expression %}
  // -------------------------------------------------------------------------

  private parseSet(): SetNode {
    const openToken = this.consume(TokenType.OPEN_BLOCK);
    const contentToken = this.consume(TokenType.BLOCK_CONTENT);
    const closeToken = this.consume(TokenType.CLOSE_BLOCK);

    const rawContent = contentToken.value.trim();
    if (!rawContent.startsWith("set")) {
      throw new ParseError(
        `Expected "set <var> = <expr>", got "${rawContent}"`,
        contentToken,
        this.source
      );
    }

    const body = rawContent.slice("set".length).trim();

    // Locate the first `=` sign (not `==` or `===`).
    const eqIndex = this.findAssignmentEquals(body);
    if (eqIndex === -1) {
      throw new ParseError(
        `Invalid "set" syntax — expected "set <var> = <expr>", got: "{% ${rawContent} %}"`,
        contentToken,
        this.source
      );
    }

    const variable = body.slice(0, eqIndex).trim();
    const expression = body.slice(eqIndex + 1).trim();

    if (variable.length === 0) {
      throw new ParseError(
        '"set" is missing the variable name',
        contentToken,
        this.source
      );
    }
    if (expression.length === 0) {
      throw new ParseError(
        '"set" is missing the value expression',
        contentToken,
        this.source
      );
    }

    this.assertIdentifier(variable, contentToken);

    return {
      type: "Set",
      variable,
      expression,
      span: this.makeSpan(openToken, closeToken),
    };
  }

  // -------------------------------------------------------------------------
  // Include node  {% include "path" [with expr] %}
  // -------------------------------------------------------------------------

  private parseInclude(): IncludeNode {
    const openToken = this.consume(TokenType.OPEN_BLOCK);
    const contentToken = this.consume(TokenType.BLOCK_CONTENT);
    const closeToken = this.consume(TokenType.CLOSE_BLOCK);

    const rawContent = contentToken.value.trim();
    if (!rawContent.startsWith("include")) {
      throw new ParseError(
        `Expected "include <path>", got "${rawContent}"`,
        contentToken,
        this.source
      );
    }

    const body = rawContent.slice("include".length).trim();

    // Optional `with expression` clause.
    const withIndex = body.indexOf(" with ");
    let pathRaw: string;
    let contextExpression: string | null = null;

    if (withIndex !== -1) {
      pathRaw = body.slice(0, withIndex).trim();
      contextExpression = body.slice(withIndex + " with ".length).trim();
    } else {
      pathRaw = body;
    }

    if (pathRaw.length === 0) {
      throw new ParseError(
        '"include" is missing the template path',
        contentToken,
        this.source
      );
    }

    // Strip surrounding single or double quotes.
    const path = pathRaw.replace(/^(['"])(.*)\1$/, "$2");

    return {
      type: "Include",
      path,
      contextExpression,
      span: this.makeSpan(openToken, closeToken),
    };
  }

  // -------------------------------------------------------------------------
  // Comment node  {# text #}
  // -------------------------------------------------------------------------

  private parseComment(): CommentNode {
    const openToken = this.consume(TokenType.OPEN_COMMENT);

    let content = "";
    if (this.check(TokenType.COMMENT_CONTENT)) {
      content = this.consume(TokenType.COMMENT_CONTENT).value;
    }

    const closeToken = this.consume(TokenType.CLOSE_COMMENT);

    return {
      type: "Comment",
      content,
      span: this.makeSpan(openToken, closeToken),
    };
  }

  // -------------------------------------------------------------------------
  // Token utilities
  // -------------------------------------------------------------------------

  /** Return the current token without consuming it. */
  private current(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) {
      // Should not happen in a well-formed stream, but guard for safety.
      const last = this.tokens[this.tokens.length - 1];
      if (last === undefined) {
        throw new Error(
          "Parser: empty token stream — did you forget to add an EOF token?"
        );
      }
      return last;
    }
    return token;
  }

  /** Consume and return the current token regardless of type. */
  private advance(): Token {
    const token = this.current();
    this.pos++;
    return token;
  }

  /** Return `true` if the current token has the given type. */
  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  /** Return `true` if the current token is EOF. */
  private isEOF(): boolean {
    return this.current().type === TokenType.EOF;
  }

  /**
   * Consume the current token if its type matches `type`, or throw.
   */
  private consume(type: TokenType): Token {
    const token = this.current();
    if (token.type !== type) {
      throw new ParseError(
        `Expected ${this.tokenTypeName(type)}, got ${this.tokenTypeName(token.type)} ("${token.value}")`,
        token,
        this.source
      );
    }
    this.pos++;
    return token;
  }

  /**
   * Peek at the first keyword inside the next `{% ... %}` block without
   * consuming any tokens. Returns `null` if the next token is not `OPEN_BLOCK`
   * or if the block has no keyword.
   */
  private peekBlockKeyword(): string | null {
    if (!this.check(TokenType.OPEN_BLOCK)) return null;

    // The token after OPEN_BLOCK is either BLOCK_CONTENT or CLOSE_BLOCK.
    const contentToken = this.tokens[this.pos + 1];
    if (contentToken?.type !== TokenType.BLOCK_CONTENT) return null;

    const firstWord = contentToken.value.trim().split(/\s+/)[0];
    return firstWord ?? null;
  }

  /**
   * Consume an entire `{% keyword %}` block, asserting the keyword matches
   * `expected`.  Leaves the parser positioned after `CLOSE_BLOCK`.
   *
   * Used internally before the caller consumes CLOSE_BLOCK itself to get the
   * end token.  Because we want the caller to hold the CLOSE_BLOCK token for
   * span construction, this method consumes only OPEN_BLOCK and BLOCK_CONTENT.
   */
  private expectBlock(expectedKeyword: string): void {
    const openToken = this.consume(TokenType.OPEN_BLOCK);
    const contentToken = this.current();

    if (contentToken.type !== TokenType.BLOCK_CONTENT) {
      throw new ParseError(
        `Expected "{% ${expectedKeyword} %}", but block has no content`,
        openToken,
        this.source
      );
    }

    const keyword = contentToken.value.trim();
    if (keyword !== expectedKeyword) {
      throw new ParseError(
        `Expected "{% ${expectedKeyword} %}", got "{% ${keyword} %}"`,
        contentToken,
        this.source
      );
    }

    this.advance(); // consume BLOCK_CONTENT
    // Caller will advance past CLOSE_BLOCK.
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  /**
   * Locate the index of a bare `=` sign that represents assignment (not `==`
   * or `===`). Returns -1 if not found.
   */
  private findAssignmentEquals(text: string): number {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "=") {
        const next = text[i + 1];
        const prev = text[i - 1];
        // Skip `==` and `===`, also skip `!=`, `<=`, `>=`.
        if (next === "=" || prev === "!" || prev === "<" || prev === ">") {
          continue;
        }
        return i;
      }
    }
    return -1;
  }

  /**
   * Assert that `name` looks like a valid JavaScript identifier.
   * Throws `ParseError` if it does not.
   */
  private assertIdentifier(name: string, token: Token): void {
    if (!/^[a-zA-Z_$][a-zA-Z_$\d]*$/.test(name)) {
      throw new ParseError(
        `"${name}" is not a valid identifier`,
        token,
        this.source
      );
    }
  }

  // -------------------------------------------------------------------------
  // Span helpers
  // -------------------------------------------------------------------------

  private makeSpan(startToken: Token, endToken: Token): Span {
    return {
      start: startToken.span.start,
      end: endToken.span.end,
    };
  }

  // -------------------------------------------------------------------------
  // Debug helpers
  // -------------------------------------------------------------------------

  private tokenTypeName(type: TokenType): string {
    const names: Record<number, string> = {
      [TokenType.TEXT]: "TEXT",
      [TokenType.OPEN_EXPR]: "OPEN_EXPR ({{)",
      [TokenType.EXPRESSION_CONTENT]: "EXPRESSION_CONTENT",
      [TokenType.CLOSE_EXPR]: "CLOSE_EXPR (}})",
      [TokenType.OPEN_BLOCK]: "OPEN_BLOCK ({%)",
      [TokenType.BLOCK_CONTENT]: "BLOCK_CONTENT",
      [TokenType.CLOSE_BLOCK]: "CLOSE_BLOCK (%})",
      [TokenType.OPEN_COMMENT]: "OPEN_COMMENT ({#)",
      [TokenType.COMMENT_CONTENT]: "COMMENT_CONTENT",
      [TokenType.CLOSE_COMMENT]: "CLOSE_COMMENT (#})",
      [TokenType.FRONTMATTER_FENCE]: "FRONTMATTER_FENCE (---)",
      [TokenType.FRONTMATTER_CONTENT]: "FRONTMATTER_CONTENT",
      [TokenType.EOF]: "EOF",
    };
    return names[type] ?? `UNKNOWN(${type})`;
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Parse a thtml source string into a {@link RootNode} AST.
 *
 * This convenience function runs both the lexer and the parser in sequence.
 *
 * @example
 * ```ts
 * import { parse } from '@thtml/core';
 *
 * const ast = parse('<h1>{{ title }}</h1>');
 * ```
 */
export function parse(source: string): RootNode;

/**
 * Parse a pre-tokenized stream into a {@link RootNode} AST.
 *
 * This overload is useful when you already have tokens from {@link tokenize}
 * and want to avoid re-lexing (e.g., for incremental parsing).
 *
 * @param tokens - Token stream produced by {@link tokenize}
 * @param source - Original source string (used only for error messages)
 */
export function parse(tokens: readonly Token[], source: string): RootNode;

export function parse(
  sourceOrTokens: string | readonly Token[],
  source?: string
): RootNode {
  if (typeof sourceOrTokens === "string") {
    const tokens = tokenize(sourceOrTokens);
    return new Parser(tokens, sourceOrTokens).parse();
  }
  return new Parser(sourceOrTokens, source ?? "").parse();
}

// Re-export node types so consumers can import from a single location.
export type { AnyNode, RootNode };
