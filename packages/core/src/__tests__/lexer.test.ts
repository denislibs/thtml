/**
 * Lexer test suite.
 *
 * Tests cover every token type, edge cases, and error conditions.
 * Vitest globals (`describe`, `it`, `expect`) are enabled in vitest.config.ts.
 */

import { describe, expect, it } from "vitest";
import { Lexer, LexerError, TokenType, tokenize } from "../lexer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return only the types from a token array (ignore value and span). */
function types(source: string): TokenType[] {
  return tokenize(source).map((t) => t.type);
}

/** Return only the values from a token array. */
function values(source: string): string[] {
  return tokenize(source).map((t) => t.value);
}

/** Find the first token of the given type. */
function firstOfType(source: string, type: TokenType) {
  return tokenize(source).find((t) => t.type === type);
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

describe("plain text", () => {
  it("emits a single TEXT token for plain HTML", () => {
    const tokens = tokenize("<p>Hello, world!</p>");
    expect(tokens).toHaveLength(2); // TEXT + EOF
    expect(tokens[0]?.type).toBe(TokenType.TEXT);
    expect(tokens[0]?.value).toBe("<p>Hello, world!</p>");
  });

  it("emits EOF as the last token", () => {
    const tokens = tokenize("hello");
    expect(tokens[tokens.length - 1]?.type).toBe(TokenType.EOF);
  });

  it("emits an EOF-only stream for empty input", () => {
    const tokens = tokenize("");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe(TokenType.EOF);
  });

  it("preserves whitespace and newlines in text", () => {
    const src = "  line1\n  line2\n";
    const token = firstOfType(src, TokenType.TEXT);
    expect(token?.value).toBe(src);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter  --- ... ---
// ---------------------------------------------------------------------------

describe("frontmatter", () => {
  const source = `---
interface Context {
  title: string;
}
---
<html></html>`;

  it("emits two FRONTMATTER_FENCE tokens", () => {
    const fences = tokenize(source).filter(
      (t) => t.type === TokenType.FRONTMATTER_FENCE
    );
    expect(fences).toHaveLength(2);
    expect(fences[0]?.value).toBe("---");
    expect(fences[1]?.value).toBe("---");
  });

  it("emits FRONTMATTER_CONTENT with the TypeScript source", () => {
    const content = firstOfType(source, TokenType.FRONTMATTER_CONTENT);
    expect(content?.value).toContain("interface Context");
    expect(content?.value).toContain("title: string;");
  });

  it("emits a TEXT token for content after the closing fence", () => {
    const text = firstOfType(source, TokenType.TEXT);
    expect(text?.value).toContain("<html></html>");
  });

  it("does not emit frontmatter tokens when --- is not at the start", () => {
    const noFrontmatter = "<p>---</p>";
    const ts = tokenize(noFrontmatter);
    expect(ts.some((t) => t.type === TokenType.FRONTMATTER_FENCE)).toBe(false);
  });

  it("handles empty frontmatter block", () => {
    const src = "---\n---\n<p>content</p>";
    const ts = tokenize(src);
    expect(ts.filter((t) => t.type === TokenType.FRONTMATTER_FENCE)).toHaveLength(2);
    expect(ts.some((t) => t.type === TokenType.FRONTMATTER_CONTENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expressions  {{ ... }}
// ---------------------------------------------------------------------------

describe("expression  {{ ... }}", () => {
  it("emits OPEN_EXPR, EXPRESSION_CONTENT, CLOSE_EXPR", () => {
    const ts = types("{{ title }}");
    expect(ts).toEqual([
      TokenType.OPEN_EXPR,
      TokenType.EXPRESSION_CONTENT,
      TokenType.CLOSE_EXPR,
      TokenType.EOF,
    ]);
  });

  it("captures the expression content correctly", () => {
    const content = firstOfType("{{ user.name }}", TokenType.EXPRESSION_CONTENT);
    expect(content?.value.trim()).toBe("user.name");
  });

  it("handles complex expressions", () => {
    const content = firstOfType(
      "{{ items.length + 1 }}",
      TokenType.EXPRESSION_CONTENT
    );
    expect(content?.value.trim()).toBe("items.length + 1");
  });

  it("handles raw expression prefix `!`", () => {
    const content = firstOfType("{{ !rawHtml }}", TokenType.EXPRESSION_CONTENT);
    // The lexer captures the raw content including the `!`; the parser strips it.
    expect(content?.value.trim()).toBe("!rawHtml");
  });

  it("handles expression embedded in text", () => {
    const ts = tokenize("<p>{{ name }}</p>");
    expect(ts.map((t) => t.type)).toEqual([
      TokenType.TEXT,
      TokenType.OPEN_EXPR,
      TokenType.EXPRESSION_CONTENT,
      TokenType.CLOSE_EXPR,
      TokenType.TEXT,
      TokenType.EOF,
    ]);
  });

  it("tracks span.start.line and column for OPEN_EXPR", () => {
    const src = "line1\n{{ x }}";
    const tok = firstOfType(src, TokenType.OPEN_EXPR);
    expect(tok?.span.start.line).toBe(2);
    expect(tok?.span.start.column).toBe(0);
  });

  it("throws LexerError on unclosed expression", () => {
    expect(() => tokenize("{{ unclosed")).toThrow(LexerError);
    expect(() => tokenize("{{ unclosed")).toThrow(/Unclosed expression/);
  });
});

// ---------------------------------------------------------------------------
// Blocks  {% ... %}
// ---------------------------------------------------------------------------

describe("block  {% ... %}", () => {
  it("emits OPEN_BLOCK, BLOCK_CONTENT, CLOSE_BLOCK", () => {
    const ts = types("{% if isAdmin %}");
    expect(ts).toEqual([
      TokenType.OPEN_BLOCK,
      TokenType.BLOCK_CONTENT,
      TokenType.CLOSE_BLOCK,
      TokenType.EOF,
    ]);
  });

  it("captures block content correctly", () => {
    const content = firstOfType("{% if isAdmin %}", TokenType.BLOCK_CONTENT);
    expect(content?.value.trim()).toBe("if isAdmin");
  });

  it("handles for block", () => {
    const content = firstOfType(
      "{% for item of items %}",
      TokenType.BLOCK_CONTENT
    );
    expect(content?.value.trim()).toBe("for item of items");
  });

  it("handles endif/endfor blocks", () => {
    const tsEndif = types("{% endif %}");
    expect(tsEndif).toContain(TokenType.BLOCK_CONTENT);
    const content = firstOfType("{% endif %}", TokenType.BLOCK_CONTENT);
    expect(content?.value.trim()).toBe("endif");
  });

  it("handles set block", () => {
    const content = firstOfType(
      '{% set greeting = "hello" %}',
      TokenType.BLOCK_CONTENT
    );
    expect(content?.value.trim()).toBe('set greeting = "hello"');
  });

  it("handles include block", () => {
    const content = firstOfType(
      '{% include "partials/header.thtml" %}',
      TokenType.BLOCK_CONTENT
    );
    expect(content?.value.trim()).toBe('include "partials/header.thtml"');
  });

  it("throws LexerError on unclosed block", () => {
    expect(() => tokenize("{% unclosed")).toThrow(LexerError);
    expect(() => tokenize("{% unclosed")).toThrow(/Unclosed block/);
  });
});

// ---------------------------------------------------------------------------
// Comments  {# ... #}
// ---------------------------------------------------------------------------

describe("comment  {# ... #}", () => {
  it("emits OPEN_COMMENT, COMMENT_CONTENT, CLOSE_COMMENT", () => {
    const ts = types("{# this is a comment #}");
    expect(ts).toEqual([
      TokenType.OPEN_COMMENT,
      TokenType.COMMENT_CONTENT,
      TokenType.CLOSE_COMMENT,
      TokenType.EOF,
    ]);
  });

  it("captures comment content correctly", () => {
    const content = firstOfType(
      "{# hello world #}",
      TokenType.COMMENT_CONTENT
    );
    expect(content?.value).toBe(" hello world ");
  });

  it("handles empty comment", () => {
    const ts = types("{##}");
    expect(ts).toEqual([
      TokenType.OPEN_COMMENT,
      TokenType.CLOSE_COMMENT,
      TokenType.EOF,
    ]);
  });

  it("throws LexerError on unclosed comment", () => {
    expect(() => tokenize("{# unclosed")).toThrow(LexerError);
    expect(() => tokenize("{# unclosed")).toThrow(/Unclosed comment/);
  });
});

// ---------------------------------------------------------------------------
// Mixed / nested constructs
// ---------------------------------------------------------------------------

describe("mixed constructs", () => {
  const tmpl = `<h1>{{ title }}</h1>
{% if isAdmin %}
  <span>Admin</span>
{% else %}
  <span>User</span>
{% endif %}
{# ignored #}
{% for item of items %}
  <li>{{ item.label }}</li>
{% endfor %}`;

  it("produces the correct token type sequence", () => {
    const ts = tokenize(tmpl);
    const tt = ts.map((t) => t.type);

    // Must contain all delimiter types
    expect(tt).toContain(TokenType.TEXT);
    expect(tt).toContain(TokenType.OPEN_EXPR);
    expect(tt).toContain(TokenType.CLOSE_EXPR);
    expect(tt).toContain(TokenType.OPEN_BLOCK);
    expect(tt).toContain(TokenType.CLOSE_BLOCK);
    expect(tt).toContain(TokenType.OPEN_COMMENT);
    expect(tt).toContain(TokenType.CLOSE_COMMENT);
    expect(tt[tt.length - 1]).toBe(TokenType.EOF);
  });

  it("does not emit empty TEXT tokens", () => {
    const ts = tokenize(tmpl);
    for (const tok of ts) {
      if (tok.type === TokenType.TEXT) {
        expect(tok.value.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Span / position tracking
// ---------------------------------------------------------------------------

describe("span tracking", () => {
  it("OPEN_EXPR span starts at the correct offset", () => {
    const src = "abc{{ x }}";
    const tok = firstOfType(src, TokenType.OPEN_EXPR);
    expect(tok?.span.start.offset).toBe(3); // after 'abc'
  });

  it("CLOSE_EXPR span ends after `}}`", () => {
    const src = "{{ x }}";
    const tok = tokenize(src).find((t) => t.type === TokenType.CLOSE_EXPR);
    expect(tok?.span.end.offset).toBe(src.length);
  });

  it("correctly tracks line numbers across multiple lines", () => {
    const src = "line1\nline2\n{{ x }}";
    const exprTok = firstOfType(src, TokenType.OPEN_EXPR);
    expect(exprTok?.span.start.line).toBe(3);
  });

  it("EOF token has start === end", () => {
    const ts = tokenize("");
    const eof = ts[ts.length - 1];
    expect(eof?.span.start.offset).toBe(eof?.span.end.offset);
  });
});

// ---------------------------------------------------------------------------
// Lexer class API
// ---------------------------------------------------------------------------

describe("Lexer class", () => {
  it("tokenize() is idempotent — calling it twice gives the same result", () => {
    const lexer = new Lexer("<p>{{ x }}</p>");
    const first = lexer.tokenize().map((t) => t.value);
    const second = lexer.tokenize().map((t) => t.value);
    expect(first).toEqual(second);
  });

  it("convenience tokenize() function matches Lexer#tokenize()", () => {
    const src = "{% for item of items %}{{ item }}{% endfor %}";
    const viaFn = tokenize(src);
    const viaClass = new Lexer(src).tokenize();
    expect(viaFn.map((t) => t.value)).toEqual(viaClass.map((t) => t.value));
  });
});
