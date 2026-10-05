---
name: escape-nbsp-xa0
description: In code written via tools, the unicode NBSP escape (u00a0 with a backslash) lands as a literal NBSP; write the hex form (xa0) instead
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6908333d-472e-4f88-9200-ea17276d8374
  modified: 2026-10-05T01:27:17.979Z
---

When writing source files (Write/Edit/Bash heredocs), a `\u00a0` escape typed in the tool input arrives in the file as a literal U+00A0 character. ESLint then fails with `no-irregular-whitespace`, and the code is hard to read. Other escapes such as `\x1b` and `\u0001` survived unchanged.

**Why:** happened on 2026-10-04 while building the LiveTerminal in alethe-orchestra (cells.ts, index.tsx, cells.test.ts); found only by `eslint`.

**How to apply:** write `\xa0` for a non-breaking space in JS/TS. After writing code with unusual characters, scan for U+00A0 and control characters with a small node script, because `grep -P` does not work in this Git Bash locale.
