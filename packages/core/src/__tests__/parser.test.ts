/**
 * Parser test suite.
 *
 * Tests cover the full round-trip from source string to AST node shapes,
 * including all node types, structural invariants, error conditions, and
 * nested constructs.
 */

import { describe, expect, it } from "vitest";
import {
  isCommentNode,
  isExpressionNode,
  isForNode,
  isIfNode,
  isRawExpressionNode,
  isSetNode,
  isTextNode,
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
} from "../ast.js";
import { tokenize } from "../lexer.js";
import { ParseError, parse } from "../parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertType<T extends ChildNode>(
  node: ChildNode | undefined,
  type: T["type"]
): asserts node is T {
  if (node === undefined) throw new Error("Node is undefined");
  if (node.type !== type) {
    throw new Error(`Expected node type "${type}", got "${node.type}"`);
  }
}

/** Parse and return the RootNode. */
function parseRoot(source: string): RootNode {
  return parse(source);
}

/** Parse and return the first child of the root. */
function firstChild(source: string): ChildNode | undefined {
  return parseRoot(source).children[0];
}

// ---------------------------------------------------------------------------
// RootNode
// ---------------------------------------------------------------------------

describe("parse() returns a RootNode", () => {
  it("returns type === 'Root'", () => {
    expect(parseRoot("").type).toBe("Root");
  });

  it("has a span on the root", () => {
    const ast = parseRoot("<p>hello</p>");
    expect(ast.span).toBeDefined();
    expect(ast.span.start).toBeDefined();
    expect(ast.span.end).toBeDefined();
  });

  it("children is an array", () => {
    expect(Array.isArray(parseRoot("").children)).toBe(true);
  });

  it("children is empty for empty source", () => {
    expect(parseRoot("").children).toHaveLength(0);
  });

  it("frontmatter is null when no frontmatter present", () => {
    expect(parseRoot("<p>hello</p>").frontmatter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe("frontmatter parsing", () => {
  const src = `---
interface Context {
  title: string;
  user: { name: string; age: number };
}
---
<html></html>`;

  it("extracts frontmatter string", () => {
    const ast = parseRoot(src);
    expect(ast.frontmatter).not.toBeNull();
    expect(ast.frontmatter).toContain("interface Context");
    expect(ast.frontmatter).toContain("title: string;");
  });

  it("does not include --- fences in frontmatter value", () => {
    const ast = parseRoot(src);
    expect(ast.frontmatter).not.toContain("---");
  });

  it("leaves children correctly after frontmatter", () => {
    const ast = parseRoot(src);
    expect(ast.children.length).toBeGreaterThan(0);
    const first = ast.children[0];
    assertType<TextNode>(first, "Text");
    expect(first.value).toContain("<html></html>");
  });

  it("empty frontmatter block results in null frontmatter", () => {
    const ast = parseRoot("---\n---\n<p>content</p>");
    expect(ast.frontmatter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TextNode
// ---------------------------------------------------------------------------

describe("TextNode", () => {
  it("produces a TextNode for plain HTML", () => {
    const child = firstChild("<div>Hello</div>");
    assertType<TextNode>(child, "Text");
    expect(child.value).toBe("<div>Hello</div>");
  });

  it("TextNode has a span", () => {
    const child = firstChild("hello");
    assertType<TextNode>(child, "Text");
    expect(child.span.start.offset).toBe(0);
    expect(child.span.end.offset).toBe(5);
  });

  it("preserves whitespace", () => {
    const child = firstChild("  hello  ");
    assertType<TextNode>(child, "Text");
    expect(child.value).toBe("  hello  ");
  });
});

// ---------------------------------------------------------------------------
// ExpressionNode  {{ expr }}
// ---------------------------------------------------------------------------

describe("ExpressionNode  {{ expr }}", () => {
  it("produces an ExpressionNode", () => {
    const child = firstChild("{{ title }}");
    assertType<ExpressionNode>(child, "Expression");
    expect(child.expression).toBe("title");
  });

  it("trims surrounding whitespace from expression", () => {
    const child = firstChild("{{   user.name   }}");
    assertType<ExpressionNode>(child, "Expression");
    expect(child.expression).toBe("user.name");
  });

  it("escape is true by default", () => {
    const child = firstChild("{{ title }}");
    assertType<ExpressionNode>(child, "Expression");
    expect(child.escape).toBe(true);
  });

  it("isExpressionNode type guard works", () => {
    const child = firstChild("{{ x }}");
    expect(isExpressionNode(child as Parameters<typeof isExpressionNode>[0])).toBe(true);
  });

  it("handles complex JS expressions", () => {
    const child = firstChild("{{ items.length + 1 }}");
    assertType<ExpressionNode>(child, "Expression");
    expect(child.expression).toBe("items.length + 1");
  });

  it("has correct span start and end", () => {
    const child = firstChild("{{ x }}");
    assertType<ExpressionNode>(child, "Expression");
    expect(child.span.start.offset).toBe(0);
    expect(child.span.end.offset).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// RawExpressionNode  {{ !expr }}
// ---------------------------------------------------------------------------

describe("RawExpressionNode  {{ !expr }}", () => {
  it("produces a RawExpressionNode for {{ !expr }}", () => {
    const child = firstChild("{{ !rawHtml }}");
    assertType<RawExpressionNode>(child, "RawExpression");
    expect(child.expression).toBe("rawHtml");
  });

  it("strips the leading ! from the expression", () => {
    const child = firstChild("{{ !user.html }}");
    assertType<RawExpressionNode>(child, "RawExpression");
    expect(child.expression).toBe("user.html");
  });

  it("type is 'RawExpression'", () => {
    const child = firstChild("{{ !x }}");
    expect(child?.type).toBe("RawExpression");
  });

  it("isRawExpressionNode type guard works", () => {
    const child = firstChild("{{ !x }}");
    expect(
      isRawExpressionNode(child as Parameters<typeof isRawExpressionNode>[0])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IfNode
// ---------------------------------------------------------------------------

describe("IfNode  {% if %} ... {% endif %}", () => {
  const src = `{% if isAdmin %}<span>Admin</span>{% endif %}`;

  it("produces an IfNode", () => {
    const child = firstChild(src);
    assertType<IfNode>(child, "If");
  });

  it("captures the condition", () => {
    const child = firstChild(src);
    assertType<IfNode>(child, "If");
    expect(child.condition).toBe("isAdmin");
  });

  it("consequent has children", () => {
    const child = firstChild(src);
    assertType<IfNode>(child, "If");
    expect(child.consequent.length).toBeGreaterThan(0);
    assertType<TextNode>(child.consequent[0], "Text");
    expect((child.consequent[0] as TextNode).value).toBe("<span>Admin</span>");
  });

  it("alternate is empty when no else branch", () => {
    const child = firstChild(src);
    assertType<IfNode>(child, "If");
    expect(child.alternate).toHaveLength(0);
  });

  it("captures else branch in alternate", () => {
    const withElse = `{% if isAdmin %}<span>Admin</span>{% else %}<span>User</span>{% endif %}`;
    const child = firstChild(withElse);
    assertType<IfNode>(child, "If");
    expect(child.alternate.length).toBeGreaterThan(0);
    assertType<TextNode>(child.alternate[0], "Text");
    expect((child.alternate[0] as TextNode).value).toBe("<span>User</span>");
  });

  it("isIfNode type guard works", () => {
    const child = firstChild(src);
    expect(isIfNode(child as Parameters<typeof isIfNode>[0])).toBe(true);
  });

  it("has a span covering the entire if block", () => {
    const child = firstChild(src);
    assertType<IfNode>(child, "If");
    expect(child.span.start.offset).toBe(0);
    expect(child.span.end.offset).toBe(src.length);
  });

  it("handles complex conditions", () => {
    const child = firstChild("{% if user.age >= 18 %}<p>adult</p>{% endif %}");
    assertType<IfNode>(child, "If");
    expect(child.condition).toBe("user.age >= 18");
  });

  it("throws ParseError when endif is missing", () => {
    expect(() => parse("{% if isAdmin %}<p>hi</p>")).toThrow(ParseError);
  });
});

// ---------------------------------------------------------------------------
// ForNode
// ---------------------------------------------------------------------------

describe("ForNode  {% for item of items %} ... {% endfor %}", () => {
  const src = `{% for item of items %}<li>{{ item.label }}</li>{% endfor %}`;

  it("produces a ForNode", () => {
    const child = firstChild(src);
    assertType<ForNode>(child, "For");
  });

  it("captures itemName (variable)", () => {
    const child = firstChild(src);
    assertType<ForNode>(child, "For");
    expect(child.variable).toBe("item");
  });

  it("indexVariable is null when not specified", () => {
    const child = firstChild(src);
    assertType<ForNode>(child, "For");
    expect(child.indexVariable).toBeNull();
  });

  it("captures iterable", () => {
    const child = firstChild(src);
    assertType<ForNode>(child, "For");
    expect(child.iterable).toBe("items");
  });

  it("body has children", () => {
    const child = firstChild(src);
    assertType<ForNode>(child, "For");
    expect(child.body.length).toBeGreaterThan(0);
  });

  it("captures indexVariable when specified", () => {
    const withIndex = `{% for item, i of items %}<li>{{ i }}</li>{% endfor %}`;
    const child = firstChild(withIndex);
    assertType<ForNode>(child, "For");
    expect(child.variable).toBe("item");
    expect(child.indexVariable).toBe("i");
  });

  it("isForNode type guard works", () => {
    const child = firstChild(src);
    expect(isForNode(child as Parameters<typeof isForNode>[0])).toBe(true);
  });

  it("throws ParseError when missing 'of'", () => {
    expect(() =>
      parse("{% for item items %}<li></li>{% endfor %}")
    ).toThrow(ParseError);
  });

  it("throws ParseError when endfor is missing", () => {
    expect(() => parse("{% for item of items %}<li>hi</li>")).toThrow(ParseError);
  });

  it("handles dotted iterable expressions", () => {
    const child = firstChild(
      "{% for post of user.posts %}<p>{{ post.title }}</p>{% endfor %}"
    );
    assertType<ForNode>(child, "For");
    expect(child.iterable).toBe("user.posts");
  });
});

// ---------------------------------------------------------------------------
// SetNode
// ---------------------------------------------------------------------------

describe("SetNode  {% set var = expr %}", () => {
  const src = `{% set greeting = "Hello " + title %}`;

  it("produces a SetNode", () => {
    const child = firstChild(src);
    assertType<SetNode>(child, "Set");
  });

  it("captures variable name", () => {
    const child = firstChild(src);
    assertType<SetNode>(child, "Set");
    expect(child.variable).toBe("greeting");
  });

  it("captures expression", () => {
    const child = firstChild(src);
    assertType<SetNode>(child, "Set");
    expect(child.expression).toBe('"Hello " + title');
  });

  it("isSetNode type guard works", () => {
    const child = firstChild(src);
    expect(isSetNode(child as Parameters<typeof isSetNode>[0])).toBe(true);
  });

  it("throws ParseError when = is missing", () => {
    expect(() => parse("{% set greeting %}")).toThrow(ParseError);
  });
});

// ---------------------------------------------------------------------------
// IncludeNode
// ---------------------------------------------------------------------------

describe("IncludeNode  {% include 'path' %}", () => {
  it("produces an IncludeNode", () => {
    const child = firstChild('{% include "partials/header.thtml" %}');
    expect(child?.type).toBe("Include");
  });

  it("captures path without quotes (double quotes)", () => {
    const child = firstChild('{% include "partials/header.thtml" %}');
    const node = child as IncludeNode;
    expect(node.path).toBe("partials/header.thtml");
  });

  it("captures path without quotes (single quotes)", () => {
    const child = firstChild("{% include 'partials/footer.thtml' %}");
    const node = child as IncludeNode;
    expect(node.path).toBe("partials/footer.thtml");
  });

  it("contextExpression is null when 'with' clause is absent", () => {
    const child = firstChild('{% include "header.thtml" %}');
    const node = child as IncludeNode;
    expect(node.contextExpression).toBeNull();
  });

  it("captures contextExpression from 'with' clause", () => {
    const child = firstChild('{% include "header.thtml" with headerCtx %}');
    const node = child as IncludeNode;
    expect(node.contextExpression).toBe("headerCtx");
  });
});

// ---------------------------------------------------------------------------
// CommentNode
// ---------------------------------------------------------------------------

describe("CommentNode  {# ... #}", () => {
  it("produces a CommentNode", () => {
    const child = firstChild("{# this is a comment #}");
    assertType<CommentNode>(child, "Comment");
  });

  it("captures comment content", () => {
    const child = firstChild("{# this is a comment #}");
    assertType<CommentNode>(child, "Comment");
    expect(child.content).toBe(" this is a comment ");
  });

  it("handles empty comment", () => {
    const child = firstChild("{##}");
    assertType<CommentNode>(child, "Comment");
    expect(child.content).toBe("");
  });

  it("isCommentNode type guard works", () => {
    const child = firstChild("{# x #}");
    expect(isCommentNode(child as Parameters<typeof isCommentNode>[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nested constructs
// ---------------------------------------------------------------------------

describe("nested constructs", () => {
  it("for loop nested inside if block", () => {
    const src = `{% if show %}{% for item of items %}<li>{{ item }}</li>{% endfor %}{% endif %}`;
    const root = parseRoot(src);

    const ifNode = root.children[0];
    assertType<IfNode>(ifNode, "If");

    const forNode = ifNode.consequent[0];
    assertType<ForNode>(forNode, "For");
    expect(forNode.variable).toBe("item");
    expect(forNode.iterable).toBe("items");
  });

  it("if block nested inside for loop", () => {
    const src = `{% for item of items %}{% if item.active %}<p>{{ item.name }}</p>{% endif %}{% endfor %}`;
    const root = parseRoot(src);

    const forNode = root.children[0];
    assertType<ForNode>(forNode, "For");

    const ifNode = forNode.body[0];
    assertType<IfNode>(ifNode, "If");
    expect(ifNode.condition).toBe("item.active");
  });

  it("multiple expressions inside a for loop body", () => {
    const src = `{% for item of items %}<div>{{ item.id }}: {{ item.label }}</div>{% endfor %}`;
    const root = parseRoot(src);

    const forNode = root.children[0];
    assertType<ForNode>(forNode, "For");

    const exprs = forNode.body.filter(isExpressionNode);
    expect(exprs.length).toBeGreaterThanOrEqual(2);
  });

  it("deeply nested if inside for inside if", () => {
    const src = [
      "{% if outer %}",
      "{% for item of list %}",
      "{% if item.visible %}<p>{{ item.name }}</p>{% endif %}",
      "{% endfor %}",
      "{% endif %}",
    ].join("");

    const root = parseRoot(src);
    const outerIf = root.children[0];
    assertType<IfNode>(outerIf, "If");

    const forNode = outerIf.consequent[0];
    assertType<ForNode>(forNode, "For");

    const innerIf = forNode.body[0];
    assertType<IfNode>(innerIf, "If");
    expect(innerIf.condition).toBe("item.visible");
  });

  it("mixed: text, expression, comment, set, include in sequence", () => {
    const src = [
      "<header></header>",
      "{{ title }}",
      "{# a comment #}",
      '{% set x = "value" %}',
      '{% include "footer.thtml" %}',
    ].join("");

    const root = parseRoot(src);
    const types = root.children.map((c) => c.type);
    expect(types).toEqual(["Text", "Expression", "Comment", "Set", "Include"]);
  });
});

// ---------------------------------------------------------------------------
// Full template parse (integration smoke test)
// ---------------------------------------------------------------------------

describe("full template integration", () => {
  const fullTemplate = `---
interface Context {
  title: string;
  user: { name: string; age: number };
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
    <span>Admin</span>
  {% else %}
    <span>User</span>
  {% endif %}

  {# This is a comment #}

  {% for item of items %}
    <div data-id="{{ item.id }}">{{ item.label }}</div>
  {% endfor %}

  {% set greeting = "Hello " + title %}
  <p>{{ greeting }}</p>

  {{ !rawHtml }}

  {% include "partials/header.thtml" %}
</body>
</html>`;

  it("parses without throwing", () => {
    expect(() => parseRoot(fullTemplate)).not.toThrow();
  });

  it("extracts frontmatter", () => {
    const ast = parseRoot(fullTemplate);
    expect(ast.frontmatter).toContain("interface Context");
  });

  it("root children contains expected node types", () => {
    const ast = parseRoot(fullTemplate);
    const nodeTypes = ast.children.map((c) => c.type);
    expect(nodeTypes).toContain("Text");
    expect(nodeTypes).toContain("Expression");
    expect(nodeTypes).toContain("If");
    expect(nodeTypes).toContain("Comment");
    expect(nodeTypes).toContain("For");
    expect(nodeTypes).toContain("Set");
    expect(nodeTypes).toContain("RawExpression");
    expect(nodeTypes).toContain("Include");
  });

  it("if node has both consequent and alternate branches", () => {
    const ast = parseRoot(fullTemplate);
    const ifNode = ast.children.find(isIfNode);
    expect(ifNode).toBeDefined();
    expect(ifNode?.consequent.length).toBeGreaterThan(0);
    expect(ifNode?.alternate.length).toBeGreaterThan(0);
  });

  it("for node has correct variable and iterable", () => {
    const ast = parseRoot(fullTemplate);
    const forNode = ast.children.find(isForNode);
    expect(forNode).toBeDefined();
    expect(forNode?.variable).toBe("item");
    expect(forNode?.iterable).toBe("items");
  });

  it("set node has correct variable and expression", () => {
    const ast = parseRoot(fullTemplate);
    const setNode = ast.children.find(isSetNode);
    expect(setNode).toBeDefined();
    expect(setNode?.variable).toBe("greeting");
  });

  it("raw expression node has expression 'rawHtml'", () => {
    const ast = parseRoot(fullTemplate);
    const rawNode = ast.children.find(isRawExpressionNode);
    expect(rawNode).toBeDefined();
    expect(rawNode?.expression).toBe("rawHtml");
  });

  it("include node has correct path", () => {
    const ast = parseRoot(fullTemplate);
    const includeNode = ast.children.find(
      (c): c is IncludeNode => c.type === "Include"
    );
    expect(includeNode).toBeDefined();
    expect(includeNode?.path).toBe("partials/header.thtml");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("ParseError messages", () => {
  it("ParseError contains line and column information", () => {
    let err: ParseError | undefined;
    try {
      parse("{% if %}");
    } catch (e) {
      if (e instanceof ParseError) err = e;
    }
    expect(err).toBeInstanceOf(ParseError);
    expect(err?.message).toMatch(/line \d+, column \d+/);
  });

  it("unknown block keyword throws ParseError", () => {
    expect(() => parse("{% unknown %}")).toThrow(ParseError);
    expect(() => parse("{% unknown %}")).toThrow(/Unknown block keyword/);
  });

  it("empty if condition throws ParseError", () => {
    expect(() => parse("{% if %}content{% endif %}")).toThrow(ParseError);
  });

  it("missing endfor throws ParseError", () => {
    expect(() => parse("{% for item of items %}<p>hi</p>")).toThrow(ParseError);
  });

  it("missing endif throws ParseError", () => {
    expect(() => parse("{% if x %}<p>hi</p>")).toThrow(ParseError);
  });

  it("invalid for syntax (no 'of') throws ParseError", () => {
    expect(() =>
      parse("{% for item items %}<p>hi</p>{% endfor %}")
    ).toThrow(ParseError);
    expect(() =>
      parse("{% for item items %}<p>hi</p>{% endfor %}")
    ).toThrow(/"for" syntax/);
  });
});

// ---------------------------------------------------------------------------
// parse() overloads
// ---------------------------------------------------------------------------

describe("parse() overloads", () => {
  it("accepts a source string directly", () => {
    const ast = parse("<p>{{ title }}</p>");
    expect(ast.type).toBe("Root");
  });

  it("accepts tokens + source string", () => {
    const src = "<p>{{ title }}</p>";
    const tokens = tokenize(src);
    const ast = parse(tokens, src);
    expect(ast.type).toBe("Root");
    expect(ast.children[1]?.type).toBe("Expression");
  });
});
