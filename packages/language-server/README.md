# @thtml/language-server

[![npm version](https://img.shields.io/npm/v/@thtml/language-server)](https://www.npmjs.com/package/@thtml/language-server)
[![license](https://img.shields.io/npm/l/@thtml/language-server)](../../LICENSE)

Language Server Protocol (LSP) implementation for **thtml** `.thtml` template files.

> **Note:** If you use VS Code, install the [thtml VS Code extension](https://marketplace.visualstudio.com/items?itemName=thtml.thtml-vscode) instead — it bundles this server automatically.

## Features

- **Autocomplete** — context variables and their properties inside `{{ }}` and `{% %}`, powered by TypeScript types declared in the template frontmatter
- **Hover** — displays the TypeScript type of any expression on hover
- **Diagnostics** — parse errors and TypeScript type errors reported in real time

## How It Works

The server synthesises a virtual `.ts` file from each open `.thtml` document:

```
.thtml file                   Virtual .ts file
─────────────────────────     ──────────────────────────────────
---                           interface Context {
interface Context {             user: { name: string };
  user: { name: string };     }
}                             declare const __ctx: Context;
---
<h1>{{ user.name }}</h1>     void (__ctx.user.name);
```

TypeScript's Language Service runs on the virtual file, and results are mapped back to the original `.thtml` positions.

## For VS Code Users

Install the extension — no manual setup needed:

```
ext install thtml.thtml-vscode
```

## Editor Integration (Neovim / other LSP clients)

### Installation

```bash
npm install -g @thtml/language-server
# or
pnpm add -g @thtml/language-server
```

### Running

```bash
thtml-language-server --stdio
```

### Neovim (nvim-lspconfig)

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.thtml then
  configs.thtml = {
    default_config = {
      cmd = { 'thtml-language-server', '--stdio' },
      filetypes = { 'thtml' },
      root_dir = lspconfig.util.root_pattern('package.json', '.git'),
      settings = {},
    },
  }
end

lspconfig.thtml.setup {}

-- Associate .thtml extension
vim.filetype.add({ extension = { thtml = 'thtml' } })
```

### Helix

Add to `~/.config/helix/languages.toml`:

```toml
[[language]]
name = "thtml"
scope = "text.html.thtml"
file-types = ["thtml"]
language-servers = ["thtml-language-server"]

[language-server.thtml-language-server]
command = "thtml-language-server"
args = ["--stdio"]
```

## LSP Capabilities

| Capability | Supported |
|-----------|-----------|
| `textDocument/completion` | ✓ |
| `textDocument/hover` | ✓ |
| `textDocument/publishDiagnostics` | ✓ |
| `textDocument/didOpen` | ✓ |
| `textDocument/didChange` | ✓ |
| `textDocument/didClose` | ✓ |

Completion is triggered automatically on `.` and `{` characters.

## Architecture

```
ThtmlDocument          — parses .thtml, tracks offset mappings
TemplateTypeChecker    — manages TypeScript LanguageService + virtual files
completion.ts          — maps LSP completion requests → TS completions
hover.ts               — maps LSP hover requests → TS quick info
diagnostics.ts         — parse errors + TS semantic diagnostics
server.ts              — LSP server entry point (stdio / ipc)
```

## License

MIT — see [LICENSE](../../LICENSE)
