/**
 * Compiler: transforms a thtml AST into an executable JavaScript function.
 *
 * The generated function accepts a data context object and returns an HTML string.
 * It uses the runtime helpers from `./runtime.ts`.
 *
 * Compilation pipeline:
 *   source -> Lexer -> tokens -> Parser -> AST -> Compiler -> Template function
 *
 * Generated code shape for `<h1>{{ user.name }}</h1>{% if show %}yes{% endif %}`:
 *
 *   with (__ctx) {
 *     const __buf = new __rt.StringBuffer();
 *     __buf.append("<h1>");
 *     __buf.append(__rt.escape(user?.["name"]));
 *     __buf.append("</h1>");
 *     if (show) {
 *       __buf.append("yes");
 *     }
 *     return __buf.toString();
 *   }
 *
 * Key design decisions:
 *   - The function body uses sloppy mode (no "use strict") so `with` works.
 *   - `with (__ctx)` gives every bare identifier access to context properties.
 *   - `{% set x = expr %}` emits `var x = expr` hoisted to the function scope,
 *     making `x` visible to all later expressions inside the `with` block.
 *   - Simple dotted paths (user.name) get optional-chaining for null safety.
 *   - Complex expressions (a > b, items.length + 1) are emitted verbatim.
 */

import {
  type ChildNode,
  type CommentNode,
  type ExpressionNode,
  type ForNode,
  type IfNode,
  type IncludeNode,
  type RawExpressionNode,
  type RootNode,
  type SetNode,
  type TextNode,
} from "./ast.js";
import { tokenize } from "./lexer.js";
import { parse } from "./parser.js";
import {
  createRuntimeContext,
  type RuntimeContext,
} from "./runtime.js";
import type { CompileOptions, Template } from "./types.js";

// ---------------------------------------------------------------------------
// Internal code generation helper
// ---------------------------------------------------------------------------

class CodeGen {
  private readonly lines: string[] = [];
  private indentLevel: number = 0;

  emit(line: string): void {
    this.lines.push("  ".repeat(this.indentLevel) + line);
  }

  push(): void {
    this.indentLevel++;
  }

  pop(): void {
    if (this.indentLevel > 0) this.indentLevel--;
  }

  build(): string {
    return this.lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Compiler class
// ---------------------------------------------------------------------------

export class Compiler {
  private readonly options: Required<CompileOptions>;

  constructor(options: CompileOptions = {}) {
    this.options = {
      escape: options.escape ?? true,
      strict: options.strict ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Compile from AST
  // -------------------------------------------------------------------------

  compileAST<TContext extends Record<string, unknown>>(
    ast: RootNode
  ): Template<TContext> {
    const cg = new CodeGen();

    // Wrap the entire body in `with (__ctx)` so that all bare identifiers
    // (user, items, title, etc.) automatically resolve against the context
    // object.  This also makes `{% set x = ... %}` variables visible to later
    // expressions because `var` declarations are hoisted to the function scope,
    // which is the outer scope of the `with` block.
    //
    // IMPORTANT: `with` requires the generated function to be in sloppy mode.
    // We deliberately omit `"use strict"` from the function body.
    cg.emit("with (__ctx) {");
    cg.push();
    cg.emit("const __buf = new __rt.StringBuffer();");
    cg.emit("");

    this.emitChildren(ast.children, cg, "__buf");

    cg.emit("");
    cg.emit("return __buf.toString();");
    cg.pop();
    cg.emit("}");

    const bodyCode = cg.build();

    // Readable source for debugging and tooling inspection.
    const debugSource = [
      "(function(__ctx, __rt) {",
      bodyCode
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
      "})",
    ].join("\n");

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("__ctx", "__rt", bodyCode) as (
      ctx: TContext,
      rt: RuntimeContext
    ) => string;

    const compilerOptions = this.options;
    const frontmatter = ast.frontmatter ?? null;

    const render = (context: TContext): string => {
      const rt = createRuntimeContext(compilerOptions.escape);
      validateContext(context, compilerOptions.strict);
      // Wrap context in a Proxy so `with (__ctx)` never throws ReferenceError
      // for missing keys. The `has` trap returns true for any non-internal
      // identifier so JS resolves it via the Proxy; `get` returns undefined for
      // absent keys.  Internal names (`__rt`, `__buf`, `__ibuf_*`, etc.) are
      // explicitly excluded so the `with` block doesn't shadow them.
      const proxied = new Proxy(context as Record<string, unknown>, {
        has(_target, key) {
          if (typeof key === "string" && key.startsWith("__")) return false;
          return true;
        },
        get(target, key) { return target[key as string]; },
      }) as TContext;
      try {
        return fn(proxied, rt);
      } catch (err) {
        throw wrapRuntimeError(err);
      }
    };

    const renderAsync = async (context: TContext): Promise<string> =>
      Promise.resolve(render(context));

    return {
      render,
      renderAsync,
      get contextType(): TContext {
        throw new Error(
          "contextType is a type-only property and cannot be accessed at runtime"
        );
      },
      get source(): string {
        return debugSource;
      },
      get frontmatter(): string | null {
        return frontmatter;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Compile from source string
  // -------------------------------------------------------------------------

  compile<TContext extends Record<string, unknown>>(
    source: string
  ): Template<TContext> {
    const tokens = tokenize(source);
    const ast = parse(tokens, source);
    return this.compileAST<TContext>(ast);
  }

  // -------------------------------------------------------------------------
  // AST node emitters
  // -------------------------------------------------------------------------

  private emitChildren(
    children: ChildNode[],
    cg: CodeGen,
    bufName: string
  ): void {
    for (const child of children) {
      this.emitChild(child, cg, bufName);
    }
  }

  private emitChild(node: ChildNode, cg: CodeGen, bufName: string): void {
    switch (node.type) {
      case "Text":
        this.emitText(node, cg, bufName);
        break;
      case "Expression":
        this.emitExpression(node, cg, bufName);
        break;
      case "RawExpression":
        this.emitRawExpression(node, cg, bufName);
        break;
      case "If":
        this.emitIf(node, cg, bufName);
        break;
      case "For":
        this.emitFor(node, cg, bufName);
        break;
      case "Include":
        this.emitInclude(node, cg, bufName);
        break;
      case "Set":
        this.emitSet(node, cg);
        break;
      case "Comment":
        this.emitComment(node, cg);
        break;
    }
  }

  private emitText(node: TextNode, cg: CodeGen, bufName: string): void {
    // JSON.stringify produces a safe JS string literal: handles \n, \", etc.
    cg.emit(`${bufName}.append(${JSON.stringify(node.value)});`);
  }

  private emitExpression(
    node: ExpressionNode,
    cg: CodeGen,
    bufName: string
  ): void {
    const expr = this.resolveExpression(node.expression);
    if (node.escape) {
      cg.emit(`${bufName}.append(__rt.escape(${expr}));`);
    } else {
      cg.emit(`${bufName}.append(__rt.raw(${expr}));`);
    }
  }

  private emitRawExpression(
    node: RawExpressionNode,
    cg: CodeGen,
    bufName: string
  ): void {
    // {{ !expr }} — always emits raw (unescaped) output.
    const expr = this.resolveExpression(node.expression);
    cg.emit(`${bufName}.append(__rt.raw(${expr}));`);
  }

  private emitIf(node: IfNode, cg: CodeGen, bufName: string): void {
    const condition = this.resolveExpression(node.condition);
    cg.emit(`if (${condition}) {`);
    cg.push();
    this.emitChildren(node.consequent, cg, bufName);
    cg.pop();

    if (node.alternate.length > 0) {
      cg.emit("} else {");
      cg.push();
      this.emitChildren(node.alternate, cg, bufName);
      cg.pop();
    }

    cg.emit("}");
  }

  private emitFor(node: ForNode, cg: CodeGen, bufName: string): void {
    // Resolve the iterable expression in the outer (with-scoped) context.
    const iterable = this.resolveExpression(node.iterable);
    const loopVar = sanitizeIdentifier(node.variable);

    // Inner buffer name is mangled with the loop variable to avoid collisions
    // in nested loops (e.g. __ibuf_item, __ibuf_cell).
    const innerBufName = `__ibuf_${loopVar}`;

    // Optional index / meta variable name from `{% for item, index of items %}`.
    const metaParam =
      node.indexVariable !== null
        ? sanitizeIdentifier(node.indexVariable)
        : "__meta";

    // The forEach callback receives (loopVar, metaParam) and must return a string.
    // Closures inside the callback can still see `with (__ctx)` bindings from
    // the outer scope because `with` extends the scope chain of nested functions.
    cg.emit(
      `${bufName}.append(__rt.forEach(${iterable}, function(${loopVar}, ${metaParam}) {`
    );
    cg.push();
    cg.emit(`const ${innerBufName} = new __rt.StringBuffer();`);
    this.emitChildren(node.body, cg, innerBufName);
    cg.emit(`return ${innerBufName}.toString();`);
    cg.pop();
    cg.emit("}));");
  }

  private emitInclude(
    node: IncludeNode,
    cg: CodeGen,
    bufName: string
  ): void {
    // Include resolution requires an external TemplateLoader not available in
    // the basic synchronous runtime.  Emit a comment for dependency analysis.
    cg.emit(
      `/* include "${escapeStringForComment(node.path)}" — requires TemplateLoader */`
    );
    cg.emit(`${bufName}.append("");`);
  }

  private emitSet(node: SetNode, cg: CodeGen): void {
    const varName = sanitizeIdentifier(node.variable);
    // Emit the expression verbatim — `with (__ctx)` makes context properties
    // available, so `{% set x = items.length %}` works correctly.
    // `var` ensures the binding is hoisted to function scope, remaining visible
    // throughout the entire template body (including after endfor, endif, etc.).
    const expr = node.expression.trim();
    cg.emit(`var ${varName} = (${expr});`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private emitComment(_node: CommentNode, _cg: CodeGen): void {
    // Comments are stripped at compile time — no output emitted.
  }

  // -------------------------------------------------------------------------
  // Expression resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a raw expression string to a safe JavaScript expression.
   *
   * Inside `with (__ctx) { ... }`, bare identifiers automatically look up
   * properties on the context object, so most expressions can be emitted
   * verbatim.  The only transformation applied is converting pure dotted paths
   * (e.g. `user.name`) to optional-chaining form (`user?.["name"]`) to guard
   * against null/undefined intermediate values.
   *
   * Complex expressions (operators, comparisons, ternaries, etc.) are passed
   * through unchanged.
   */
  private resolveExpression(expression: string): string {
    const trimmed = expression.trim();

    // Pure dotted path: user, user.name, items.length, a.b.c
    if (/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/.test(trimmed)) {
      return resolveDottedPath(trimmed);
    }

    // Complex expression — emit verbatim; `with(__ctx)` handles scope.
    return trimmed;
  }
}

// ---------------------------------------------------------------------------
// Expression helpers
// ---------------------------------------------------------------------------

/**
 * Rewrite "user.name.first" to `user?.["name"]?.["first"]`.
 *
 * The root identifier is kept bare so that `with (__ctx)` resolves it against
 * the context.  Subsequent segments use optional-chain bracket notation.
 */
function resolveDottedPath(path: string): string {
  const parts = path.split(".");
  const root = parts[0] ?? path;

  if (parts.length === 1) {
    return root;
  }

  let result = root;
  for (const part of parts.slice(1)) {
    result += `?.[${JSON.stringify(part)}]`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Identifier sanitization
// ---------------------------------------------------------------------------

function sanitizeIdentifier(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z_$\d]/g, "_");
  return /^\d/.test(sanitized) ? `_${sanitized}` : sanitized;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeStringForComment(str: string): string {
  return str.replace(/\*\//g, "*\\/");
}

function validateContext(
  context: Record<string, unknown>,
  strict: boolean
): void {
  if (!strict) return;
  if (context === null || context === undefined) {
    throw new Error(
      "thtml strict mode: template context must be a non-null object"
    );
  }
}

function wrapRuntimeError(err: unknown): Error {
  if (err instanceof Error) {
    err.message = `thtml render error: ${err.message}`;
    return err;
  }
  return new Error(`thtml render error: ${String(err)}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a `.thtml` source string into a reusable {@link Template}.
 *
 * @example
 * ```ts
 * const tmpl = compile<{ name: string }>('<h1>Hello, {{ name }}!</h1>');
 * tmpl.render({ name: 'World' }); // '<h1>Hello, World!</h1>'
 * ```
 */
export function compile<TContext extends Record<string, unknown>>(
  source: string,
  options: CompileOptions = {}
): Template<TContext> {
  return new Compiler(options).compile<TContext>(source);
}

/**
 * Compile a pre-parsed AST into a reusable {@link Template}.
 */
export function compileAST<TContext extends Record<string, unknown>>(
  ast: RootNode,
  options: CompileOptions = {}
): Template<TContext> {
  return new Compiler(options).compileAST<TContext>(ast);
}

/**
 * Type-safe alias for {@link compile}.
 *
 * Bind the context type at the call site for compile-time type checking.
 *
 * @example
 * ```ts
 * interface PageContext { title: string; user: { name: string } }
 * const tmpl = defineTemplate<PageContext>('<h1>{{ title }}</h1>');
 * tmpl.render({ title: 'Home', user: { name: 'Alice' } });
 * ```
 */
export function defineTemplate<TContext extends Record<string, unknown>>(
  source: string,
  options: CompileOptions = {}
): Template<TContext> {
  return compile<TContext>(source, options);
}
