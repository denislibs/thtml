# @thtml/core

[![npm version](https://img.shields.io/npm/v/@thtml/core)](https://www.npmjs.com/package/@thtml/core)
[![license](https://img.shields.io/npm/l/@thtml/core)](./LICENSE)
[![tests](https://img.shields.io/github/actions/workflow/status/denislibs/thtml/ci.yml?label=tests)](https://github.com/denislibs/thtml/actions)

Core compiler and runtime for the **thtml** HTML template engine.

Compiles `.thtml` source strings (or pre-parsed ASTs) into reusable, type-safe render functions. Zero runtime dependencies.

## Installation

```bash
npm install @thtml/core
# or
pnpm add @thtml/core
# or
yarn add @thtml/core
```

Requires **Node.js 18+**. Ships both ESM (`dist/index.js`) and CJS (`dist/index.cjs`).

## Quick Start

```typescript
import { compile } from '@thtml/core';

interface Context {
  title: string;
  user: { name: string; role: string };
  items: string[];
}

const template = compile<Context>(`
  <h1>{{ title }}</h1>
  <p>Logged in as <strong>{{ user.name }}</strong> ({{ user.role }})</p>
  {% if items.length %}
    <ul>
      {% for item of items %}
        <li>{{ item }}</li>
      {% endfor %}
    </ul>
  {% else %}
    <p>No items found.</p>
  {% endif %}
`);

const html = template.render({
  title: 'Dashboard',
  user: { name: 'Alice', role: 'admin' },
  items: ['Reports', 'Settings', 'Users'],
});

console.log(html);
// <h1>Dashboard</h1>
// <p>Logged in as <strong>Alice</strong> (admin)</p>
// <ul><li>Reports</li><li>Settings</li><li>Users</li></ul>
```

## Template Syntax

### Frontmatter

Declare the TypeScript type of your template context between `---` delimiters at the top of the file. The VS Code extension uses this block to provide autocomplete and type checking.

```thtml
---
interface Context {
  pageTitle: string;
  user: {
    name: string;
    isAdmin: boolean;
  };
  tags: string[];
}
---
<title>{{ pageTitle }}</title>
<p>Hello, {{ user.name }}!</p>
```

Frontmatter is TypeScript — you can define multiple interfaces, type aliases, or import types (when supported by your loader).

When you compile with `compile<Context>(source)` in your application code, TypeScript validates the `render()` call against your declared type. When you open the `.thtml` file in VS Code, the extension reads the same frontmatter to power IntelliSense.

### Expressions: `{{ expr }}`

Output any JavaScript expression. Values are **HTML-escaped by default**.

```thtml
{{ title }}
{{ user.name }}
{{ count + 1 }}
{{ isAdmin ? "Admin" : "User" }}
{{ items.length }}
```

Null and undefined values render as an empty string.

```thtml
{{ missingProperty }}   {# renders "" #}
{{ null }}              {# renders "" #}
```

### Raw Output: `{{ !expr }}`

Prefix the expression with `!` to output the value **without HTML escaping**. Use this when you trust the content and need to embed raw HTML.

```thtml
{# Safe: HTML-escaped #}
{{ userInput }}

{# Unsafe: raw HTML output — only use with trusted content #}
{{ !trustedHtmlContent }}
{{ !article.bodyHtml }}
```

Escaping table for `{{ expr }}`:

| Input | Output |
|-------|--------|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"` | `&quot;` |
| `'` | `&#39;` |
| `` ` `` | `&#96;` |

### Conditionals: `{% if %} / {% else %} / {% endif %}`

Render content conditionally. Any falsy value (`false`, `null`, `undefined`, `0`, `""`) is treated as false.

```thtml
{% if user.isAdmin %}
  <a href="/admin">Admin Panel</a>
{% endif %}
```

With an else branch:

```thtml
{% if items.length %}
  <ul>
    {% for item of items %}<li>{{ item }}</li>{% endfor %}
  </ul>
{% else %}
  <p>No items yet.</p>
{% endif %}
```

Complex conditions are supported:

```thtml
{% if user.age >= 18 %}
  <p>Access granted.</p>
{% endif %}

{% if status === "active" %}
  <span class="badge badge-green">Active</span>
{% else %}
  <span class="badge badge-gray">Inactive</span>
{% endif %}
```

### For Loops: `{% for %} / {% endfor %}`

Iterate over any array or iterable. Renders nothing if the iterable is empty or undefined.

```thtml
<ul>
  {% for product of products %}
    <li>{{ product.name }} — ${{ product.price }}</li>
  {% endfor %}
</ul>
```

#### Loop Meta Variable

Capture loop metadata by providing a second variable name after the item:

```thtml
{% for item, loop of items %}
  <div class="{{ loop.first ? 'first' : '' }} {{ loop.last ? 'last' : '' }}">
    {{ loop.index1 }}. {{ item }}
  </div>
{% endfor %}
```

The meta object has these properties:

| Property | Type | Description |
|----------|------|-------------|
| `index` | `number` | 0-based iteration index |
| `index1` | `number` | 1-based iteration index |
| `first` | `boolean` | `true` on the first iteration |
| `last` | `boolean` | `true` on the last iteration |
| `length` | `number` | Total number of items |

#### Nested Loops

```thtml
{% for row of table %}
  <tr>
    {% for cell of row %}
      <td>{{ cell }}</td>
    {% endfor %}
  </tr>
{% endfor %}
```

### Set: `{% set %}`

Assign a local variable. The variable is available throughout the rest of the template, including after `{% endfor %}` and `{% endif %}` blocks.

```thtml
{% set greeting = "Hello" %}
{% set total = items.length * price %}
{% set isEven = index % 2 === 0 %}

<p>{{ greeting }}, {{ user.name }}!</p>
<p>Total: {{ total }}</p>
```

Inside a loop, use `set` to build derived values:

```thtml
{% for product of products %}
  {% set discounted = product.price * 0.9 %}
  <li>{{ product.name }} — ${{ discounted }}</li>
{% endfor %}
```

### Include: `{% include %}`

Include a partial template file. The included template receives the same context as the parent.

```thtml
{% include "partials/header.thtml" %}

<main>{{ content }}</main>

{% include "partials/footer.thtml" %}
```

Include with a custom context expression:

```thtml
{% include "partials/user-card.thtml" with user %}
{% include "partials/product.thtml" with { name: item.name, price: item.price } %}
```

Include resolution requires a `TemplateLoader` — see the [Advanced](#advanced) section.

### Comments: `{# comment #}`

Template comments are stripped at compile time and never appear in the rendered HTML output.

```thtml
{# This comment will not appear in the output #}

{#
  Multi-line template comments are supported.
  Use them to annotate template sections.
#}

<p>{{ visibleContent }}</p>
```

## API Reference

### `compile<TContext>(source, options?)`

Compile a template source string into a reusable `Template` object.

```typescript
function compile<TContext extends Record<string, unknown>>(
  source: string,
  options?: CompileOptions
): Template<TContext>
```

**Parameters:**

- `source` — The raw template string.
- `options` — Optional `CompileOptions` object.

**Returns:** A `Template<TContext>` with `render()` and `renderAsync()` methods.

**Example:**

```typescript
import { compile } from '@thtml/core';

const tmpl = compile<{ name: string }>('<h1>Hello, {{ name }}!</h1>');
const html = tmpl.render({ name: 'World' });
// '<h1>Hello, World!</h1>'
```

### `defineTemplate<TContext>(source, options?)`

Type-safe alias for `compile`. Prefer this form when declaring templates as module-level constants — the name communicates intent clearly.

```typescript
function defineTemplate<TContext extends Record<string, unknown>>(
  source: string,
  options?: CompileOptions
): Template<TContext>
```

**Example:**

```typescript
import { defineTemplate } from '@thtml/core';

interface EmailContext {
  recipientName: string;
  subject: string;
  body: string;
}

export const emailTemplate = defineTemplate<EmailContext>(`
  <h2>{{ subject }}</h2>
  <p>Dear {{ recipientName }},</p>
  <div>{{ !body }}</div>
`);
```

### `parse(source)`

Parse a template source string into an AST without compiling it.

```typescript
function parse(source: string): RootNode
```

Returns a `RootNode` — the root of the abstract syntax tree. Throws `ParseError` on invalid syntax.

**Example:**

```typescript
import { parse } from '@thtml/core';

const ast = parse('<h1>{{ title }}</h1>{% if show %}yes{% endif %}');
console.log(ast.type);       // "Root"
console.log(ast.children);   // [TextNode, ExpressionNode, TextNode, IfNode]
```

### `tokenize(source)`

Tokenize a template source string into a flat array of `Token` objects.

```typescript
function tokenize(source: string): Token[]
```

Throws `LexerError` on unrecognised input.

**Example:**

```typescript
import { tokenize } from '@thtml/core';

const tokens = tokenize('Hello, {{ name }}!');
// [
//   { type: TokenType.Text, value: 'Hello, ', ... },
//   { type: TokenType.ExprOpen, ... },
//   { type: TokenType.Text, value: ' name ', ... },
//   { type: TokenType.ExprClose, ... },
//   { type: TokenType.Text, value: '!', ... },
// ]
```

### Interface: `Template<TContext>`

The object returned by `compile()` and `defineTemplate()`.

```typescript
interface Template<TContext extends Record<string, unknown>> {
  render(context: TContext): string;
  renderAsync(context: TContext): Promise<string>;
  readonly contextType: TContext;  // type-only, throws at runtime
  readonly source?: string;        // generated JS source (for debugging)
  readonly frontmatter?: string | null;
}
```

**`render(context)`**

Synchronously render the template. Returns a complete HTML string. Throws a `thtml render error` on runtime failures.

```typescript
const html = tmpl.render({ title: 'Home', items: [] });
```

**`renderAsync(context)`**

Asynchronously render the template. Resolves to the same result as `render()`. Use this when your pipeline includes async include loaders.

```typescript
const html = await tmpl.renderAsync({ title: 'Home', items: [] });
```

**`source`**

The generated JavaScript source code as a string, available for debugging and inspection.

```typescript
console.log(tmpl.source);
// (function(__ctx, __rt) {
//   with (__ctx) {
//     const __buf = new __rt.StringBuffer();
//     __buf.append("<h1>");
//     __buf.append(__rt.escape(title));
//     ...
//   }
// })
```

**`frontmatter`**

The raw TypeScript source extracted from the `---` frontmatter block, or `null` if no frontmatter was present.

### Interface: `CompileOptions`

Options passed as the second argument to `compile()` and `defineTemplate()`.

```typescript
interface CompileOptions {
  escape?: boolean;  // default: true
  strict?: boolean;  // default: false
}
```

**`escape`** (default: `true`)

When `true`, all `{{ expr }}` output is HTML-escaped. Set to `false` to disable escaping globally (for trusted content pipelines). The `{{ !expr }}` syntax always bypasses escaping regardless of this setting.

```typescript
// Disable escaping for all expressions (raw pipeline)
const tmpl = compile<{ html: string }>('{{ html }}', { escape: false });
tmpl.render({ html: '<b>bold</b>' }); // '<b>bold</b>'
```

**`strict`** (default: `false`)

When `true`, the renderer throws a `ReferenceError` at runtime if any required context property resolves to `undefined`. Useful for catching missing data early in development.

```typescript
const tmpl = compile<{ title: string }>('{{ title }}', { strict: true });
tmpl.render({} as any); // throws: thtml strict mode: "title" resolved to undefined
```

### Interface: `TemplateLoader`

Implement this interface to resolve and load `{% include %}` directives from any file system or in-memory store.

```typescript
interface TemplateLoader {
  load(path: string): string | Promise<string>;
  resolve(fromPath: string, includePath: string): string;
}
```

**Example — Node.js file system loader:**

```typescript
import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { TemplateLoader } from '@thtml/core';

const fsLoader: TemplateLoader = {
  async load(path) {
    return readFile(path, 'utf8');
  },
  resolve(fromPath, includePath) {
    return resolve(dirname(fromPath), includePath);
  },
};
```

### Interface: `CompileOptions` — full reference

```typescript
interface CompileOptions {
  /**
   * HTML-escape {{ expr }} output by default.
   * Use {{ !expr }} to skip escaping per-expression.
   * @default true
   */
  escape?: boolean;

  /**
   * Throw at runtime when a context property resolves to undefined.
   * @default false
   */
  strict?: boolean;
}
```

## Type Safety

When you pass a type parameter to `compile<TContext>()` or `defineTemplate<TContext>()`, TypeScript enforces the shape of the data object at every `render()` call site.

```typescript
import { compile } from '@thtml/core';

interface PageContext {
  title: string;
  user: { name: string; email: string };
  isPublished: boolean;
}

const page = compile<PageContext>(`<h1>{{ title }}</h1>`);

// Correct usage — no TypeScript errors
page.render({
  title: 'Hello',
  user: { name: 'Alice', email: 'alice@example.com' },
  isPublished: true,
});

// TypeScript error: Property 'title' is missing
page.render({
  user: { name: 'Alice', email: 'alice@example.com' },
  isPublished: true,
});

// TypeScript error: Type 'number' is not assignable to type 'string'
page.render({
  title: 42,
  user: { name: 'Alice', email: 'alice@example.com' },
  isPublished: true,
});
```

### Frontmatter and VS Code

When working with `.thtml` files in VS Code, declare the interface in frontmatter:

```thtml
---
interface Context {
  title: string;
  user: { name: string; email: string };
}
---
<h1>{{ title }}</h1>
<p>{{ user.name }} — {{ user.email }}</p>
```

The VS Code extension reads the frontmatter, synthesizes a virtual TypeScript file, and provides:

- Autocomplete when typing `{{ user.` — shows `name`, `email`
- Hover over `user.name` — shows `(property) name: string`
- Red underline under `{{ user.phone }}` — property does not exist

## XSS Protection

HTML escaping is enabled by default for all `{{ expr }}` expressions. This means user-supplied data is always safe to render directly.

```typescript
const tmpl = compile<{ comment: string }>('<p>{{ comment }}</p>');

tmpl.render({ comment: '<script>alert("xss")</script>' });
// '<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>'
```

To output trusted HTML (for example, pre-rendered Markdown content), use the `!` prefix:

```thtml
{# Safe — user input is escaped #}
<p>{{ userComment }}</p>

{# Trusted — pre-rendered Markdown from your own pipeline #}
<article>{{ !article.renderedHtml }}</article>
```

You can also disable escaping globally for a specific template:

```typescript
const emailTemplate = compile<{ body: string }>('{{ body }}', { escape: false });
```

## Advanced

### `compileAST(ast, options?)`

Compile a pre-parsed AST into a `Template`. Use this when you want to parse and compile in separate steps, or when you need to inspect or transform the AST before compilation.

```typescript
import { parse, compileAST, isExpressionNode } from '@thtml/core';

const source = '<h1>{{ title }}</h1>';
const ast = parse(source);

// Inspect the AST
for (const node of ast.children) {
  if (isExpressionNode(node)) {
    console.log('Expression:', node.expression);  // "title"
    console.log('Escaped:', node.escape);          // true
  }
}

// Compile the (possibly modified) AST
const tmpl = compileAST<{ title: string }>(ast);
tmpl.render({ title: 'Hello' }); // '<h1>Hello</h1>'
```

### AST Type Guards

All AST node types are exported along with type-guard functions for safe narrowing:

```typescript
import {
  isTextNode,
  isExpressionNode,
  isRawExpressionNode,
  isIfNode,
  isForNode,
  isSetNode,
  isIncludeNode,
  isCommentNode,
} from '@thtml/core';
```

### Integration with Build Tools

For production builds, compile templates at build time and export the compiled `Template` objects:

```typescript
// templates/page.ts
import { defineTemplate } from '@thtml/core';

interface PageContext {
  title: string;
  content: string;
}

export const pageTemplate = defineTemplate<PageContext>(`
  <!DOCTYPE html>
  <html>
    <head><title>{{ title }}</title></head>
    <body>{{ !content }}</body>
  </html>
`);
```

```typescript
// routes/page.ts
import { pageTemplate } from '../templates/page.js';

export function renderPage(title: string, content: string): string {
  return pageTemplate.render({ title, content });
}
```

### Runtime Helpers (Advanced)

The following runtime helpers are exported for advanced use cases such as custom code generators or testing:

```typescript
import {
  escapeHtml,      // HTML-escape a single value
  toRaw,           // coerce a value to string without escaping
  forEach,         // iterate with LoopMeta
  safeGet,         // safe nested property access
  StringBuffer,    // mutable string accumulator
  createRuntimeContext,
} from '@thtml/core';
```

## License

MIT
