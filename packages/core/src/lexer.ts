/**
 * Lexer (tokenizer) for thtml template syntax.
 *
 * Recognized token sequences (in priority order):
 *
 *   --- frontmatter ---   — TypeScript / interface block at document start
 *   {{ expression }}      — value interpolation (may begin with `!` for raw)
 *   {% block %}           — control-flow block
 *   {# comment #}         — template comment (stripped at compile time)
 *   <everything else>     — literal TEXT passed through unchanged
 *
 * Design decisions:
 *   - `const enum` uses numeric values so it is safe under `module: NodeNext`
 *     (string `const enum` values are inlined by tsc but break in declaration
 *     files when `isolatedModules` or bundlers are involved).
 *   - Every Token carries a full `Span` (start + end Position) so the parser
 *     and downstream tooling can produce precise error messages.
 *   - The lexer is a single-pass, character-by-character scanner with no
 *     backtracking. It throws `LexerError` with a precise source position on
 *     any unrecoverable situation.
 */

import type { Position, Span } from "./ast.js";

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

// NOTE: These are numeric const enum values.  Do NOT change them to strings
// unless you update every consumer — the compiler strips const enums at build
// time so the numeric values appear in the emitted JS.
export const enum TokenType {
  /** Literal HTML / text content between template delimiters */
  TEXT = 0,
  /** Opening `{{` of an expression */
  OPEN_EXPR = 1,
  /** Content between `{{` and `}}` */
  EXPRESSION_CONTENT = 2,
  /** Closing `}}` of an expression */
  CLOSE_EXPR = 3,
  /** Opening `{%` of a block tag */
  OPEN_BLOCK = 4,
  /** Content between `{%` and `%}` */
  BLOCK_CONTENT = 5,
  /** Closing `%}` of a block tag */
  CLOSE_BLOCK = 6,
  /** Opening `{#` of a comment */
  OPEN_COMMENT = 7,
  /** Content between `{#` and `#}` */
  COMMENT_CONTENT = 8,
  /** Closing `#}` of a comment */
  CLOSE_COMMENT = 9,
  /** Opening `---` fence of a frontmatter block */
  FRONTMATTER_FENCE = 10,
  /** Raw TypeScript source inside the frontmatter block */
  FRONTMATTER_CONTENT = 11,
  /** Sentinel token appended at the end of every token stream */
  EOF = 12,
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export interface Token {
  type: TokenType;
  /** Exact source text of this token */
  value: string;
  /** Source range of this token */
  span: Span;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LexerError extends Error {
  constructor(
    message: string,
    public readonly position: Position,
    public readonly source: string
  ) {
    super(
      `LexerError at line ${position.line}, column ${position.column}: ${message}`
    );
    this.name = "LexerError";
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/**
 * Tokenizes a raw `.thtml` source string into a flat array of {@link Token}s.
 *
 * The resulting array always ends with a single `EOF` token.
 *
 * @example
 * ```ts
 * const lexer = new Lexer('<h1>{{ title }}</h1>');
 * const tokens = lexer.tokenize();
 * ```
 */
export class Lexer {
  /** Current byte offset in `source`. */
  private pos: number = 0;
  /** Current 1-based line number. */
  private line: number = 1;
  /** Current 0-based column number within the current line. */
  private column: number = 0;

  private readonly tokens: Token[] = [];

  constructor(private readonly source: string) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run the lexer from the beginning of the source and return all tokens.
   * This method is idempotent — calling it again resets internal state.
   */
  tokenize(): Token[] {
    this.pos = 0;
    this.line = 1;
    this.column = 0;
    this.tokens.length = 0;

    // Frontmatter is only legal at the very beginning of the document.
    this.scanFrontmatter();

    while (!this.isEOF()) {
      this.scanNext();
    }

    const eofPos = this.currentPosition();
    this.tokens.push({
      type: TokenType.EOF,
      value: "",
      span: { start: eofPos, end: eofPos },
    });

    return this.tokens;
  }

  // -------------------------------------------------------------------------
  // Frontmatter scanning  ---...---
  // -------------------------------------------------------------------------

  private scanFrontmatter(): void {
    // Strip optional UTF-8 BOM.
    if (this.source.charCodeAt(this.pos) === 0xfeff) {
      this.advanceRaw(1);
    }

    // Frontmatter must start with `---` immediately (no leading whitespace).
    if (!this.startsWith("---")) return;

    const fenceStart = this.currentPosition();
    this.advanceRaw(3);
    const fenceEnd = this.currentPosition();
    this.pushToken(TokenType.FRONTMATTER_FENCE, "---", fenceStart, fenceEnd);

    // Consume the optional newline after the opening fence.
    this.consumeLineBreak();

    const contentStart = this.currentPosition();
    let content = "";

    while (!this.isEOF()) {
      // The closing fence must be `---` at the start of a line.
      if (this.isAtLineStart() && this.startsWith("---")) {
        break;
      }
      content += this.source[this.pos] ?? "";
      this.advanceChar();
    }

    if (content.length > 0) {
      const contentEnd = this.currentPosition();
      this.pushToken(
        TokenType.FRONTMATTER_CONTENT,
        content,
        contentStart,
        contentEnd
      );
    }

    if (!this.isEOF()) {
      const closeFenceStart = this.currentPosition();
      this.advanceRaw(3);
      const closeFenceEnd = this.currentPosition();
      this.pushToken(
        TokenType.FRONTMATTER_FENCE,
        "---",
        closeFenceStart,
        closeFenceEnd
      );
      // Consume optional newline after the closing fence.
      this.consumeLineBreak();
    }
  }

  // -------------------------------------------------------------------------
  // Main scan dispatcher
  // -------------------------------------------------------------------------

  private scanNext(): void {
    const ch = this.peek(0);
    const next = this.peek(1);

    if (ch === "{") {
      if (next === "{") {
        this.scanExpression();
        return;
      }
      if (next === "%") {
        this.scanBlock();
        return;
      }
      if (next === "#") {
        this.scanComment();
        return;
      }
    }

    this.scanText();
  }

  // -------------------------------------------------------------------------
  // Expression:  {{ ... }}
  // -------------------------------------------------------------------------

  private scanExpression(): void {
    const openStart = this.currentPosition();
    this.advanceRaw(2); // consume `{{`
    const openEnd = this.currentPosition();
    this.pushToken(TokenType.OPEN_EXPR, "{{", openStart, openEnd);

    const contentStart = this.currentPosition();
    let content = "";

    while (!this.isEOF()) {
      if (this.peek(0) === "}" && this.peek(1) === "}") break;
      content += this.source[this.pos] ?? "";
      this.advanceChar();
    }

    if (this.isEOF()) {
      throw new LexerError(
        'Unclosed expression interpolation — expected "}}"',
        openStart,
        this.source
      );
    }

    // Always emit EXPRESSION_CONTENT even if whitespace-only, so the parser
    // can produce a good error message for `{{ }}`.
    if (content.length > 0) {
      const contentEnd = this.currentPosition();
      this.pushToken(
        TokenType.EXPRESSION_CONTENT,
        content,
        contentStart,
        contentEnd
      );
    }

    const closeStart = this.currentPosition();
    this.advanceRaw(2); // consume `}}`
    const closeEnd = this.currentPosition();
    this.pushToken(TokenType.CLOSE_EXPR, "}}", closeStart, closeEnd);
  }

  // -------------------------------------------------------------------------
  // Block:  {% ... %}
  // -------------------------------------------------------------------------

  private scanBlock(): void {
    const openStart = this.currentPosition();
    this.advanceRaw(2); // consume `{%`
    const openEnd = this.currentPosition();
    this.pushToken(TokenType.OPEN_BLOCK, "{%", openStart, openEnd);

    // Skip optional leading whitespace (thtml allows `{%- -%}` style in future
    // but for now we just skip spaces/tabs after the opening delimiter).
    this.skipInlineWhitespace();

    const contentStart = this.currentPosition();
    let content = "";

    while (!this.isEOF()) {
      if (this.peek(0) === "%" && this.peek(1) === "}") break;
      content += this.source[this.pos] ?? "";
      this.advanceChar();
    }

    if (this.isEOF()) {
      throw new LexerError(
        'Unclosed block tag — expected "%}"',
        openStart,
        this.source
      );
    }

    // Trim trailing whitespace from block content for cleaner keyword matching
    // in the parser (preserves content start position).
    const trimmed = content.trimEnd();
    if (trimmed.length > 0) {
      const contentEnd = this.currentPosition();
      // The actual end is current pos (before `%}`), but we record the trimmed
      // length relative to contentStart.offset for span accuracy.
      const adjustedEnd: Position = {
        offset: contentStart.offset + trimmed.length,
        line: contentEnd.line,
        column: contentEnd.column,
      };
      this.pushToken(
        TokenType.BLOCK_CONTENT,
        trimmed,
        contentStart,
        adjustedEnd
      );
    }

    const closeStart = this.currentPosition();
    this.advanceRaw(2); // consume `%}`
    const closeEnd = this.currentPosition();
    this.pushToken(TokenType.CLOSE_BLOCK, "%}", closeStart, closeEnd);
  }

  // -------------------------------------------------------------------------
  // Comment:  {# ... #}
  // -------------------------------------------------------------------------

  private scanComment(): void {
    const openStart = this.currentPosition();
    this.advanceRaw(2); // consume `{#`
    const openEnd = this.currentPosition();
    this.pushToken(TokenType.OPEN_COMMENT, "{#", openStart, openEnd);

    const contentStart = this.currentPosition();
    let content = "";

    while (!this.isEOF()) {
      if (this.peek(0) === "#" && this.peek(1) === "}") break;
      content += this.source[this.pos] ?? "";
      this.advanceChar();
    }

    if (this.isEOF()) {
      throw new LexerError(
        'Unclosed comment — expected "#}"',
        openStart,
        this.source
      );
    }

    if (content.length > 0) {
      const contentEnd = this.currentPosition();
      this.pushToken(
        TokenType.COMMENT_CONTENT,
        content,
        contentStart,
        contentEnd
      );
    }

    const closeStart = this.currentPosition();
    this.advanceRaw(2); // consume `#}`
    const closeEnd = this.currentPosition();
    this.pushToken(TokenType.CLOSE_COMMENT, "#}", closeStart, closeEnd);
  }

  // -------------------------------------------------------------------------
  // Text:  everything up to the next `{{`, `{%`, `{#`
  // -------------------------------------------------------------------------

  private scanText(): void {
    const startPos = this.currentPosition();
    let value = "";

    while (!this.isEOF()) {
      const ch = this.peek(0);
      const next = this.peek(1);
      // Break on any template delimiter opening.
      if (ch === "{" && (next === "{" || next === "%" || next === "#")) break;
      value += this.source[this.pos] ?? "";
      this.advanceChar();
    }

    if (value.length > 0) {
      const endPos = this.currentPosition();
      this.pushToken(TokenType.TEXT, value, startPos, endPos);
    }
  }

  // -------------------------------------------------------------------------
  // Low-level advance helpers
  // -------------------------------------------------------------------------

  /**
   * Advance position by exactly `count` raw bytes, updating line/column
   * tracking for each newline encountered.
   */
  private advanceRaw(count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.pos >= this.source.length) break;
      const ch = this.source[this.pos];
      this.pos++;
      if (ch === "\n") {
        this.line++;
        this.column = 0;
      } else {
        this.column++;
      }
    }
  }

  /**
   * Advance by one character (handles `\r\n` as a single logical newline).
   */
  private advanceChar(): void {
    const ch = this.source[this.pos];
    if (ch === "\r" && this.source[this.pos + 1] === "\n") {
      // CRLF — treat as single newline
      this.pos += 2;
      this.line++;
      this.column = 0;
    } else if (ch === "\n") {
      this.pos++;
      this.line++;
      this.column = 0;
    } else {
      this.pos++;
      this.column++;
    }
  }

  /**
   * Skip spaces and tabs on the current line (does not skip newlines).
   */
  private skipInlineWhitespace(): void {
    while (!this.isEOF()) {
      const ch = this.source[this.pos];
      if (ch === " " || ch === "\t") {
        this.pos++;
        this.column++;
      } else {
        break;
      }
    }
  }

  /**
   * Consume a single line-break (`\n` or `\r\n`) if present at the current
   * position. Used to skip the newline after frontmatter fences.
   */
  private consumeLineBreak(): void {
    const ch = this.source[this.pos];
    if (ch === "\n") {
      this.pos++;
      this.line++;
      this.column = 0;
    } else if (ch === "\r" && this.source[this.pos + 1] === "\n") {
      this.pos += 2;
      this.line++;
      this.column = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  private peek(offset: number): string {
    return this.source[this.pos + offset] ?? "";
  }

  private isEOF(): boolean {
    return this.pos >= this.source.length;
  }

  /**
   * Returns `true` if we are currently at the start of a line.
   * The very start of the source counts as a line start.
   */
  private isAtLineStart(): boolean {
    return this.pos === 0 || this.source[this.pos - 1] === "\n";
  }

  /**
   * Returns `true` if `text` starts at the current position.
   */
  private startsWith(text: string): boolean {
    return this.source.startsWith(text, this.pos);
  }

  // -------------------------------------------------------------------------
  // Position & token emission
  // -------------------------------------------------------------------------

  private currentPosition(): Position {
    return { offset: this.pos, line: this.line, column: this.column };
  }

  private pushToken(
    type: TokenType,
    value: string,
    start: Position,
    end: Position
  ): void {
    this.tokens.push({ type, value, span: { start, end } });
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Tokenize a `.thtml` source string.
 *
 * Returns a flat array of {@link Token}s always terminated by an `EOF` token.
 *
 * @example
 * ```ts
 * import { tokenize } from '@thtml/core';
 * const tokens = tokenize('<h1>{{ title }}</h1>');
 * ```
 */
export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}
