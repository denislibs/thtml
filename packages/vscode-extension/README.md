# thtml for VS Code

Syntax highlighting, autocomplete, and type checking for `.thtml` template files.

## Features

### Syntax Highlighting

Full syntax highlighting for all thtml constructs:

- **Frontmatter** (`--- ... ---`) — highlighted as TypeScript
- **Expressions** (`{{ expr }}`) — TypeScript expressions with HTML context
- **Blocks** (`{% if %}`, `{% for %}`, etc.) — control-flow keywords + TypeScript
- **Comments** (`{# ... #}`) — template comments
- **HTML** — everything else is standard HTML

### Autocomplete

Type `{{ user.` and get a completion list based on the TypeScript interface declared in the frontmatter:

```thtml
---
interface Context {
  user: { name: string; age: number; role: "admin" | "user" };
  items: string[];
}
---
<p>{{ user. }}   ← autocomplete: name, age, role
```

### Hover Information

Hover over any expression to see its TypeScript type:

```
user.name  →  (property) name: string
items      →  (property) items: string[]
```

### Diagnostics

Undefined variables and type mismatches are underlined in real time — without leaving the editor.

## Installation

Search **thtml** in the VS Code Extensions panel, or install from the command line:

```bash
code --install-extension thtml.thtml-vscode
```

## Usage

1. Create a file with the `.thtml` extension
2. Declare your context type in the frontmatter
3. Write your template — autocomplete and type checking work automatically

```thtml
---
interface Context {
  title: string;
  user: { name: string };
  items: Array<{ id: number; label: string }>;
  isAdmin: boolean;
}
---
<!DOCTYPE html>
<html>
<head><title>{{ title }}</title></head>
<body>
  <h1>Hello, {{ user.name }}!</h1>

  {% if isAdmin %}
    <a href="/admin">Admin Panel</a>
  {% endif %}

  {# render item list #}
  <ul>
    {% for item of items %}
      <li data-id="{{ item.id }}">{{ item.label }}</li>
    {% endfor %}
  </ul>

  {% include "partials/footer.thtml" %}
</body>
</html>
```

## Template Syntax Cheat Sheet

| Syntax | Description |
|--------|-------------|
| `{{ expr }}` | Print expression (HTML-escaped) |
| `{{ !expr }}` | Print raw expression (no escaping) |
| `{% if cond %}...{% endif %}` | Conditional |
| `{% if cond %}...{% else %}...{% endif %}` | Conditional with else |
| `{% for x of arr %}...{% endfor %}` | Loop over array |
| `{% for x, i of arr %}...{% endfor %}` | Loop with index |
| `{% set x = expr %}` | Assign variable |
| `{% include "path.thtml" %}` | Include partial |
| `{# comment #}` | Template comment (stripped from output) |

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `thtml.languageServer.enabled` | `true` | Enable language server (autocomplete, hover, diagnostics) |
| `thtml.languageServer.trace` | `"off"` | LSP trace level: `off`, `messages`, `verbose` |
| `thtml.validate.enable` | `true` | Enable real-time validation |

## Commands

| Command | Description |
|---------|-------------|
| `thtml: Preview Template` | Preview rendered output (editor title button) |
| `thtml: Restart Language Server` | Restart LSP server |
| `thtml: Show Output Channel` | Open LSP output for debugging |

## Requirements

- VS Code **1.85.0** or newer
- Node.js **18+** (for the language server)

## License

MIT — see [LICENSE](../../LICENSE)
