/**
 * TypeScript Language Service wrapper for thtml template type checking.
 *
 * Maintains a virtual TypeScript file system in memory. Each .thtml document
 * gets a corresponding .virtual.ts file that is synthesized from the
 * frontmatter interface and the extracted template expressions. The TypeScript
 * Language Service then provides completions, diagnostics, and quick-info on
 * those virtual files, and we map the results back to the original .thtml
 * source positions.
 */

import ts from "typescript";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Describes a single `{% for var of iterable %}` scope that wraps an
 * extracted expression.  Used to emit correct TypeScript variable declarations
 * so that loop variables are typed properly in the virtual file.
 */
export interface ForScopeVar {
  /** The loop variable name, e.g. `"item"`. */
  variable: string;
  /** Optional index variable, e.g. `"i"` in `{% for item, i of items %}`. */
  indexVariable: string | null;
  /**
   * The raw iterable expression from the template, e.g. `"recentActivity"` or
   * `"post.tags"` for a nested loop.
   */
  iterable: string;
}

/**
 * A single template expression extracted from a .thtml document together with
 * both its position in the virtual TypeScript file and its original position
 * in the .thtml file.
 */
export interface MappedExpression {
  /** The raw expression string, e.g. "user.name" */
  expression: string;
  /**
   * Byte offset of the start of the expression text inside the virtual file.
   * This is the offset of the first character AFTER the `__ctx.` prefix, so
   * it corresponds directly to `expression[0]`.
   */
  virtualOffset: number;
  /** Byte offset of the first character of the expression in the .thtml file */
  thtmlOffset: number;
}

/**
 * Result of `createVirtualFile`. Contains the full synthesized TypeScript
 * source and a list of mapped expressions for position translation.
 */
export interface VirtualFileResult {
  virtualContent: string;
  mappedExpressions: MappedExpression[];
}

// ---------------------------------------------------------------------------
// TemplateTypeChecker
// ---------------------------------------------------------------------------

/**
 * Manages a pool of virtual TypeScript files and exposes the TypeScript
 * Language Service for completions, diagnostics, and hover info.
 *
 * Call `updateVirtualFile` before any query to ensure the service sees the
 * latest synthesized source.
 */
export class TemplateTypeChecker {
  private readonly languageService: ts.LanguageService;
  /**
   * Map from virtual file name to its current source text.
   * Only files in this map are visible to the Language Service.
   */
  private readonly virtualFiles = new Map<string, string>();
  /**
   * Monotonically increasing version counters per file so that the Language
   * Service invalidates its caches correctly on content changes.
   */
  private readonly fileVersions = new Map<string, number>();

  constructor() {
    const self = this;

    const servicesHost: ts.LanguageServiceHost = {
      getScriptFileNames(): string[] {
        return [...self.virtualFiles.keys()];
      },

      getScriptVersion(fileName: string): string {
        return String(self.fileVersions.get(fileName) ?? 0);
      },

      getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
        const content = self.virtualFiles.get(fileName);
        if (content === undefined) return undefined;
        return ts.ScriptSnapshot.fromString(content);
      },

      getCurrentDirectory(): string {
        return process.cwd();
      },

      getCompilationSettings(): ts.CompilerOptions {
        return {
          target: ts.ScriptTarget.ES2022,
          strict: true,
          noEmit: true,
          // Allow top-level type declarations without a module wrapper.
          module: ts.ModuleKind.CommonJS,
          lib: ["lib.es2022.d.ts"],
        };
      },

      getDefaultLibFileName(options: ts.CompilerOptions): string {
        return ts.getDefaultLibFilePath(options);
      },

      fileExists(fileName: string): boolean {
        return self.virtualFiles.has(fileName) || ts.sys.fileExists(fileName);
      },

      readFile(fileName: string): string | undefined {
        return self.virtualFiles.get(fileName) ?? ts.sys.readFile(fileName);
      },

      readDirectory: ts.sys.readDirectory.bind(ts.sys),
    };

    this.languageService = ts.createLanguageService(
      servicesHost,
      ts.createDocumentRegistry()
    );
  }

  // ---------------------------------------------------------------------------
  // Virtual file synthesis
  // ---------------------------------------------------------------------------

  /**
   * Builds the virtual TypeScript source for a .thtml document.
   *
   * The generated structure is:
   * ```ts
   * // <frontmatter interface declarations>
   * declare const __ctx: Context;   // or Record<string,unknown> as fallback
   *
   * // Loop variable declarations (for expressions inside {% for %} blocks)
   * declare const item: (typeof __ctx.recentActivity)[number];
   *
   * void (__ctx.<expr1>);          // context expression
   * void (item.time);              // loop-variable expression (no __ctx. prefix)
   * ```
   *
   * For each expression we record two offsets:
   * - `virtualOffset` — points to expression[0] inside the virtual file
   * - `thtmlOffset`   — points to expression[0] inside the .thtml source
   *
   * Loop variable expressions use `void (expr)` (6-char preamble) instead of
   * `void (__ctx.expr)` (12-char preamble).  `virtualOffset` is adjusted
   * accordingly so position translation remains correct.
   */
  createVirtualFile(
    frontmatter: string | null,
    expressions: ReadonlyArray<{
      expression: string;
      thtmlOffset: number;
      forScopes?: ReadonlyArray<ForScopeVar>;
    }>
  ): VirtualFileResult {
    const lines: string[] = [];
    const mappedExpressions: MappedExpression[] = [];

    // 1. Emit frontmatter (the TypeScript interface declarations).
    if (frontmatter !== null && frontmatter.trim().length > 0) {
      lines.push(frontmatter.trim());
      lines.push("");
    }

    // 2. Declare the context binding.
    const hasContextInterface =
      frontmatter !== null && /interface\s+Context\b/.test(frontmatter);

    if (hasContextInterface) {
      lines.push("declare const __ctx: Context;");
    } else {
      lines.push("declare const __ctx: Record<string, unknown>;");
    }
    lines.push("");

    // 3. Collect all loop variable names across all expressions so we can
    //    determine which identifiers should be accessed without __ctx. prefix.
    const allLoopVarNames = new Set<string>();
    for (const expr of expressions) {
      for (const scope of (expr.forScopes ?? [])) {
        allLoopVarNames.add(scope.variable);
        if (scope.indexVariable !== null) allLoopVarNames.add(scope.indexVariable);
      }
    }

    // 4. Emit one `declare const` per unique loop variable in dependency order
    //    (outermost loop first so inner loop vars can reference outer ones).
    const seenLoopVars = new Set<string>();
    for (const expr of expressions) {
      for (const scope of (expr.forScopes ?? [])) {
        if (seenLoopVars.has(scope.variable)) continue;
        seenLoopVars.add(scope.variable);

        // If the iterable's leading identifier is itself a loop variable (nested
        // loop), access it directly; otherwise prefix with __ctx.
        const iterableFirstIdent =
          scope.iterable.match(/^[a-zA-Z_$][a-zA-Z_$\d]*/)?.[0] ?? "";
        const iterableAccess = allLoopVarNames.has(iterableFirstIdent)
          ? scope.iterable
          : `__ctx.${scope.iterable}`;

        lines.push(
          `declare const ${scope.variable}: (typeof ${iterableAccess})[number];`
        );
        if (scope.indexVariable !== null) {
          lines.push(`declare const ${scope.indexVariable}: number;`);
        }
      }
    }
    if (seenLoopVars.size > 0) lines.push("");

    // Build the partial virtual content up to the expressions section so we
    // can compute accurate byte offsets.
    let prefix = lines.join("\n");

    // 5. Emit one `void` statement per expression.
    for (const { expression, thtmlOffset } of expressions) {
      // If the expression's leading identifier is a loop variable, access it
      // directly (void (expr)); otherwise go through __ctx (void (__ctx.expr)).
      const exprFirstIdent =
        expression.match(/^[a-zA-Z_$][a-zA-Z_$\d]*/)?.[0] ?? "";
      const isLoopVar = allLoopVarNames.has(exprFirstIdent);

      const voidPreamble = isLoopVar ? "void (" : "void (__ctx.";
      const virtualOffset = prefix.length + voidPreamble.length;

      mappedExpressions.push({ expression, virtualOffset, thtmlOffset });

      prefix += `${voidPreamble}${expression});\n`;
    }

    return { virtualContent: prefix, mappedExpressions };
  }

  // ---------------------------------------------------------------------------
  // File management
  // ---------------------------------------------------------------------------

  /** Insert or replace the content of a virtual file. */
  updateVirtualFile(fileName: string, content: string): void {
    const prev = this.virtualFiles.get(fileName);
    if (prev === content) return; // no change → no cache invalidation needed
    const version = (this.fileVersions.get(fileName) ?? 0) + 1;
    this.virtualFiles.set(fileName, content);
    this.fileVersions.set(fileName, version);
  }

  /** Remove a virtual file when its document is closed. */
  removeVirtualFile(fileName: string): void {
    this.virtualFiles.delete(fileName);
    this.fileVersions.delete(fileName);
  }

  // ---------------------------------------------------------------------------
  // Language service queries
  // ---------------------------------------------------------------------------

  /**
   * Returns completion entries at `virtualOffset` inside `virtualFileName`.
   * Returns `undefined` if the Language Service has nothing to offer.
   */
  getCompletions(
    virtualFileName: string,
    virtualOffset: number
  ): ts.CompletionInfo | undefined {
    return (
      this.languageService.getCompletionsAtPosition(
        virtualFileName,
        virtualOffset,
        /* options */ undefined
      ) ?? undefined
    );
  }

  /**
   * Returns combined syntactic + semantic diagnostics for `virtualFileName`.
   */
  getDiagnostics(virtualFileName: string): ts.Diagnostic[] {
    return [
      ...this.languageService.getSyntacticDiagnostics(virtualFileName),
      ...this.languageService.getSemanticDiagnostics(virtualFileName),
    ];
  }

  /**
   * Get completions for a partial expression without permanently modifying
   * any registered virtual file.  Uses a temporary file that is created and
   * removed within this call.
   *
   * Useful for fallback completion when the AST is unavailable or the cursor
   * sits outside all mapped expressions (e.g. the user is mid-typing).
   */
  getCompletionsForExpression(
    frontmatter: string | null,
    expression: string,
    cursorOffset: number
  ): ts.CompletionInfo | undefined {
    const tempName = "__thtml_completion_temp__.virtual.ts";
    const { virtualContent, mappedExpressions } = this.createVirtualFile(
      frontmatter,
      [{ expression, thtmlOffset: 0 }]
    );
    this.updateVirtualFile(tempName, virtualContent);
    try {
      const mapped = mappedExpressions[0];
      if (mapped === undefined) return undefined;
      const virtualOffset = mapped.virtualOffset + cursorOffset;
      return this.getCompletions(tempName, virtualOffset);
    } finally {
      this.removeVirtualFile(tempName);
    }
  }

  /**
   * Returns quick-info (hover type/documentation) at `virtualOffset`.
   * Returns `undefined` when there is nothing to show.
   */
  getTypeAtPosition(
    virtualFileName: string,
    virtualOffset: number
  ): ts.QuickInfo | undefined {
    return (
      this.languageService.getQuickInfoAtPosition(
        virtualFileName,
        virtualOffset
      ) ?? undefined
    );
  }
}
