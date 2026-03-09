/**
 * Completion (autocomplete) provider for the thtml language server.
 *
 * Provides two tiers of completions:
 *
 * 1. **Structural completions** — block keywords (`if`, `for`, …) and
 *    built-in loop variables (`loop.index`, …) based on the cursor context.
 *
 * 2. **TypeScript-backed completions** — property members, method names, and
 *    any other symbol that the TypeScript Language Service can infer from the
 *    frontmatter `interface Context` declaration.  These are returned when the
 *    cursor is inside a `{{ }}` or `{% %}` expression at a position that maps
 *    to the virtual TypeScript file.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  type CompletionParams,
  type TextDocuments,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import ts from "typescript";
import { ThtmlDocument } from "./thtml-document.js";
import { TemplateTypeChecker } from "./type-checker.js";

// ---------------------------------------------------------------------------
// Keyword / builtin definitions
// ---------------------------------------------------------------------------

interface KeywordDef {
  label: string;
  detail: string;
  documentation: string;
  insertText?: string;
}

const BLOCK_KEYWORDS: readonly KeywordDef[] = [
  {
    label: "if",
    detail: "Conditional block",
    documentation:
      "Renders its content only when the condition is truthy.\n\n`{% if condition %}...{% endif %}`",
    insertText: "if ${1:condition} %}\n  $0\n{% endif %}",
  },
  {
    label: "else",
    detail: "Else branch",
    documentation:
      "Optional else branch inside an if block.\n\n`{% else %}`",
    insertText: "else %}",
  },
  {
    label: "endif",
    detail: "End of if block",
    documentation: "Closes an `{% if %}` block.",
    insertText: "endif %}",
  },
  {
    label: "for",
    detail: "Loop block",
    documentation:
      "Iterates over an array or iterable.\n\n`{% for item of items %}...{% endfor %}`",
    insertText: "for ${1:item} of ${2:items} %}\n  $0\n{% endfor %}",
  },
  {
    label: "endfor",
    detail: "End of for block",
    documentation: "Closes a `{% for %}` block.",
    insertText: "endfor %}",
  },
  {
    label: "include",
    detail: "Include a partial template",
    documentation:
      'Includes another thtml file.\n\n`{% include "path/to/partial.thtml" %}`',
    insertText: 'include "${1:path/to/partial.thtml}" %}',
  },
  {
    label: "set",
    detail: "Assign a local variable",
    documentation:
      "Creates or updates a local variable.\n\n`{% set name = expression %}`",
    insertText: "set ${1:name} = ${2:value} %}",
  },
] as const;

const EXPRESSION_BUILTINS: readonly KeywordDef[] = [
  {
    label: "loop.index",
    detail: "Loop index (0-based)",
    documentation: "The 0-based index of the current loop iteration.",
  },
  {
    label: "loop.index1",
    detail: "Loop index (1-based)",
    documentation: "The 1-based index of the current loop iteration.",
  },
  {
    label: "loop.first",
    detail: "Is first iteration",
    documentation: "`true` on the first iteration of a for loop.",
  },
  {
    label: "loop.last",
    detail: "Is last iteration",
    documentation: "`true` on the last iteration of a for loop.",
  },
  {
    label: "loop.length",
    detail: "Total loop length",
    documentation: "Total number of items in the current loop.",
  },
] as const;

// ---------------------------------------------------------------------------
// Cursor context detection
// ---------------------------------------------------------------------------

type CursorContext =
  | { kind: "block" }
  | { kind: "expression" }
  | { kind: "text" };

function getCursorContext(source: string, offset: number): CursorContext {
  const before = source.slice(0, offset);

  const lastOpenBlock = before.lastIndexOf("{%");
  const lastCloseBlock = before.lastIndexOf("%}");
  const lastOpenExpr = before.lastIndexOf("{{");
  const lastCloseExpr = before.lastIndexOf("}}");

  const insideBlock =
    lastOpenBlock !== -1 && lastOpenBlock > lastCloseBlock;
  const insideExpr =
    lastOpenExpr !== -1 && lastOpenExpr > lastCloseExpr;

  if (insideBlock) return { kind: "block" };
  if (insideExpr) return { kind: "expression" };
  return { kind: "text" };
}

// ---------------------------------------------------------------------------
// Partial expression extraction (fallback when AST is unavailable)
// ---------------------------------------------------------------------------

/**
 * Given the raw source and a cursor offset, try to extract the partial
 * expression the user is currently typing inside `{{ }}` or `{% %}`.
 *
 * Returns the trimmed expression text up to the cursor, or `null` when the
 * cursor is not inside any template delimiter.
 */
function extractPartialExpr(source: string, offset: number): string | null {
  const before = source.slice(0, offset);

  const lastOpenExpr = before.lastIndexOf("{{");
  const lastCloseExpr = before.lastIndexOf("}}");
  const lastOpenBlock = before.lastIndexOf("{%");
  const lastCloseBlock = before.lastIndexOf("%}");

  const insideExpr = lastOpenExpr !== -1 && lastOpenExpr > lastCloseExpr;
  const insideBlock = lastOpenBlock !== -1 && lastOpenBlock > lastCloseBlock;

  if (insideExpr && (!insideBlock || lastOpenExpr > lastOpenBlock)) {
    // Inside {{ ... }}: take everything after {{, trim, strip leading !
    const raw = before.slice(lastOpenExpr + 2).trim();
    return raw.startsWith("!") ? raw.slice(1).trimStart() : raw;
  }

  if (insideBlock) {
    // Inside {% ... %}: skip the first keyword, take the rest as expression
    const raw = before.slice(lastOpenBlock + 2).trimStart();
    const spaceIdx = raw.search(/\s/);
    if (spaceIdx === -1) return null; // only keyword typed so far, no expression
    return raw.slice(spaceIdx).trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// TypeScript kind → LSP kind conversion
// ---------------------------------------------------------------------------

function tsKindToLspKind(kind: ts.ScriptElementKind): CompletionItemKind {
  switch (kind) {
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.letElement:
    case ts.ScriptElementKind.constElement:
      return CompletionItemKind.Variable;

    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return CompletionItemKind.Function;

    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Property;

    case ts.ScriptElementKind.interfaceElement:
      return CompletionItemKind.Interface;

    case ts.ScriptElementKind.classElement:
    case ts.ScriptElementKind.localClassElement:
      return CompletionItemKind.Class;

    case ts.ScriptElementKind.typeElement:
    case ts.ScriptElementKind.typeParameterElement:
      return CompletionItemKind.TypeParameter;

    case ts.ScriptElementKind.enumElement:
      return CompletionItemKind.Enum;

    case ts.ScriptElementKind.enumMemberElement:
      return CompletionItemKind.EnumMember;

    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return CompletionItemKind.Module;

    case ts.ScriptElementKind.keyword:
      return CompletionItemKind.Keyword;

    default:
      return CompletionItemKind.Text;
  }
}

// ---------------------------------------------------------------------------
// CompletionProvider
// ---------------------------------------------------------------------------

export class CompletionProvider {
  /**
   * Main entry point called by the LSP server for `textDocument/completion`.
   *
   * `thtmlDocs` maps document URI to the ThtmlDocument instance managed by the
   * server.  `checker` is the shared TemplateTypeChecker instance.
   */
  getCompletions(
    params: CompletionParams,
    documents: TextDocuments<TextDocument>,
    thtmlDocs: ReadonlyMap<string, ThtmlDocument>,
    checker: TemplateTypeChecker
  ): CompletionItem[] {
    const doc = documents.get(params.textDocument.uri);
    if (doc === undefined) return [];

    const source = doc.getText();
    const offset = doc.offsetAt(params.position);
    const ctx = getCursorContext(source, offset);

    switch (ctx.kind) {
      case "block": {
        const structural = this.blockCompletions();
        // Also try TypeScript completions for the expression inside the block
        // (e.g. `{% if user. %}` — offer user's members alongside keywords).
        const thtmlDocBlock = thtmlDocs.get(params.textDocument.uri);
        if (thtmlDocBlock !== undefined) {
          const tsItems = this.typescriptCompletions(offset, thtmlDocBlock, checker, source);
          if (tsItems.length > 0) return [...tsItems, ...structural];
        }
        return structural;
      }

      case "expression": {
        const structural = [
          ...this.expressionBuiltins(),
        ];

        // Attempt TypeScript-backed completions.
        const thtmlDoc = thtmlDocs.get(params.textDocument.uri);
        if (thtmlDoc !== undefined) {
          const tsItems = this.typescriptCompletions(offset, thtmlDoc, checker, source);
          // TypeScript completions take priority; structural items are appended
          // only when TS has nothing to offer.
          if (tsItems.length > 0) return tsItems;
        }

        return structural;
      }

      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // TypeScript-backed completions
  // ---------------------------------------------------------------------------

  private typescriptCompletions(
    thtmlOffset: number,
    thtmlDoc: ThtmlDocument,
    checker: TemplateTypeChecker,
    source: string
  ): CompletionItem[] {
    const virtualOffset = thtmlDoc.thtmlOffsetToVirtual(thtmlOffset);

    if (virtualOffset !== null) {
      return this.completionsAtVirtualOffset(thtmlDoc.virtualFile, virtualOffset, checker);
    }

    // Fallback: the cursor is outside any mapped expression (e.g. the parse
    // failed, or the expression is still being typed).  Extract the partial
    // expression from the raw source and query TS with a temporary virtual file.
    return this.partialExpressionCompletions(thtmlOffset, source, thtmlDoc, checker);
  }

  private completionsAtVirtualOffset(
    virtualFile: string,
    virtualOffset: number,
    checker: TemplateTypeChecker
  ): CompletionItem[] {
    const completionInfo = checker.getCompletions(virtualFile, virtualOffset);
    if (completionInfo === undefined) return [];

    return completionInfo.entries.map((entry): CompletionItem => {
      const item: CompletionItem = {
        label: entry.name,
        kind: tsKindToLspKind(entry.kind),
        sortText: entry.sortText,
      };
      const mods = entry.kindModifiers;
      if (mods !== undefined && mods.length > 0) {
        item.detail = mods;
      }
      if (entry.insertText !== undefined) {
        item.insertText = entry.insertText;
      }
      return item;
    });
  }

  /**
   * Fallback completion path: extract a partial expression from raw source
   * text (when the AST is unavailable or the cursor is between mappings) and
   * synthesise a one-shot virtual TypeScript file to query completions from.
   */
  private partialExpressionCompletions(
    thtmlOffset: number,
    source: string,
    thtmlDoc: ThtmlDocument,
    checker: TemplateTypeChecker
  ): CompletionItem[] {
    const partial = extractPartialExpr(source, thtmlOffset);
    if (partial === null || partial.length === 0) return [];

    const completionInfo = checker.getCompletionsForExpression(
      thtmlDoc.frontmatter,
      partial,
      partial.length
    );
    if (completionInfo === undefined) return [];

    return completionInfo.entries.map((entry): CompletionItem => ({
      label: entry.name,
      kind: tsKindToLspKind(entry.kind),
      sortText: entry.sortText,
    }));
  }

  // ---------------------------------------------------------------------------
  // Structural completions
  // ---------------------------------------------------------------------------

  private blockCompletions(): CompletionItem[] {
    return BLOCK_KEYWORDS.map(
      (kw): CompletionItem => ({
        label: kw.label,
        kind: CompletionItemKind.Keyword,
        detail: kw.detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: kw.documentation,
        },
        insertText: kw.insertText ?? kw.label,
        insertTextFormat: kw.insertText
          ? InsertTextFormat.Snippet
          : InsertTextFormat.PlainText,
      })
    );
  }

  private expressionBuiltins(): CompletionItem[] {
    return EXPRESSION_BUILTINS.map(
      (kw): CompletionItem => ({
        label: kw.label,
        kind: CompletionItemKind.Variable,
        detail: kw.detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: kw.documentation,
        },
      })
    );
  }
}
