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
      case "block":
        return this.blockCompletions();

      case "expression": {
        const structural = [
          ...this.expressionBuiltins(),
        ];

        // Attempt TypeScript-backed completions.
        const thtmlDoc = thtmlDocs.get(params.textDocument.uri);
        if (thtmlDoc !== undefined) {
          const tsItems = this.typescriptCompletions(
            offset,
            thtmlDoc,
            checker
          );
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
    checker: TemplateTypeChecker
  ): CompletionItem[] {
    const virtualOffset = thtmlDoc.thtmlOffsetToVirtual(thtmlOffset);
    if (virtualOffset === null) return [];

    const completionInfo = checker.getCompletions(
      thtmlDoc.virtualFile,
      virtualOffset
    );
    if (completionInfo === undefined) return [];

    return completionInfo.entries.map((entry): CompletionItem => ({
      label: entry.name,
      kind: tsKindToLspKind(entry.kind),
      detail: entry.kindModifiers.length > 0 ? entry.kindModifiers : undefined,
      sortText: entry.sortText,
      // Preserve any insert-text from TS (e.g., optional-chaining snippets).
      insertText: entry.insertText,
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
