# thtml

> Type-safe HTML template engine for TypeScript with VS Code support

**thtml** is a fast, type-safe HTML template engine with a Jinja2-inspired syntax. Templates are `.thtml` files where TypeScript types are declared in frontmatter — giving you full autocomplete and type checking directly in your templates.

## Features

- **Type-safe templates** — declare TypeScript context types in frontmatter, get compile-time errors
- **Autocomplete in VS Code** — full IntelliSense inside `{{ }}` and `{% %}` expressions
- **Jinja2-like syntax** — familiar `if`, `for`, `set`, `include`, comments
- **XSS protection** — HTML escaping by default, opt-in raw output with `{{ !expr }}`
- **Zero runtime dependencies** — `@thtml/core` has no runtime dependencies
- **ESM + CJS** — works in Node.js with both module systems

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@thtml/core`](./packages/core) | Template compiler and runtime | [![npm](https://img.shields.io/npm/v/@thtml/core)](https://www.npmjs.com/package/@thtml/core) |
| [`@thtml/language-server`](./packages/language-server) | LSP server for editor integration | [![npm](https://img.shields.io/npm/v/@thtml/language-server)](https://www.npmjs.com/package/@thtml/language-server) |
| [`thtml-vscode`](./packages/vscode-extension) | VS Code extension | [Marketplace](https://marketplace.visualstudio.com/items?itemName=thtml.thtml-vscode) |

## Quick Start

```bash
npm install @thtml/core
```

```typescript
import { compile } from '@thtml/core';

interface Context {
  title: string;
  user: { name: string };
  items: string[];
}

const template = compile<Context>(`
  <h1>{{ title }}</h1>
  <p>Hello, {{ user.name }}!</p>
  <ul>
    {% for item of items %}
      <li>{{ item }}</li>
    {% endfor %}
  </ul>
`);

const html = template.render({
  title: 'My Page',
  user: { name: 'Alice' },
  items: ['One', 'Two', 'Three'],
});
```

## VS Code Extension

Install the **thtml** extension from the VS Code Marketplace for:

- Syntax highlighting in `.thtml` files
- TypeScript autocomplete inside `{{ }}` based on frontmatter types
- Hover type information
- Real-time error diagnostics

Search for **"thtml"** in the Extensions panel, or run:

```
ext install thtml.thtml-vscode
```

## Template Syntax

For the full syntax reference, see [packages/core/README.md](./packages/core/README.md). A brief overview:

| Construct | Syntax | Description |
|-----------|--------|-------------|
| Expression | `{{ expr }}` | Output a value (HTML-escaped) |
| Raw output | `{{ !expr }}` | Output a value without escaping |
| Conditional | `{% if cond %}...{% endif %}` | Conditional block |
| Loop | `{% for item of list %}...{% endfor %}` | Iterate over an array |
| Variable | `{% set x = expr %}` | Assign a local variable |
| Include | `{% include "path.thtml" %}` | Include a partial template |
| Comment | `{# comment #}` | Template comment (stripped from output) |

## Repository Structure

```
thtml/
  packages/
    core/              # @thtml/core — compiler and runtime
    language-server/   # @thtml/language-server — LSP implementation
    vscode-extension/  # thtml-vscode — VS Code extension
```

## Development

This monorepo uses [pnpm workspaces](https://pnpm.io/workspaces).

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type-check all packages
pnpm typecheck

# Watch mode (all packages in parallel)
pnpm dev
```

## License

MIT
