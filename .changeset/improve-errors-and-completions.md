---
"@thtml/core": patch
"@thtml/language-server": patch
---

Improve error messages and autocomplete

- parser: unclosed `{% if %}`/`{% for %}` errors now point to the opening tag with a clear message ("Unclosed {% if %} block — expected {% endif %}")
- parser: add `ParseError.userMessage` (clean message without technical line/col prefix)
- diagnostics: show clean user message instead of raw `Error.message`
- completion: TypeScript completions now work inside `{% %}` block context (context variables suggested inside if/for)
- completion: fallback partial-expression extraction when parse temporarily fails (member access like `user.` now shows properties)
- type-checker: emit `declare const item` for for-loop variables so `item.time` is typed correctly instead of "Property 'item' does not exist on type 'Context'"
- type-checker: add `getCompletionsForExpression` for stateless TS completions