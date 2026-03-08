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
   * void (__ctx.<expr1>);
   * void (__ctx.<expr2>);
   * ```
   *
   * For each expression we record two offsets:
   * - `virtualOffset` — points to expression[0] inside the virtual file
   * - `thtmlOffset`   — points to expression[0] inside the .thtml source
   *
   * The mapping is intentional: `__ctx.` is a fixed 7-character prefix for
   * every expression, so `virtualOffset = position_of_open_paren + "__ctx.".length`.
   */
  createVirtualFile(
    frontmatter: string | null,
    expressions: ReadonlyArray<{ expression: string; thtmlOffset: number }>
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

    // Build the partial virtual content up to the expressions section so we
    // can compute accurate byte offsets.
    let prefix = lines.join("\n");

    // 3. Emit one `void` statement per expression.
    for (const { expression, thtmlOffset } of expressions) {
      // `virtualOffset` points to expression[0] inside the virtual file.
      // Layout of each generated line: `void (__ctx.<expression>);\n`
      // The preamble `void (__ctx.` is 12 characters; virtualOffset lands
      // right after it, at the first character of the expression text.
      const voidPreamble = "void (__ctx.";
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
