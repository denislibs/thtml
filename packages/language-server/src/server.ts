#!/usr/bin/env node
/**
 * thtml Language Server — entry point.
 *
 * Implements the Language Server Protocol (LSP) for `.thtml` files.
 *
 * Features:
 *   - TypeScript-backed completions using the frontmatter `interface Context`
 *   - TypeScript-backed hover (inferred type + JSDoc of any expression)
 *   - Syntax diagnostics (lexer + parser errors from @thtml/core)
 *   - TypeScript type diagnostics mapped back to .thtml positions
 *   - Document sync (incremental)
 *
 * Architecture:
 *   One `TemplateTypeChecker` instance is shared across all documents.
 *   Each open document gets its own `ThtmlDocument` which owns the virtual
 *   TypeScript file and the thtml↔virtual offset mapping.
 *
 * The server communicates via stdio and can be launched by any LSP-compatible
 * client (VS Code extension, Neovim LSP client, etc.).
 */

import {
  createConnection,
  InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type InitializeParams,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

import { CompletionProvider } from "./completion.js";
import { DiagnosticsManager } from "./diagnostics.js";
import { HoverProvider } from "./hover.js";
import { TemplateTypeChecker } from "./type-checker.js";
import { ThtmlDocument } from "./thtml-document.js";

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/** One TS Language Service instance for all documents in this server process. */
const checker = new TemplateTypeChecker();

/** Per-URI thtml document state (AST + virtual file + offset maps). */
const thtmlDocs = new Map<string, ThtmlDocument>();

const completionProvider = new CompletionProvider();
const hoverProvider = new HoverProvider();
const diagnosticsManager = new DiagnosticsManager(connection);

// ---------------------------------------------------------------------------
// Helper — ensure ThtmlDocument exists and is up-to-date
// ---------------------------------------------------------------------------

function getOrCreateThtmlDoc(doc: TextDocument): ThtmlDocument {
  let thtmlDoc = thtmlDocs.get(doc.uri);

  if (thtmlDoc === undefined) {
    thtmlDoc = new ThtmlDocument(doc.uri, doc.getText(), checker);
    thtmlDocs.set(doc.uri, thtmlDoc);
  } else {
    thtmlDoc.update(doc.getText());
  }

  return thtmlDoc;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: true },
      },
      completionProvider: {
        resolveProvider: false,
        // Trigger completion on `.` (property access), `{` (template open),
        // and space (e.g. after `{% if `).
        triggerCharacters: [".", "{", " "],
      },
      hoverProvider: true,
    },
    serverInfo: {
      name: "thtml-language-server",
      version: "0.1.0",
    },
  };
});

connection.onInitialized(() => {
  connection.console.log("thtml language server initialized (TypeScript-backed)");
});

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

documents.onDidOpen(({ document }) => {
  const thtmlDoc = getOrCreateThtmlDoc(document);
  void diagnosticsManager.updateDiagnostics(document, thtmlDocs, checker);
  connection.console.log(
    `thtml: opened ${document.uri}` +
      (thtmlDoc.error !== null ? ` (parse error: ${thtmlDoc.error.message})` : "")
  );
});

documents.onDidChangeContent(({ document }) => {
  getOrCreateThtmlDoc(document);
  void diagnosticsManager.updateDiagnostics(document, thtmlDocs, checker);
});

documents.onDidSave(({ document }) => {
  getOrCreateThtmlDoc(document);
  void diagnosticsManager.updateDiagnostics(document, thtmlDocs, checker);
});

documents.onDidClose(({ document }) => {
  const thtmlDoc = thtmlDocs.get(document.uri);
  if (thtmlDoc !== undefined) {
    thtmlDoc.dispose();
    thtmlDocs.delete(document.uri);
  }
  diagnosticsManager.clearDiagnostics(document.uri);
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

connection.onCompletion((params) => {
  return completionProvider.getCompletions(
    params,
    documents,
    thtmlDocs,
    checker
  );
});

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

connection.onHover((params) => {
  return hoverProvider.getHover(params, documents, thtmlDocs, checker);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

connection.onError((error) => {
  connection.console.error(`Connection error: ${String(error)}`);
});

process.on("uncaughtException", (err) => {
  connection.console.error(`Uncaught exception: ${String(err)}`);
});

process.on("unhandledRejection", (reason) => {
  connection.console.error(`Unhandled rejection: ${String(reason)}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
