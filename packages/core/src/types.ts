/**
 * Public TypeScript types for the thtml template engine.
 * These types are part of the stable public API surface.
 */

// ---------------------------------------------------------------------------
// Template interface
// ---------------------------------------------------------------------------

/**
 * A compiled, type-safe template.
 *
 * @typeParam TContext - The shape of the data object expected by this template.
 *
 * @example
 * ```ts
 * interface PageContext {
 *   title: string;
 *   user: { name: string };
 * }
 *
 * const tmpl: Template<PageContext> = compile<PageContext>(source);
 * const html = tmpl.render({ title: 'Home', user: { name: 'Alice' } });
 * ```
 */
export interface Template<TContext extends Record<string, unknown>> {
  /**
   * Synchronously render the template with the given context.
   * Returns a complete HTML string.
   */
  render(context: TContext): string;

  /**
   * Asynchronously render the template.
   * Useful when the compile pipeline is augmented with async include loaders.
   */
  renderAsync(context: TContext): Promise<string>;

  /**
   * Phantom type property — never access at runtime.
   * Its sole purpose is to make `Template<A>` and `Template<B>` structurally
   * incompatible when A and B differ, enabling correct type inference.
   */
  readonly contextType: TContext;

  /**
   * The generated JavaScript source code for this template (for debugging).
   * Available on the compiled template object returned by `compile`.
   */
  readonly source?: string;

  /**
   * Raw TypeScript source extracted from the frontmatter block, or null if
   * no frontmatter was present.
   */
  readonly frontmatter?: string | null;
}

// ---------------------------------------------------------------------------
// Compile options
// ---------------------------------------------------------------------------

/**
 * Options controlling template compilation behaviour.
 */
export interface CompileOptions {
  /**
   * Whether `{{ expression }}` values should be HTML-escaped by default.
   *
   * Use `{{ !expression }}` to opt out of escaping on a per-expression basis
   * regardless of this setting.
   *
   * @default true
   */
  escape?: boolean;

  /**
   * In strict mode the renderer throws a runtime error if a required context
   * property resolves to `undefined`.
   *
   * @default false
   */
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// Render options (runtime)
// ---------------------------------------------------------------------------

/**
 * Options that can be passed to the render call to override compile-time settings.
 */
export interface RenderOptions {
  /**
   * Override the compile-time `escape` setting for this particular render call.
   */
  escape?: boolean;
}

// ---------------------------------------------------------------------------
// Loader interface (for include resolution)
// ---------------------------------------------------------------------------

/**
 * A loader is responsible for reading template source files referenced via
 * `{% include "path" %}` directives.
 *
 * Implement this interface to integrate thtml with any file-system or in-memory
 * template store.
 *
 * @example
 * ```ts
 * const fsLoader: TemplateLoader = {
 *   async load(path) {
 *     return fs.readFile(path, 'utf8');
 *   },
 *   resolve(from, to) {
 *     return path.resolve(path.dirname(from), to);
 *   },
 * };
 * ```
 */
export interface TemplateLoader {
  /**
   * Load and return the raw source of the template at `path`.
   */
  load(path: string): string | Promise<string>;

  /**
   * Resolve `includePath` relative to `fromPath` (the including template).
   * Return an absolute or canonical path that can be passed to `load`.
   */
  resolve(fromPath: string, includePath: string): string;
}

// ---------------------------------------------------------------------------
// Diagnostic types (used by language-server and compile-time checks)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface DiagnosticPosition {
  line: number;
  column: number;
  offset: number;
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  start: DiagnosticPosition;
  end: DiagnosticPosition;
  code?: string;
}

// ---------------------------------------------------------------------------
// Parsed template metadata
// ---------------------------------------------------------------------------

/**
 * Metadata returned alongside a compiled template when the full
 * parse-compile pipeline is run (e.g. by the CLI or dev-server).
 */
export interface TemplateMetadata {
  /** Detected dependencies (paths from `{% include %}` directives) */
  dependencies: string[];
  /** Any non-fatal warnings produced during compilation */
  diagnostics: Diagnostic[];
  /** The raw frontmatter TypeScript source, if present */
  frontmatter: string | null;
}
