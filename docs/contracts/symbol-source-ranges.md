---
name: symbol-source-ranges
description: Static symbol nodes expose optional, end-exclusive UTF-8 byte ranges tied to the extracted source revision. Line spans remain for navigation; remediation refuses missing or ambiguous precise ranges.
governs:
  - 'packages/types/src/nodes.ts'
  - 'packages/core/src/extract/symbols.ts'
  - 'packages/core/test/symbol-source-ranges.test.ts'
adr: [ADR-234]
enforcement: [lint, review]
---

# Precise symbol source ranges

Refs #1314. A static `SymbolNode.span` retains its inclusive, one-based
`startLine`/`endLine` for existing graph and runtime-fusion consumers. It may
also carry `startByte` and `endByte`: zero-based offsets into the raw UTF-8
source file, with `endByte` exclusive. The pair is atomic and nonempty. `relPath`
identifies the file; the offsets identify its parsed definition syntax node,
including its body. Siblings on the same line have distinct intervals. A nested
definition may lie inside its parent definition's interval.

Static extraction converts tree-sitter's JavaScript UTF-16 string indices to
UTF-8 byte offsets against the same file content it parsed. This preserves
coordinates through non-ASCII text and either LF or CRLF. If the file contains
undecodable UTF-8, its parse tree has errors, or exact conversion is otherwise
unavailable, both byte fields are absent; a line interval alone never
authorizes an edit. Runtime-only symbols and older snapshots likewise may have
only lines. A later complete extraction refreshes both line and byte positions
of an existing static symbol.

The graph transports only coordinates and identity, never source bytes. A
remediation client must first require `sourceBaseline.status === 'ready'` with
the exact repository and pinned full SHA, then verify the file bytes at that
commit and use the half-open byte interval. It refuses absent or invalid byte
fields, a source mismatch, overlapping unselected declarations, or a selected
range that does not isolate the intended declaration. It cannot widen to whole
lines, a whole file, or guessed columns. The coordinate pair indicates where
the parser found a definition; it does not certify that replacing it is safe or
that the resulting program is correct.
