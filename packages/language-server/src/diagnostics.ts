/**
 * Diagnostics provider for the thtml language server.
 *
 * Combines two diagnostic sources:
 *
 * 1. **Parse diagnostics** — lexer and parser errors from @thtml/core.
 *    These appear immediately when the .thtml file has malformed syntax (e.g.
 *    unclosed `{% if %}`, unknown block keyword, empty expression).
 *
 * 2. **TypeScript diagnostics** — syntactic + semantic errors reported by the
 *    TypeScript Language Service on the virtual TypeScript file.  These catch
 *    issues such as accessing a property that does not exist on the context
 *    type, wrong argument types, etc.
 *
 * Diagnostics from the virtual file are translated back to .thtml source
 * positions using `ThtmlDocument.virtualOffsetToThtml`.
 */

import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  type Connection,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { LexerError, ParseError, tokenize, parse } from "@thtml/core";
import ts from "typescript";
import { ThtmlDocument } from "./thtml-document.js";
import { TemplateTypeChecker } from "./type-checker.js";

// ---------------------------------------------------------------------------
// Range construction helpers
// ---------------------------------------------------------------------------

/**
 * Build a zero-indexed LSP Range from a 0-based byte offset + length.
 */
function offsetRange(doc: TextDocument, offset: number, length: number): Range {
  const start = doc.positionAt(offset);
  const end = doc.positionAt(offset + Math.max(length, 1));
  return { start, end };
}

/**
 * Build a zero-indexed LSP Range from 1-based line/column coordinates.
 * thtml's lexer/parser uses 1-based line numbers and 0-based columns.
 */
function lineColRange(line: number, column: number, length = 1): Range {
  const start = { line: line - 1, character: column };
  const end = { line: line - 1, character: column + Math.max(length, 1) };
  return { start, end };
}

// ---------------------------------------------------------------------------
// Parse diagnostics
// ---------------------------------------------------------------------------

/**
 * Run the thtml lexer and parser on `source` and return any diagnostics.
 * Returns an empty array when the document parses cleanly.
 */
function parseDiagnostics(source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  let tokens;
  try {
    tokens = tokenize(source);
  } catch (err) {
    if (err instanceof LexerError) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: lineColRange(
          err.position.line,
          err.position.column
        ),
        message: err.message,
        source: "thtml",
        code: "lexer-error",
      });
    } else {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: lineColRange(1, 0),
        message: `Unexpected lexer error: ${String(err)}`,
        source: "thtml",
        code: "internal-error",
      });
    }
    return diagnostics;
  }

  try {
    parse(tokens, source);
  } catch (err) {
    if (err instanceof ParseError) {
      const tok = err.token;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: lineColRange(
          tok.span.start.line,
          tok.span.start.column,
          tok.value.length || 1
        ),
        message: err.userMessage,
        source: "thtml",
        code: "parse-error",
      });
    } else {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: lineColRange(1, 0),
        message: `Unexpected parse error: ${String(err)}`,
        source: "thtml",
        code: "internal-error",
      });
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// TypeScript diagnostics
// ---------------------------------------------------------------------------

/**
 * Convert TypeScript `ts.Diagnostic` objects to LSP `Diagnostic` objects.
 * Positions are translated from the virtual TypeScript file back to the
 * .thtml source using `thtmlDoc.virtualOffsetToThtml`.
 */
function typescriptDiagnostics(
  doc: TextDocument,
  thtmlDoc: ThtmlDocument,
  checker: TemplateTypeChecker
): Diagnostic[] {
  const tsDiags = checker.getDiagnostics(thtmlDoc.virtualFile);
  const lspDiags: Diagnostic[] = [];

  for (const tsDiag of tsDiags) {
    if (tsDiag.start === undefined || tsDiag.length === undefined) continue;

    const thtmlOffset = thtmlDoc.virtualOffsetToThtml(tsDiag.start);
    if (thtmlOffset === null) continue; // diagnostic falls outside any expression

    const range = offsetRange(doc, thtmlOffset, tsDiag.length);
    const message = ts.flattenDiagnosticMessageText(tsDiag.messageText, "\n");

    lspDiags.push({
      severity: tsDiagSeverityToLsp(tsDiag.category),
      range,
      message,
      source: "thtml(ts)",
      code: tsDiag.code,
    });
  }

  return lspDiags;
}

function tsDiagSeverityToLsp(category: ts.DiagnosticCategory): DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
    case ts.DiagnosticCategory.Message:
      return DiagnosticSeverity.Information;
  }
}

// ---------------------------------------------------------------------------
// DiagnosticsManager
// ---------------------------------------------------------------------------

export class DiagnosticsManager {
  private readonly documentVersions = new Map<string, number>();

  constructor(private readonly connection: Connection) {}

  /**
   * Recompute diagnostics for `doc` and push them to the client.
   * Short-circuits when the document version has not changed since the last
   * computation to avoid redundant work.
   */
  async updateDiagnostics(
    doc: TextDocument,
    thtmlDocs: ReadonlyMap<string, ThtmlDocument>,
    checker: TemplateTypeChecker
  ): Promise<void> {
    const lastVersion = this.documentVersions.get(doc.uri);
    if (lastVersion === doc.version) return;
    this.documentVersions.set(doc.uri, doc.version);

    const source = doc.getText();
    const diagnostics: Diagnostic[] = [
      // Layer 1: parse errors
      ...parseDiagnostics(source),
    ];

    // Layer 2: TypeScript errors (only when the document parsed successfully
    // and a ThtmlDocument is available).
    const thtmlDoc = thtmlDocs.get(doc.uri);
    if (thtmlDoc !== undefined && thtmlDoc.parsedAst !== null) {
      diagnostics.push(
        ...typescriptDiagnostics(doc, thtmlDoc, checker)
      );
    }

    await this.connection.sendDiagnostics({ uri: doc.uri, diagnostics });
  }

  /** Clear diagnostics when the editor tab is closed. */
  clearDiagnostics(uri: string): void {
    this.documentVersions.delete(uri);
    void this.connection.sendDiagnostics({ uri, diagnostics: [] });
  }
}
