/**
 * ThtmlDocument — per-document state for the language server.
 *
 * Responsibilities:
 *   1. Parse the .thtml source with @thtml/core
 *   2. Collect all template expressions from the AST
 *   3. Build a virtual TypeScript file via TemplateTypeChecker
 *   4. Maintain a precise mapping between .thtml source offsets and virtual
 *      TypeScript file offsets so that LSP results can be translated back
 *
 * One `ThtmlDocument` instance corresponds to one open editor tab.
 */

import { parse, type RootNode, type ChildNode, type Span } from "@thtml/core";
import {
  TemplateTypeChecker,
  type ForScopeVar,
  type MappedExpression,
} from "./type-checker.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A template expression together with its source position in the .thtml file
 * and any active `{% for %}` scopes that wrap it.
 */
interface ExtractedExpression {
  /** Raw expression text, e.g. "user.name" or "items" */
  expression: string;
  /** Byte offset of expression[0] inside the .thtml source */
  thtmlOffset: number;
  /**
   * Active for-loop scopes wrapping this expression, ordered outermost first.
   * Used by {@link TemplateTypeChecker.createVirtualFile} to emit correct loop
   * variable declarations and choose the right `void (...)` preamble.
   */
  forScopes: readonly ForScopeVar[];
}

// ---------------------------------------------------------------------------
// ThtmlDocument
// ---------------------------------------------------------------------------

export class ThtmlDocument {
  /** Latest successfully parsed AST, or `null` if the source is invalid. */
  private ast: RootNode | null = null;
  /** Parse/lex error from the last `reparse()` call, if any. */
  private parseError: Error | null = null;
  /** Frontmatter from the last successful parse. Retained across failures. */
  private cachedFrontmatter: string | null = null;

  /**
   * Expressions extracted from the AST, sorted by `thtmlOffset`.
   * Rebuilt on every successful parse.
   */
  private expressions: ExtractedExpression[] = [];

  /**
   * After a successful virtual-file synthesis this contains one entry per
   * extracted expression, giving us the precise virtual → thtml offset pairing
   * needed for bidirectional position translation.
   */
  private mappedExpressions: MappedExpression[] = [];

  /**
   * The name used as the key in TemplateTypeChecker's virtual file map.
   * Derived from the document URI by replacing `.thtml` with `.virtual.ts`.
   */
  private readonly virtualFileName: string;

  constructor(
    /** LSP document URI, e.g. "file:///project/views/index.thtml" */
    public readonly uri: string,
    private content: string,
    private readonly checker: TemplateTypeChecker
  ) {
    this.virtualFileName = uri.replace(/\.thtml$/, ".virtual.ts");
    this.reparse();
  }

  // ---------------------------------------------------------------------------
  // Offset helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the byte offset of `expression` inside the .thtml source, searching
   * within the range described by `span`.
   *
   * For block nodes (If, For, Set) the span covers the entire block including
   * the body.  We limit the search to the first closing delimiter (`%}` or
   * `}}`) to avoid false matches inside the block body.
   *
   * Falls back to `span.start.offset` when the expression cannot be located
   * (should not happen with a well-formed AST).
   */
  private findExpressionOffset(expression: string, span: Span): number {
    const searchFrom = span.start.offset;
    const fullSlice = this.content.slice(searchFrom, span.end.offset);

    // Narrow the search to the first closing delimiter to avoid matching the
    // expression text that may appear later in the block body.
    const closingBlockIdx = fullSlice.indexOf("%}");
    const closingExprIdx = fullSlice.indexOf("}}");
    const closings = [closingBlockIdx, closingExprIdx].filter((i) => i !== -1);
    const narrowTo =
      closings.length > 0
        ? Math.min(...closings) + 2 // include the two-character delimiter itself
        : fullSlice.length;

    const searchSlice = fullSlice.slice(0, narrowTo);
    const idx = searchSlice.indexOf(expression);
    if (idx === -1) return searchFrom;
    return searchFrom + idx;
  }

  // ---------------------------------------------------------------------------
  // Public update API
  // ---------------------------------------------------------------------------

  /**
   * Replace the document content and re-run the parse + virtual-file pipeline.
   * Called on every `textDocument/didChange` notification.
   */
  update(newContent: string): void {
    if (this.content === newContent) return; // no-op if unchanged
    this.content = newContent;
    this.reparse();
  }

  // ---------------------------------------------------------------------------
  // Position translation
  // ---------------------------------------------------------------------------

  /**
   * Translate a cursor offset in the .thtml file to the corresponding offset
   * inside the virtual TypeScript file.
   *
   * The cursor is expected to be somewhere within a template expression, e.g.
   * after `user.` in `{{ user. }}`.  We find the expression whose thtml range
   * contains the cursor and apply a linear delta.
   *
   * Returns `null` when the cursor is not inside any known expression or the
   * AST is unavailable.
   */
  thtmlOffsetToVirtual(thtmlCursorOffset: number): number | null {
    for (const mapped of this.mappedExpressions) {
      const exprStart = mapped.thtmlOffset;
      const exprEnd = exprStart + mapped.expression.length;

      // The cursor may sit anywhere within the expression, including right at
      // the end (e.g. user.| where | is the caret).
      if (thtmlCursorOffset >= exprStart && thtmlCursorOffset <= exprEnd) {
        const delta = thtmlCursorOffset - exprStart;
        return mapped.virtualOffset + delta;
      }
    }

    return null;
  }

  /**
   * Translate a virtual TypeScript file offset back to the .thtml source
   * offset.  Used when converting diagnostic spans from the virtual file.
   *
   * Returns `null` when no mapping exists for `virtualOffset`.
   */
  virtualOffsetToThtml(virtualOffset: number): number | null {
    for (const mapped of this.mappedExpressions) {
      const virtStart = mapped.virtualOffset;
      const virtEnd = virtStart + mapped.expression.length;

      if (virtualOffset >= virtStart && virtualOffset <= virtEnd) {
        const delta = virtualOffset - virtStart;
        return mapped.thtmlOffset + delta;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** The virtual TypeScript file name registered with TemplateTypeChecker. */
  get virtualFile(): string {
    return this.virtualFileName;
  }

  /** The successfully parsed AST, or `null` on parse failure. */
  get parsedAst(): RootNode | null {
    return this.ast;
  }

  /** The last parse / lex error, or `null` when parsing succeeded. */
  get error(): Error | null {
    return this.parseError;
  }

  /** Frontmatter TypeScript source from the last successful parse, or `null`. */
  get frontmatter(): string | null {
    return this.cachedFrontmatter;
  }

  /** Current raw .thtml source text. */
  get text(): string {
    return this.content;
  }

  // ---------------------------------------------------------------------------
  // Private implementation
  // ---------------------------------------------------------------------------

  private reparse(): void {
    try {
      this.ast = parse(this.content);
      this.parseError = null;
      this.cachedFrontmatter = this.ast.frontmatter;
      this.expressions = this.collectExpressions(this.ast);
      this.rebuildVirtualFile();
    } catch (err) {
      this.ast = null;
      this.parseError = err instanceof Error ? err : new Error(String(err));
      this.expressions = [];
      this.mappedExpressions = [];
      // Keep the old virtual file so diagnostics remain visible after a
      // transient syntax error during typing.
      // cachedFrontmatter is intentionally kept from the last good parse so
      // that fallback completions still have type context available.
    }
  }

  private rebuildVirtualFile(): void {
    const { virtualContent, mappedExpressions } = this.checker.createVirtualFile(
      this.ast?.frontmatter ?? null,
      this.expressions
    );

    this.mappedExpressions = mappedExpressions;
    this.checker.updateVirtualFile(this.virtualFileName, virtualContent);
  }

  /**
   * Walk the AST and collect every expression node in document order.
   * This includes:
   *   - `{{ expr }}` interpolations (ExpressionNode and RawExpressionNode)
   *   - `{% if condition %}` conditions (IfNode)
   *   - `{% for item of iterable %}` iterables (ForNode)
   *   - `{% set var = expr %}` value expressions (SetNode)
   *   - `{% include path with expr %}` context expressions (IncludeNode)
   *
   * For each node, `thtmlOffset` is the byte offset of the first character of
   * the expression string inside the raw .thtml source.  Because the AST span
   * covers the full tag delimiter (e.g. `{{` or `{%`), we search within the
   * span to locate the exact expression position.
   */
  private collectExpressions(root: RootNode): ExtractedExpression[] {
    const result: ExtractedExpression[] = [];

    const walk = (
      children: readonly ChildNode[],
      forScopes: readonly ForScopeVar[]
    ): void => {
      for (const child of children) {
        switch (child.type) {
          case "Expression":
          case "RawExpression":
            result.push({
              expression: child.expression,
              thtmlOffset: this.findExpressionOffset(
                child.expression,
                child.span
              ),
              forScopes,
            });
            break;

          case "If":
            result.push({
              expression: child.condition,
              thtmlOffset: this.findExpressionOffset(
                child.condition,
                child.span
              ),
              forScopes,
            });
            walk(child.consequent, forScopes);
            walk(child.alternate, forScopes);
            break;

          case "For": {
            // The iterable expression itself is evaluated in the outer scope.
            result.push({
              expression: child.iterable,
              thtmlOffset: this.findExpressionOffset(
                child.iterable,
                child.span
              ),
              forScopes,
            });
            // Body expressions are evaluated inside the for-loop scope.
            const innerScopes: readonly ForScopeVar[] = [
              ...forScopes,
              {
                variable: child.variable,
                indexVariable: child.indexVariable,
                iterable: child.iterable,
              },
            ];
            walk(child.body, innerScopes);
            break;
          }

          case "Set":
            result.push({
              expression: child.expression,
              thtmlOffset: this.findExpressionOffset(
                child.expression,
                child.span
              ),
              forScopes,
            });
            break;

          case "Include":
            if (child.contextExpression !== null) {
              result.push({
                expression: child.contextExpression,
                thtmlOffset: this.findExpressionOffset(
                  child.contextExpression,
                  child.span
                ),
                forScopes,
              });
            }
            break;

          case "Text":
          case "Comment":
            // No expressions to extract from these node types.
            break;
        }
      }
    };

    walk(root.children, []);
    return result;
  }

  /** Remove this document's virtual file when the editor tab is closed. */
  dispose(): void {
    this.checker.removeVirtualFile(this.virtualFileName);
  }
}
