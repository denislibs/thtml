import { describe, it, expect } from "vitest";
import { compile, defineTemplate } from "../compiler.js";

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe("compile — plain text", () => {
  it("renders a static string", () => {
    const t = compile("Hello, World!");
    expect(t.render({})).toBe("Hello, World!");
  });

  it("renders an empty template", () => {
    const t = compile("");
    expect(t.render({})).toBe("");
  });

  it("preserves whitespace and newlines", () => {
    const t = compile("line1\nline2\n  indented");
    expect(t.render({})).toBe("line1\nline2\n  indented");
  });
});

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

describe("compile — expressions", () => {
  it("renders a simple variable", () => {
    const t = compile<{ name: string }>("Hello, {{ name }}!");
    expect(t.render({ name: "Denis" })).toBe("Hello, Denis!");
  });

  it("renders a nested dotted path", () => {
    const t = compile<{ user: { name: string } }>("{{ user.name }}");
    expect(t.render({ user: { name: "Alice" } })).toBe("Alice");
  });

  it("renders undefined as empty string", () => {
    const t = compile<Record<string, unknown>>("{{ missing }}");
    expect(t.render({})).toBe("");
  });

  it("renders null as empty string", () => {
    const t = compile<{ v: null }>("{{ v }}");
    expect(t.render({ v: null })).toBe("");
  });

  it("renders numeric values", () => {
    const t = compile<{ count: number }>("{{ count }}");
    expect(t.render({ count: 42 })).toBe("42");
  });

  it("escapes HTML in expressions by default", () => {
    const t = compile<{ html: string }>("{{ html }}");
    expect(t.render({ html: "<script>alert(1)</script>" })).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("escapes all special HTML characters", () => {
    const t = compile<{ v: string }>("{{ v }}");
    expect(t.render({ v: '& < > " \'' })).toBe(
      "&amp; &lt; &gt; &quot; &#39;"
    );
  });

  it("renders raw (unescaped) expression with ! prefix", () => {
    const t = compile<{ html: string }>("{{ !html }}");
    expect(t.render({ html: "<b>bold</b>" })).toBe("<b>bold</b>");
  });

  it("renders raw with special characters unchanged", () => {
    const t = compile<{ html: string }>("{{ !html }}");
    expect(t.render({ html: "<script>alert(1)</script>" })).toBe(
      "<script>alert(1)</script>"
    );
  });
});

// ---------------------------------------------------------------------------
// If / else
// ---------------------------------------------------------------------------

describe("compile — if/else", () => {
  it("renders consequent when condition is truthy", () => {
    const t = compile<{ show: boolean }>(
      "{% if show %}yes{% else %}no{% endif %}"
    );
    expect(t.render({ show: true })).toBe("yes");
  });

  it("renders alternate when condition is falsy", () => {
    const t = compile<{ show: boolean }>(
      "{% if show %}yes{% else %}no{% endif %}"
    );
    expect(t.render({ show: false })).toBe("no");
  });

  it("renders nothing for falsy condition without else", () => {
    const t = compile<{ show: boolean }>("{% if show %}shown{% endif %}");
    expect(t.render({ show: false })).toBe("");
  });

  it("handles undefined condition as falsy", () => {
    const t = compile<Record<string, unknown>>(
      "{% if flag %}yes{% else %}no{% endif %}"
    );
    expect(t.render({})).toBe("no");
  });

  it("handles complex boolean condition", () => {
    const t = compile<{ a: number; b: number }>(
      "{% if a > b %}greater{% else %}not greater{% endif %}"
    );
    expect(t.render({ a: 5, b: 3 })).toBe("greater");
    expect(t.render({ a: 1, b: 3 })).toBe("not greater");
  });
});

// ---------------------------------------------------------------------------
// For loops
// ---------------------------------------------------------------------------

describe("compile — for loops", () => {
  it("renders each item", () => {
    const t = compile<{ items: string[] }>(
      "{% for item of items %}{{ item }},{% endfor %}"
    );
    expect(t.render({ items: ["a", "b", "c"] })).toBe("a,b,c,");
  });

  it("renders nothing for empty array", () => {
    const t = compile<{ items: string[] }>(
      "{% for item of items %}{{ item }}{% endfor %}"
    );
    expect(t.render({ items: [] })).toBe("");
  });

  it("renders nothing for undefined iterable", () => {
    const t = compile<Record<string, unknown>>(
      "{% for item of missing %}x{% endfor %}"
    );
    expect(t.render({})).toBe("");
  });

  it("provides loop meta index (0-based)", () => {
    const t = compile<{ items: string[] }>(
      "{% for item, meta of items %}{{ item }}:{{ meta.index }},{% endfor %}"
    );
    expect(t.render({ items: ["a", "b", "c"] })).toBe("a:0,b:1,c:2,");
  });

  it("supports nested for loops", () => {
    const t = compile<{ rows: number[][] }>(
      "{% for row of rows %}[{% for cell of row %}{{ cell }}{% endfor %}]{% endfor %}"
    );
    expect(
      t.render({
        rows: [
          [1, 2],
          [3, 4],
        ],
      })
    ).toBe("[12][34]");
  });

  it("renders numeric items", () => {
    const t = compile<{ nums: number[] }>(
      "{% for n of nums %}{{ n }} {% endfor %}"
    );
    expect(t.render({ nums: [1, 2, 3] })).toBe("1 2 3 ");
  });
});

// ---------------------------------------------------------------------------
// Set directive
// ---------------------------------------------------------------------------

describe("compile — set", () => {
  it("sets and renders a literal number", () => {
    const t = compile("{% set x = 42 %}{{ x }}");
    expect(t.render({})).toBe("42");
  });

  it("sets a string literal and renders it", () => {
    const t = compile('{% set greeting = "hello" %}{{ greeting }}');
    expect(t.render({})).toBe("hello");
  });

  it("set variable is visible after the directive", () => {
    const t = compile(
      "{% set x = 10 %}before {{ x }} after"
    );
    expect(t.render({})).toBe("before 10 after");
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe("compile — comments", () => {
  it("strips comments from output", () => {
    const t = compile("before{# this is a comment #}after");
    expect(t.render({})).toBe("beforeafter");
  });

  it("strips multi-word comments", () => {
    const t = compile("{# comment with spaces #}text");
    expect(t.render({})).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// defineTemplate
// ---------------------------------------------------------------------------

describe("defineTemplate", () => {
  it("provides type-safe render", () => {
    interface MyContext {
      count: number;
    }
    const t = defineTemplate<MyContext>("Count: {{ count }}");
    expect(t.render({ count: 5 })).toBe("Count: 5");
  });

  it("passes options through to compile", () => {
    const t = defineTemplate<{ html: string }>("{{ html }}", {
      escape: false,
    });
    expect(t.render({ html: "<b>bold</b>" })).toBe("<b>bold</b>");
  });
});

// ---------------------------------------------------------------------------
// renderAsync
// ---------------------------------------------------------------------------

describe("compile — renderAsync", () => {
  it("renders synchronously via async path", async () => {
    const t = compile<{ name: string }>("Hello {{ name }}");
    await expect(t.renderAsync({ name: "World" })).resolves.toBe(
      "Hello World"
    );
  });

  it("resolves to same result as render", async () => {
    const t = compile<{ items: number[] }>(
      "{% for n of items %}{{ n }}{% endfor %}"
    );
    const ctx = { items: [1, 2, 3] };
    await expect(t.renderAsync(ctx)).resolves.toBe(t.render(ctx));
  });
});

// ---------------------------------------------------------------------------
// escape option
// ---------------------------------------------------------------------------

describe("compile — escape option", () => {
  it("does not escape when escape: false is set", () => {
    const t = compile<{ html: string }>("{{ html }}", { escape: false });
    expect(t.render({ html: "<b>bold</b>" })).toBe("<b>bold</b>");
  });

  it("! prefix always skips escaping regardless of option", () => {
    const t = compile<{ html: string }>("{{ !html }}", { escape: true });
    expect(t.render({ html: "<b>bold</b>" })).toBe("<b>bold</b>");
  });
});

// ---------------------------------------------------------------------------
// Template.source
// ---------------------------------------------------------------------------

describe("compiled template — source property", () => {
  it("exposes generated JS source as a string", () => {
    const t = compile("Hello {{ name }}") as unknown as {
      source: string;
    };
    expect(typeof t.source).toBe("string");
    expect(t.source.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed template
// ---------------------------------------------------------------------------

describe("compile — mixed template", () => {
  it("renders a realistic page template", () => {
    const source = [
      "<h1>{{ title }}</h1>",
      "{% if items.length %}",
      "<ul>",
      "{% for item of items %}",
      "<li>{{ item }}</li>",
      "{% endfor %}",
      "</ul>",
      "{% else %}",
      "<p>No items.</p>",
      "{% endif %}",
    ].join("");

    const t = compile<{ title: string; items: string[] }>(source);

    expect(t.render({ title: "My List", items: ["Apple", "Banana"] })).toBe(
      "<h1>My List</h1><ul><li>Apple</li><li>Banana</li></ul>"
    );

    expect(t.render({ title: "Empty", items: [] })).toBe(
      "<h1>Empty</h1><p>No items.</p>"
    );
  });

  it("escapes XSS in user-provided title", () => {
    const t = compile<{ title: string }>("<h1>{{ title }}</h1>");
    expect(t.render({ title: "<script>evil()</script>" })).toBe(
      "<h1>&lt;script&gt;evil()&lt;/script&gt;</h1>"
    );
  });
});
