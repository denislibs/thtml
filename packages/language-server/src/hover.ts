/**
 * Hover provider for the thtml language server.
 *
 * When the user hovers over a token inside a template expression the provider
 * queries the TypeScript Language Service to obtain the inferred type and
 * documentation for that position.  For tokens outside an expression (block
 * keywords, built-in loop variables) it falls back to a static documentation
 * table.
 */

import {
  Hover,
  MarkupKind,
  type HoverParams,
  type TextDocuments,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import ts from "typescript";
import { ThtmlDocument } from "./thtml-document.js";
import { TemplateTypeChecker } from "./type-checker.js";

// ---------------------------------------------------------------------------
// Static documentation tables
// ---------------------------------------------------------------------------

const KEYWORD_DOCS: Readonly<Record<string, string>> = {
  if: [
    "**`{% if condition %}`**",
    "",
    "Renders the block only when `condition` is truthy.",
    "",
    "```thtml",
    "{% if isAdmin %}",
    "  <p>Admin panel</p>",
    "{% else %}",
    "  <p>Regular content</p>",
    "{% endif %}",
    "```",
  ].join("\n"),

  else: [
    "**`{% else %}`**",
    "",
    "Optional else branch. Must appear inside an `{% if %}` block.",
  ].join("\n"),

  endif: [
    "**`{% endif %}`**",
    "",
    "Closes an `{% if %}` / `{% else %}` block.",
  ].join("\n"),

  for: [
    "**`{% for variable of iterable %}`**",
    "",
    "Iterates over each element of `iterable`.",
    "Optionally captures the index: `{% for item, index of items %}`",
    "",
    "```thtml",
    "{% for item of items %}",
    "  <li>{{ item }}</li>",
    "{% endfor %}",
    "```",
  ].join("\n"),

  endfor: [
    "**`{% endfor %}`**",
    "",
    "Closes a `{% for %}` loop block.",
  ].join("\n"),

  include: [
    "**`{% include \"path\" %}`**",
    "",
    "Includes a partial thtml template.",
    "The path is resolved relative to the current file.",
    "",
    "```thtml",
    '{% include "partials/header.thtml" %}',
    "```",
    "",
    "With context override:",
    "```thtml",
    '{% include "partials/card.thtml" with card %}',
    "```",
  ].join("\n"),

  set: [
    "**`{% set variable = expression %}`**",
    "",
    "Assigns the result of `expression` to a local template variable.",
    "",
    "```thtml",
    "{% set greeting = 'Hello, ' + user.name %}",
    "<p>{{ greeting }}</p>",
    "```",
  ].join("\n"),
};

const LOOP_DOCS: Readonly<Record<string, string>> = {
  "loop.index": "`loop.index` — 0-based index of the current iteration",
  "loop.index1": "`loop.index1` — 1-based index of the current iteration",
  "loop.first": "`loop.first` — `true` on the first iteration",
  "loop.last": "`loop.last` — `true` on the last iteration",
  "loop.length": "`loop.length` — total number of items in the current loop",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWordAtOffset(source: string, offset: number): string {
  const wordChars = /[\w.]/;
  let start = offset;
  let end = offset;

  while (start > 0 && wordChars.test(source[start - 1] ?? "")) {
    start--;
  }
  while (end < source.length && wordChars.test(source[end] ?? "")) {
    end++;
  }

  return source.slice(start, end);
}

/**
 * Convert the `displayParts` array from a TypeScript QuickInfo to a plain
 * string, then wrap it in a fenced TypeScript code block for Markdown rendering.
 */
function quickInfoToMarkdown(info: ts.QuickInfo): string {
  const typeText = (info.displayParts ?? [])
    .map((p) => p.text)
    .join("");

  const docText = (info.documentation ?? [])
    .map((p) => p.text)
    .join("");

  const lines: string[] = [];

  if (typeText.length > 0) {
    lines.push("```typescript", typeText, "```");
  }

  if (docText.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(docText);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HoverProvider
// ---------------------------------------------------------------------------

export class HoverProvider {
  /**
   * Main entry point called by the LSP server for `textDocument/hover`.
   *
   * `thtmlDocs` maps document URI to the ThtmlDocument instance.
   * `checker` is the shared TemplateTypeChecker.
   */
  getHover(
    params: HoverParams,
    documents: TextDocuments<TextDocument>,
    thtmlDocs: ReadonlyMap<string, ThtmlDocument>,
    checker: TemplateTypeChecker
  ): Hover | null {
    const doc = documents.get(params.textDocument.uri);
    if (doc === undefined) return null;

    const source = doc.getText();
    const offset = doc.offsetAt(params.position);

    // 1. Try TypeScript-backed hover first (only inside expressions).
    const thtmlDoc = thtmlDocs.get(params.textDocument.uri);
    if (thtmlDoc !== undefined) {
      const tsHover = this.typescriptHover(offset, thtmlDoc, checker);
      if (tsHover !== null) return tsHover;
    }

    // 2. Fall back to static keyword / loop-variable documentation.
    const word = getWordAtOffset(source, offset);
    if (word.length === 0) return null;

    const keywordDoc = KEYWORD_DOCS[word];
    if (keywordDoc !== undefined) {
      return {
        contents: { kind: MarkupKind.Markdown, value: keywordDoc },
      };
    }

    const loopDoc = LOOP_DOCS[word];
    if (loopDoc !== undefined) {
      return {
        contents: { kind: MarkupKind.Markdown, value: loopDoc },
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // TypeScript-backed hover
  // ---------------------------------------------------------------------------

  private typescriptHover(
    thtmlOffset: number,
    thtmlDoc: ThtmlDocument,
    checker: TemplateTypeChecker
  ): Hover | null {
    const virtualOffset = thtmlDoc.thtmlOffsetToVirtual(thtmlOffset);
    if (virtualOffset === null) return null;

    const quickInfo = checker.getTypeAtPosition(
      thtmlDoc.virtualFile,
      virtualOffset
    );
    if (quickInfo === undefined) return null;

    const markdownText = quickInfoToMarkdown(quickInfo);
    if (markdownText.length === 0) return null;

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: markdownText,
      },
    };
  }
}
