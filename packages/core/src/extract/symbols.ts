import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import TypeScript from 'tree-sitter-typescript'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
import Ruby from 'tree-sitter-ruby'
import Php from 'tree-sitter-php'
import CSharp from 'tree-sitter-c-sharp'
import Java from 'tree-sitter-java'
import Kotlin from 'tree-sitter-kotlin'
import Rust from 'tree-sitter-rust'
import type { GraphEdge, SymbolKind, SymbolNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  symbolId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { ensureFileNode, loadSourceFiles, snippet, toPosix } from './calls/shared.js'

// Static symbol-node extraction (ADR-158 wired JS/TS; ADR-192 added Python and
// Go; ADR-193 added Ruby; ADR-195 added PHP; ADR-196 added C#/.NET; ADR-197 added Java;
// ADR-199 added Kotlin; ADR-201 added Rust). Parses each source file with the grammar that understands it and mints a
// SymbolNode per function / method / constructor / class *definition*, owned by
// its file through a `file ──CONTAINS──▶ symbol` edge — the same containment
// spine files use under services (file-awareness.md §2), one level deeper.
// Static-first: a symbol exists in the inventory whether or not runtime ever
// exercised it, and it carries its `{ startLine, endLine }` definition span,
// which is the fusion key ingest joins a span's `code.line` against to land an
// OBSERVED edge on the calling symbol (observed-first edges, ingest.ts). The node
// is language-neutral — `symbolId` carries no language token — so the per-language
// walker below is the only adapter, and a Python or Go symbol fuses with an
// observed span exactly as a JS/TS one does: line-in-span primary, `code.function`
// (the qualname's terminal name) the tiebreaker. The span alone earns the node;
// fusion also needs the observed span to carry the `code.*` anchor, which is a
// property of the instrumentation, not of this extractor (ADR-192 consequences).
//
// Scope is definitions only — no CALLS/INHERITS symbol edges (that stays Phase 2 /
// symbol-edges.ts, JS/TS). Each file is parsed with the grammar that understands
// it: `.ts` / `.tsx` through tree-sitter-typescript, `.js` / `.jsx` / `.mjs` /
// `.cjs` through tree-sitter-javascript, `.py` through tree-sitter-python, `.go`
// through tree-sitter-go, `.rb` through tree-sitter-ruby, `.php` through
// tree-sitter-php (the `php_only` variant, matching extract/routes.ts and
// calls/eloquent.ts). Those grammars extract/routes.ts and the call producers
// already load, so they added no dependency; C#, Java, Kotlin, and Rust are the
// symbol-grain languages with no route / call producer yet, so `.cs` through
// tree-sitter-c-sharp, `.java` through tree-sitter-java, `.kt` through
// tree-sitter-kotlin, and `.rs` through tree-sitter-rust are the four new grammar
// dependencies (each pinned at the ABI-14 ceiling, see SYMBOL_GRAMMAR_BY_EXT below).
// The JS grammar cannot parse
// TypeScript type annotations — it produces ERROR nodes that swallow most
// definitions (an all-`.ts` core file yields 4 of 27 functions under the JS
// grammar, 27 of 27 under the TS one) — and symbol extraction, unlike the string /
// route matchers that survive a partial parse, needs a correct AST, so the grammar
// is chosen per extension. `collectSymbolDefsForExt` dispatches to the JS/TS,
// Python, Go, Ruby, PHP, C#, Java, Kotlin, or Rust walker on the extension. Evidence carries the real `file:line`,
// never fabricated (file-awareness.md §6).

const PARSE_CHUNK = 16384

// The grammar for the JS/TS extensions NEAT symbol-extracts. tree-sitter-
// typescript is a superset grammar sharing the same definition node types
// (function_declaration / class_declaration / method_definition /
// variable_declarator), so `collectSymbolDefs` walks TS and JS trees identically.
// This map stays JS/TS-only because the other AST producers that import it
// (symbol-edges.ts, actions.ts, zod-shapes.ts, calls/drizzle.ts,
// calls/firestore.ts) are JS/TS-scoped; symbol extraction extends the set to
// Python, Go, Ruby, and PHP through `SYMBOL_GRAMMAR_BY_EXT` below without pulling
// those producers onto languages they don't parse.
export const GRAMMAR_BY_EXT: Record<string, typeof JavaScript> = {
  '.ts': TypeScript.typescript,
  '.tsx': TypeScript.tsx,
  '.js': JavaScript,
  '.jsx': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
}

// Symbol extraction alone reaches Python, Go, Ruby, PHP, C#, Java, Kotlin, and Rust
// (ADR-192, ADR-193, ADR-195, ADR-196, ADR-197, ADR-199, ADR-201): `.py` →
// tree-sitter-python, `.go` → tree-sitter-go, `.rb` → tree-sitter-ruby, `.php` →
// tree-sitter-php's `php_only` variant (the same one extract/routes.ts and
// calls/eloquent.ts parse Laravel with), `.cs` → tree-sitter-c-sharp, `.java` →
// tree-sitter-java, `.kt` → tree-sitter-kotlin, `.rs` → tree-sitter-rust, layered
// over the JS/TS set so the shared `GRAMMAR_BY_EXT` its sibling producers import
// stays untouched. C#, Java, Kotlin, and Rust are the symbol-grain languages with no
// route / call producer yet, so each brings its own grammar dependency pinned at the
// ABI-14 ceiling: tree-sitter-c-sharp at 0.21.3 (its 0.23 line jumps to ABI-15 + an
// ESM-top-level-await binding the CJS extractor can't `require()`), tree-sitter-java
// at 0.21.0, tree-sitter-kotlin at 0.3.8, and tree-sitter-rust at 0.21.0. The Kotlin
// grammar is the fwcd community grammar, whose versioning tracks its own line rather
// than the official grammars, so its ABI was checked empirically rather than inferred
// from the sibling pins: 0.3.8 generates a `LANGUAGE_VERSION 14` parser and ships a
// `require()`-able node-addon-api binding — it was loaded against the pinned
// tree-sitter@^0.21 runtime and parsed a `.kt` file with zero ERROR nodes before the
// walker was written (ADR-199), the same ABI-14 discipline that pins tree-sitter-ruby
// at 0.21.0 and tree-sitter-php at 0.22.8. tree-sitter-rust jumps from its lone
// 0.21.0 release straight to the 0.23 (ABI-15, ESM-top-level-await) line with no
// 0.22.x between, so 0.21.0 is the one release that both generates a
// `LANGUAGE_VERSION 14` parser and `require()`s under the pinned runtime — verified
// by loading it and parsing a `.rs` file with zero ERROR nodes before the walker was
// written (ADR-201), the same exact-pin discipline the sibling grammars follow.
const SYMBOL_GRAMMAR_BY_EXT: Record<string, typeof JavaScript> = {
  ...GRAMMAR_BY_EXT,
  '.py': Python,
  '.go': Go,
  '.rb': Ruby,
  '.php': Php.php_only,
  '.cs': CSharp,
  '.java': Java,
  '.kt': Kotlin,
  '.rs': Rust,
}

export function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

// A parsed definition, pre-identity. `qualname` is the source-declared name
// (`OrderService.create`, `merge`); `node` carries the definition span.
export interface SymbolDef {
  kind: SymbolKind
  qualname: string
  startLine: number
  endLine: number
}

function methodName(node: Parser.SyntaxNode): string | null {
  const name = node.childForFieldName('name')
  return name ? name.text : null
}

// Walk the AST once, emitting one SymbolDef per definition. A class carries its
// method context so a method's qualname is `Class.method`; a plain (including
// nested) function keeps its bare declared name. Anonymous definitions with no
// declared name are skipped rather than given a fabricated one (§6).
export function collectSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('function', name, node)
        break
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        // `abstract class Foo` parses as its own node type in the TS grammar,
        // not `class_declaration` — miss it and every INHERITS/IMPLEMENTS to an
        // abstract base (the most common heritage target) has no symbol to land
        // on. It carries the same `name` / `body` fields, so it mints identically.
        const name = node.childForFieldName('name')?.text
        if (name) push('class', name, node)
        const body = node.childForFieldName('body')
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i)
            if (child) visit(child, name ?? classCtx)
          }
        }
        // Class children were walked with the class context above; skip the
        // generic recurse so its body isn't visited twice.
        return
      }
      case 'method_definition': {
        const name = methodName(node)
        if (name) {
          const kind: SymbolKind = name === 'constructor' ? 'constructor' : 'method'
          push(kind, classCtx ? `${classCtx}.${name}` : name, node)
        }
        break
      }
      case 'variable_declarator': {
        // `const foo = () => {}` / `const foo = function () {}` — the common
        // arrow/function-expression definition form. Only a plain identifier
        // name yields a symbol; a destructuring pattern names no single symbol.
        const value = node.childForFieldName('value')
        if (
          value &&
          (value.type === 'arrow_function' ||
            value.type === 'function' ||
            value.type === 'function_expression' ||
            value.type === 'generator_function')
        ) {
          const nameNode = node.childForFieldName('name')
          if (nameNode && nameNode.type === 'identifier') {
            push('function', nameNode.text, node)
          }
        }
        break
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child, classCtx)
    }
  }

  visit(root, undefined)
  return out
}

// Python: `def` is `function_definition`, `class` is `class_definition`, and a
// decorated form wraps either in `decorated_definition`. A `function_definition`
// whose direct owner is a class body is a method (its `__init__` the constructor,
// the qualname `Class.__init__` so the terminal name still matches the runtime
// `code.function`); a top-level or nested `def` is a plain function. Method-ness
// comes from direct class-body membership, not ambient scope — a `def` nested in a
// method is a function, mirroring the JS/TS walker where the node type decides.
// `async def` is the same node type, so it needs no separate case.
export function collectPythonSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          if (classCtx) {
            const kind: SymbolKind = name === '__init__' ? 'constructor' : 'method'
            push(kind, `${classCtx}.${name}`, node)
          } else {
            push('function', name, node)
          }
        }
        // The body is walked with no class context: a `def` inside this function
        // is a plain function, never a method of the enclosing class.
        const body = node.childForFieldName('body')
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i)
            if (child) visit(child, undefined)
          }
        }
        return
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text
        if (name) push('class', name, node)
        const body = node.childForFieldName('body')
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i)
            if (child) visit(child, name ?? classCtx)
          }
        }
        return
      }
      case 'decorated_definition': {
        // `@app.get(...)` etc. wrap the def/class in a `decorated_definition`;
        // unwrap to the inner definition, keeping the class context so a decorated
        // method in a class body still mints as a method.
        const def = node.childForFieldName('definition')
        if (def) visit(def, classCtx)
        return
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child, classCtx)
    }
  }

  visit(root, undefined)
  return out
}

// Go: a `function_declaration` is a free function; a `method_declaration` carries
// a receiver, so its qualname is `Receiver.method` — the terminal name matches the
// runtime `code.function` whether the instrumentation stamps the bare method name
// or a package-qualified `main.(*Server).Handle` (both reduce to `Handle` under
// `terminalName`). The receiver type is read off the receiver parameter, unwrapping
// a `*T` pointer and a `T[U]` generic to the base `type_identifier`. Go has no
// classes; struct types are not symbols in this rung (mirrors the JS/TS scope of
// callable-and-class definitions, without a Go analog for the class).
function goReceiverType(node: Parser.SyntaxNode): string | undefined {
  const receiver = node.childForFieldName('receiver')
  if (!receiver) return undefined
  for (let i = 0; i < receiver.namedChildCount; i++) {
    const param = receiver.namedChild(i)
    if (param?.type !== 'parameter_declaration') continue
    let typeNode = param.childForFieldName('type')
    if (typeNode?.type === 'pointer_type') typeNode = typeNode.namedChild(0) ?? typeNode
    if (typeNode?.type === 'generic_type') {
      typeNode = typeNode.childForFieldName('type') ?? typeNode.namedChild(0) ?? typeNode
    }
    if (typeNode?.type === 'type_identifier') return typeNode.text
    return typeNode?.text
  }
  return undefined
}

export function collectGoSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const visit = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('function', name, node)
        break
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          const recv = goReceiverType(node)
          push('method', recv ? `${recv}.${name}` : name, node)
        }
        break
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child)
    }
  }

  visit(root)
  return out
}

// Ruby: `method` is an instance method, `singleton_method` a class method
// (`def self.x`), `class` a class, `module` a namespace. A `method` / `singleton_method`
// inside a class or module body is a method (an instance `initialize` the
// constructor, its qualname `Class.initialize` so the terminal name still matches
// the runtime `code.function`); a top-level `def` is a plain function. Method-ness
// comes from direct class/module-body membership, not ambient scope — a `def`
// nested in a method is a function, mirroring the Python and JS/TS walkers where
// the node type and its owner decide. Ruby writes a method as `Class#method` and a
// namespace with `::` (`Shop::OrderMailer`); the qualname joins the nesting with a
// plain `.` so it reduces under `terminalName` (last-`.` split) to the bare method
// name — a runtime `OrderMailer#deliver` or a bare `deliver` both land via the
// line-in-span primary, and the bare form also matches the `code.function`
// tiebreaker. A class/module declared with a `::` scope-resolution name
// (`class Shop::OrderMailer`) is normalized to the same dotted form.
export function collectRubySymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  // The declared name of a class/module, dot-joined so a `Shop::OrderMailer`
  // scope-resolution name reduces cleanly under `terminalName`.
  const nameText = (node: Parser.SyntaxNode): string | undefined =>
    node.childForFieldName('name')?.text.replace(/::/g, '.')

  const walkBody = (node: Parser.SyntaxNode, ctx: string | undefined): void => {
    const body = node.childForFieldName('body')
    if (!body) return
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i)
      if (child) visit(child, ctx)
    }
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'method':
      case 'singleton_method': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          if (classCtx) {
            const kind: SymbolKind =
              node.type === 'method' && name === 'initialize' ? 'constructor' : 'method'
            push(kind, `${classCtx}.${name}`, node)
          } else {
            push('function', name, node)
          }
        }
        // The body is walked with no class context: a `def` inside this method is a
        // plain function, never a method of the enclosing class.
        walkBody(node, undefined)
        return
      }
      case 'class':
      case 'module': {
        const name = nameText(node)
        if (name) push('class', classCtx ? `${classCtx}.${name}` : name, node)
        walkBody(node, name ? (classCtx ? `${classCtx}.${name}` : name) : classCtx)
        return
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child, classCtx)
    }
  }

  visit(root, undefined)
  return out
}

// PHP: a top-level `function_definition` is a plain (possibly namespaced)
// function; a `method_declaration` inside a class / trait / interface body is a
// method (its `__construct` the constructor); `class_declaration`,
// `trait_declaration`, and `interface_declaration` all mint as `class`-kind nodes
// (a trait and an interface are class-shaped heritage targets, so an INHERITS /
// IMPLEMENTS to either has a symbol to land on). PHP writes namespaces with `\`
// (`App\Quote`) and static members with `::` (`QuoteService::calculate`); the
// qualname joins the namespace and class nesting with a plain `.`
// (`App.Quote.QuoteService.calculate`) so it reduces under ingest's `terminalName`
// (last-`.` split) to the bare method name (`calculate`) — a runtime
// `App\Quote\QuoteService::calculate` or a bare `calculate` both land via the
// line-in-span primary, and the bare form also matches the `code.function`
// tiebreaker. A semicolon-form `namespace App\Quote;` sets the ambient namespace
// for every sibling that follows it; a braced `namespace App\Quote { … }` scopes
// it to its body — the walker threads both. Method-ness comes from direct
// class-body membership, mirroring the Python and Ruby walkers.
export function collectPhpSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  // PHP's `\` namespace separator and `::` member separator both normalize to the
  // `.` the qualname joins on, so a declared `App\Quote` or `Billing::Invoice`
  // reduces cleanly under `terminalName`; a leading separator (`\App`) is dropped.
  const dot = (s: string): string =>
    s.replace(/\\/g, '.').replace(/::/g, '.').replace(/^\.+/, '')
  const join = (prefix: string | undefined, name: string): string =>
    prefix ? `${prefix}.${name}` : name

  // Walk a container's named children in order, threading the ambient namespace a
  // semicolon-form `namespace X;` sets for every sibling after it.
  const walkChildren = (
    container: Parser.SyntaxNode,
    nsCtx: string | undefined,
    classCtx: string | undefined,
  ): void => {
    let ns = nsCtx
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i)
      if (!child) continue
      if (child.type === 'namespace_definition' && !child.childForFieldName('body')) {
        const nameNode = child.childForFieldName('name')
        if (nameNode) ns = dot(nameNode.text)
        continue
      }
      visit(child, ns, classCtx)
    }
  }

  const walkBody = (
    node: Parser.SyntaxNode,
    nsCtx: string | undefined,
    classCtx: string | undefined,
  ): void => {
    const body = node.childForFieldName('body')
    if (body) walkChildren(body, nsCtx, classCtx)
  }

  const visit = (
    node: Parser.SyntaxNode,
    nsCtx: string | undefined,
    classCtx: string | undefined,
  ): void => {
    switch (node.type) {
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text
        if (name) push('function', join(nsCtx, name), node)
        // A function nested in a function is still a plain function, never a method.
        walkBody(node, nsCtx, undefined)
        return
      }
      case 'class_declaration':
      case 'trait_declaration':
      case 'interface_declaration': {
        const name = node.childForFieldName('name')?.text
        const full = name ? join(nsCtx, name) : classCtx
        if (name) push('class', full!, node)
        walkBody(node, nsCtx, full)
        return
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) {
          const kind: SymbolKind = name === '__construct' ? 'constructor' : 'method'
          push(kind, join(classCtx ?? nsCtx, name), node)
        }
        return
      }
      case 'namespace_definition': {
        // A braced `namespace App\Quote { … }`: scoped to its body. The
        // semicolon form carries no body and is handled by walkChildren above.
        const nameNode = node.childForFieldName('name')
        const ns = nameNode ? dot(nameNode.text) : nsCtx
        walkBody(node, ns, classCtx)
        return
      }
    }
    walkChildren(node, nsCtx, classCtx)
  }

  walkChildren(root, undefined, undefined)
  return out
}

// C#/.NET: a `method_declaration` inside a type body is a method and a
// `constructor_declaration` its constructor (the declared name of a C#
// constructor is the type name); `class_declaration`, `interface_declaration`,
// `struct_declaration`, and `record_declaration` all mint as `class`-kind nodes —
// an interface, struct, or record is a class-shaped definition / heritage target,
// so an INHERITS / IMPLEMENTS to any of them has a symbol to land on. C# already
// writes namespaces and members with `.` (`Cart.Services.CartService.AddItem`), so
// the qualname joins the namespace and type nesting with a plain `.` and reduces
// under ingest's `terminalName` (last-`.` split) to the bare method name
// (`AddItem`) — normalization is minimal, since there's no `::` or `\` to rewrite.
// A runtime `code.function` of `AddItem` matches the tiebreaker; a namespace- or
// type-qualified form still lands via the line-in-span primary — the same keying
// ADR-192 relies on for Go's package-qualified names. A block
// `namespace Cart.Services { … }` scopes its name to its body; a C# 10 file-scoped
// `namespace Cart.Services;` carries no body and threads its ambient namespace onto
// every sibling that follows it — the same two forms PHP's braced / semicolon
// namespaces take, threaded the same way (extract/symbols.ts collectPhpSymbolDefs).
// Method-ness comes from direct type-body membership, mirroring the Python, Ruby,
// and PHP walkers.
export function collectCsharpSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const join = (prefix: string | undefined, name: string): string =>
    prefix ? `${prefix}.${name}` : name

  // Walk a container's named children in order, threading the ambient namespace a
  // file-scoped `namespace X;` (which carries no body) sets for every sibling after
  // it — the C# analog of PHP's semicolon-form namespace.
  const walkChildren = (
    container: Parser.SyntaxNode,
    nsCtx: string | undefined,
    classCtx: string | undefined,
  ): void => {
    let ns = nsCtx
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i)
      if (!child) continue
      if (child.type === 'file_scoped_namespace_declaration') {
        const nameNode = child.childForFieldName('name')
        if (nameNode) ns = join(nsCtx, nameNode.text)
        continue
      }
      visit(child, ns, classCtx)
    }
  }

  const walkBody = (
    node: Parser.SyntaxNode,
    nsCtx: string | undefined,
    classCtx: string | undefined,
  ): void => {
    const body = node.childForFieldName('body')
    if (body) walkChildren(body, nsCtx, classCtx)
  }

  const visit = (
    node: Parser.SyntaxNode,
    nsCtx: string | undefined,
    classCtx: string | undefined,
  ): void => {
    switch (node.type) {
      case 'namespace_declaration': {
        // Block form `namespace Cart.Services { … }`: scoped to its body. The name
        // is already dotted; nested block namespaces join with `.`.
        const nameNode = node.childForFieldName('name')
        const ns = nameNode ? join(nsCtx, nameNode.text) : nsCtx
        walkBody(node, ns, classCtx)
        return
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'struct_declaration':
      case 'record_declaration': {
        const name = node.childForFieldName('name')?.text
        const full = name ? join(classCtx ?? nsCtx, name) : classCtx
        if (name) push('class', full!, node)
        // Members carry the full type path as their class context, so a nested
        // type reads `Outer.Inner` and a method reads `Type.method`.
        walkBody(node, nsCtx, full)
        return
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('method', join(classCtx ?? nsCtx, name), node)
        // No descent into the method body: a local function is out of scope, the
        // same boundary the JS/TS, Python, Ruby, and PHP walkers hold.
        return
      }
      case 'constructor_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('constructor', join(classCtx ?? nsCtx, name), node)
        return
      }
    }
    walkChildren(node, nsCtx, classCtx)
  }

  walkChildren(root, undefined, undefined)
  return out
}

// Java: a `method_declaration` inside a type body is a method and a
// `constructor_declaration` its constructor (a Java constructor's declared name is
// the type name); `class_declaration`, `interface_declaration`, `enum_declaration`,
// and `record_declaration` all mint as `class`-kind nodes — an interface, enum, or
// record is a class-shaped definition / heritage target, so an INHERITS / IMPLEMENTS
// to any of them has a symbol to land on. Java's scoping is simpler than C#'s: a
// file has at most one file-level `package com.a.b;` that prefixes every top-level
// type, with no nested or block namespaces, so the package is read once from the
// root and there is nothing to thread through siblings. The qualname joins that
// package and the type nesting with `.` (`com.example.cart.CartService.addItem`) —
// Java already writes packages and members with `.`, so normalization is minimal (no
// `::` or `\` to rewrite) and it reduces under ingest's `terminalName` (last-`.`
// split) to the bare method name (`addItem`). A runtime `code.function` of `addItem`
// matches the tiebreaker; a package- or type-qualified form still lands via the
// line-in-span primary — the same keying ADR-192 relies on for Go's
// package-qualified names. Method-ness comes from direct type-body membership,
// mirroring the Python, Ruby, PHP, and C# walkers; a method body is not descended
// into, so a local class is out of scope — the same boundary those walkers hold.
export function collectJavaSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const join = (prefix: string | undefined, name: string): string =>
    prefix ? `${prefix}.${name}` : name

  // Java allows at most one file-level `package com.a.b;`, and it applies to the
  // whole compilation unit — no nesting, no scoping blocks. Read it once from the
  // root; its name node is a `scoped_identifier` (or bare `identifier`) that already
  // carries the dotted form.
  let pkg: string | undefined
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i)
    if (child?.type === 'package_declaration') {
      pkg = child.namedChild(0)?.text
      break
    }
  }

  const walkChildren = (container: Parser.SyntaxNode, classCtx: string | undefined): void => {
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i)
      if (child) visit(child, classCtx)
    }
  }

  const walkBody = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    // `class_body` / `interface_body` / `enum_body` all sit under the `body` field.
    const body = node.childForFieldName('body')
    if (body) walkChildren(body, classCtx)
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        const name = node.childForFieldName('name')?.text
        const full = name ? join(classCtx ?? pkg, name) : classCtx
        if (name) push('class', full!, node)
        // Members carry the full type path as their class context, so a nested type
        // reads `Outer.Inner` and a method reads `Type.method`.
        walkBody(node, full)
        return
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('method', join(classCtx ?? pkg, name), node)
        return
      }
      case 'constructor_declaration': {
        const name = node.childForFieldName('name')?.text
        if (name) push('constructor', join(classCtx ?? pkg, name), node)
        return
      }
    }
    walkChildren(node, classCtx)
  }

  walkChildren(root, undefined)
  return out
}

// Kotlin (ADR-199), the JVM sibling of Java. The fwcd tree-sitter-kotlin grammar
// folds every type-shaped definition into `class_declaration` — a plain `class`, an
// `interface`, an `enum class`, a `data class`, and a `sealed class` are all
// `class_declaration` nodes, distinguished only by an anonymous keyword child — so
// one case covers them all and each mints as a `class`-kind node (a heritage /
// definition target an INHERITS/IMPLEMENTS can land on). `object_declaration`
// (Kotlin's singleton) mints as `class` too, and a `companion_object` is descended
// into without adding a name segment when anonymous, so its members read as members
// of the enclosing type — `FraudService.threshold`, the shape Kotlin itself exposes
// (`FraudService.threshold()`). A `function_declaration` is a `method` inside a type
// body and a `function` at file scope — unlike Java, Kotlin has real top-level
// functions, so method-ness is decided by the class context, mirroring the
// Python/JS walkers rather than Java's always-a-method rule. A `secondary_constructor`
// (`constructor(…)`) mints as a `constructor` named for its enclosing type, the way
// a Java constructor's declared name is its type; the primary constructor is part of
// the class header and carries no independent body, so it is left to the class node.
//
// The grammar exposes no `name` / `body` fields (unlike Java's), so navigation is by
// child node type: a type's name is its `type_identifier`, a function's its
// `simple_identifier`, and the body is the `class_body` / `enum_class_body` child.
// Kotlin's scoping is Java-simple: at most one file-level `package a.b.c` prefixes
// every top-level type — the `package_header`'s `identifier` child already carries
// the dotted form — with no nested or block namespaces to thread. The qualname joins
// that package and the type nesting with `.` (`com.example.fraud.FraudService.check`),
// so it reduces under ingest's `terminalName` (last-`.` split) to the bare function
// name (`check`) a runtime `code.function` matches, the same key the Java/C# walkers
// rely on. A function body is not descended into, so a local function is out of
// scope — the same boundary the sibling walkers hold.
export function collectKotlinSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  const join = (prefix: string | undefined, name: string): string =>
    prefix ? `${prefix}.${name}` : name

  // The first named child of `node` whose type is one of `types`. The grammar has no
  // field names, so a definition's name and body are found by type, not `childForFieldName`.
  const firstChildOfType = (
    node: Parser.SyntaxNode,
    types: readonly string[],
  ): Parser.SyntaxNode | undefined => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child && types.includes(child.type)) return child
    }
    return undefined
  }
  const nameOf = (node: Parser.SyntaxNode, ...types: string[]): string | undefined =>
    firstChildOfType(node, types)?.text
  const bodyOf = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
    firstChildOfType(node, ['class_body', 'enum_class_body'])

  // At most one file-level `package a.b.c` prefixes every top-level type; its
  // `identifier` child already carries the dotted form. Read once from the root.
  let pkg: string | undefined
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i)
    if (child?.type === 'package_header') {
      pkg = child.namedChild(0)?.text
      break
    }
  }

  const walkChildren = (container: Parser.SyntaxNode, classCtx: string | undefined): void => {
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i)
      if (child) visit(child, classCtx)
    }
  }

  const visit = (node: Parser.SyntaxNode, classCtx: string | undefined): void => {
    switch (node.type) {
      case 'class_declaration':
      case 'object_declaration': {
        // class / interface / enum class / data class / sealed class all parse as
        // class_declaration; object is object_declaration. All mint as class-kind.
        const name = nameOf(node, 'type_identifier')
        const full = name ? join(classCtx ?? pkg, name) : classCtx
        if (name) push('class', full!, node)
        const body = bodyOf(node)
        // Members carry the full type path as their class context, so a nested type
        // reads `Outer.Inner` and a method reads `Type.method`.
        if (body) walkChildren(body, full)
        return
      }
      case 'companion_object': {
        // `companion object` — anonymous by default, so it adds no name segment and
        // its members read as members of the enclosing type (`FraudService.threshold`).
        // A named companion (`companion object Factory`) threads its name.
        const name = nameOf(node, 'type_identifier')
        const full = name ? join(classCtx ?? pkg, name) : classCtx ?? pkg
        const body = bodyOf(node)
        if (body) walkChildren(body, full)
        return
      }
      case 'function_declaration': {
        // A method in a type body, a top-level function at file scope.
        const name = nameOf(node, 'simple_identifier')
        if (name) push(classCtx ? 'method' : 'function', join(classCtx ?? pkg, name), node)
        return
      }
      case 'secondary_constructor': {
        // `constructor(…)` — its name is the enclosing type's, the last segment of
        // the class context, matching how a Java constructor's declared name is its type.
        if (classCtx) {
          const typeName = classCtx.slice(classCtx.lastIndexOf('.') + 1)
          push('constructor', join(classCtx, typeName), node)
        }
        return
      }
    }
    walkChildren(node, classCtx)
  }

  walkChildren(root, undefined)
  return out
}

// Rust (ADR-201). A `function_item` is a `function` at module/file scope and a
// `method` inside an `impl_item` (or a `trait_item` — a trait's `function_item`
// default methods and its `function_signature_item` abstract declarations both mint
// as `method`, the way Kotlin's abstract interface method does). `struct_item`,
// `enum_item`, and `trait_item` mint as `class`-kind nodes — a struct, an enum, and
// a trait are the class-shaped definition / heritage targets Rust has, mirroring how
// Java maps interface/enum/record and C# maps struct/record/interface all to `class`.
// Rust has no constructor keyword: an associated `fn new()` is just an associated
// function, so everything inside an `impl` mints as `method` with no `constructor`
// case (the SymbolKind vocabulary is reused, not extended).
//
// Rust addresses definitions with `::` path separators, and this walker keeps that
// native form rather than rewriting it to `.` the way the Ruby/PHP walkers normalize
// their separators: a module's items read `module::item`, an impl's methods read
// `module::Type::method` (keyed on the impl's target type, not the file), and a
// nested module threads `outer::inner::item`. A `mod_item` is a namespace only — it
// scopes the qualname but is not itself a symbol, the way a Java `package` or a C#
// `namespace` scopes without minting. Because the qualname carries `::`, ingest's
// `terminalName` (a last-`.` split) does not reduce it to the bare function name, so
// the `code.function` tiebreaker won't match a `::`-addressed Rust span — but that is
// only the tiebreaker: fusion's primary key is line-in-span (the observed
// `code.lineno` falling inside a SymbolNode's definition span), which is
// language-agnostic and lands a Rust span on its symbol regardless of separator
// (landObservedSymbol, ingest.ts — unchanged). A method body is not descended into,
// so a local `fn` or item is out of scope — the same boundary the sibling walkers hold.
export function collectRustSymbolDefs(root: Parser.SyntaxNode): SymbolDef[] {
  const out: SymbolDef[] = []

  const push = (kind: SymbolKind, qualname: string, node: Parser.SyntaxNode): void => {
    out.push({
      kind,
      qualname,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    })
  }

  // Rust joins path segments with `::`, kept verbatim so a qualname reads the way
  // Rust itself addresses the item (`shipping::Quote::price`).
  const join = (prefix: string | undefined, name: string): string =>
    prefix ? `${prefix}::${name}` : name

  // Emit each `fn` in a type body (an `impl` or a `trait` `declaration_list`) as a
  // method under the type: a `function_item` is a concrete method / associated
  // function, a `function_signature_item` a trait's abstract method (no body — the
  // node itself carries the span). Nested items other than functions (associated
  // types, consts) are not symbols and are skipped.
  const walkTypeBody = (body: Parser.SyntaxNode, typeCtx: string): void => {
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i)
      if (!child) continue
      if (child.type === 'function_item' || child.type === 'function_signature_item') {
        const name = child.childForFieldName('name')?.text
        if (name) push('method', join(typeCtx, name), child)
      }
    }
  }

  const walkChildren = (container: Parser.SyntaxNode, modCtx: string | undefined): void => {
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i)
      if (child) visit(child, modCtx)
    }
  }

  const visit = (node: Parser.SyntaxNode, modCtx: string | undefined): void => {
    switch (node.type) {
      case 'mod_item': {
        // A module scopes the qualname but is not itself a symbol. An inline
        // `mod name { … }` carries a `declaration_list` body its items nest under; a
        // bare `mod name;` (the file-as-module declaration) has no body here.
        const name = node.childForFieldName('name')?.text
        const full = name ? join(modCtx, name) : modCtx
        const body = node.childForFieldName('body')
        if (body) walkChildren(body, full)
        return
      }
      case 'struct_item':
      case 'enum_item': {
        // A struct / enum is a class-kind definition; its fields / variants are not
        // symbols, and Rust methods live in separate `impl` blocks, so there is no
        // body to descend for members.
        const name = node.childForFieldName('name')?.text
        if (name) push('class', join(modCtx, name), node)
        return
      }
      case 'trait_item': {
        // A trait is a class-kind heritage target; its body holds the method
        // signatures / default methods that mint under it.
        const name = node.childForFieldName('name')?.text
        const full = name ? join(modCtx, name) : modCtx
        if (name) push('class', full!, node)
        const body = node.childForFieldName('body')
        if (body && full) walkTypeBody(body, full)
        return
      }
      case 'impl_item': {
        // An `impl Type { … }` / `impl Trait for Type { … }` block is not a symbol;
        // its methods mint under the target type, keyed on the impl's `type` field so
        // `impl Priced for Quote` and the inherent `impl Quote` both address `Quote`.
        const typeName = node.childForFieldName('type')?.text
        const full = typeName ? join(modCtx, typeName) : modCtx
        const body = node.childForFieldName('body')
        if (body && full) walkTypeBody(body, full)
        return
      }
      case 'function_item': {
        // A free function at module / file scope. A `fn` inside an `impl` / `trait`
        // is reached through `walkTypeBody` above, never here, so this is always a
        // plain function. Its body is not descended — a local item is out of scope.
        const name = node.childForFieldName('name')?.text
        if (name) push('function', join(modCtx, name), node)
        return
      }
    }
    walkChildren(node, modCtx)
  }

  walkChildren(root, undefined)
  return out
}

// Dispatch to the walker that reads the file's language. `.py`, `.go`, `.rb`,
// `.php`, `.cs`, `.java`, `.kt`, and `.rs` map to their own definition node types;
// every other mapped extension is JS/TS and rides the shared walker.
export function collectSymbolDefsForExt(ext: string, root: Parser.SyntaxNode): SymbolDef[] {
  switch (ext) {
    case '.py':
      return collectPythonSymbolDefs(root)
    case '.go':
      return collectGoSymbolDefs(root)
    case '.rb':
      return collectRubySymbolDefs(root)
    case '.php':
      return collectPhpSymbolDefs(root)
    case '.cs':
      return collectCsharpSymbolDefs(root)
    case '.java':
      return collectJavaSymbolDefs(root)
    case '.kt':
      return collectKotlinSymbolDefs(root)
    case '.rs':
      return collectRustSymbolDefs(root)
    default:
      return collectSymbolDefs(root)
  }
}

// Same-named siblings in one file (overloads, repeated anonymous-arrow names)
// get an ordinal disambiguator in source order so the id stays collision-free
// without inventing a name (ADR-158). A qualname that appears once keeps the
// clean, disambiguator-free id.
export function disambiguate(defs: SymbolDef[]): { def: SymbolDef; disambiguator?: number }[] {
  const counts = new Map<string, number>()
  for (const def of defs) counts.set(def.qualname, (counts.get(def.qualname) ?? 0) + 1)
  const seen = new Map<string, number>()
  return defs.map((def) => {
    if ((counts.get(def.qualname) ?? 0) <= 1) return { def }
    const ordinal = seen.get(def.qualname) ?? 0
    seen.set(def.qualname, ordinal + 1)
    return { def, disambiguator: ordinal }
  })
}

export async function addSymbols(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const parsers = new Map<string, Parser>()
  const parserForExt = (ext: string): Parser | null => {
    const grammar = SYMBOL_GRAMMAR_BY_EXT[ext]
    if (!grammar) return null
    let parser = parsers.get(ext)
    if (!parser) {
      parser = new Parser()
      parser.setLanguage(grammar)
      parsers.set(ext, parser)
    }
    return parser
  }
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    for (const file of files) {
      const ext = path.extname(file.path)
      const parser = parserForExt(ext)
      if (!parser) continue
      const relPath = toPosix(path.relative(service.dir, file.path))

      let defs: SymbolDef[]
      try {
        const tree = parseSource(parser, file.content)
        defs = collectSymbolDefsForExt(ext, tree.rootNode)
      } catch (err) {
        recordExtractionError('symbol extraction', file.path, err)
        continue
      }
      if (defs.length === 0) continue

      // The file owns its symbols; ensure the FileNode (and the owning
      // `service ──CONTAINS──▶ file` edge) exists before a symbol hangs off it.
      // Idempotent — addFiles already minted it on this pass.
      const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relPath,
      )
      nodesAdded += fn
      edgesAdded += fe

      for (const { def, disambiguator } of disambiguate(defs)) {
        const sid = symbolId(service.pkg.name, relPath, def.qualname, disambiguator)
        if (!graph.hasNode(sid)) {
          const node: SymbolNode = {
            id: sid,
            type: NodeType.SymbolNode,
            kind: def.kind,
            qualname: def.qualname,
            span: { startLine: def.startLine, endLine: def.endLine },
            service: service.pkg.name,
            relPath,
            discoveredVia: 'static',
          }
          graph.addNode(sid, node)
          nodesAdded++
        }
        // `file ──CONTAINS──▶ symbol` — structural ownership, the same tier and
        // shape as `service ──CONTAINS──▶ file` (file-awareness.md §2), evidence
        // pinned to the definition's file:line.
        const containsId = extractedEdgeId(fileNodeId, sid, EdgeType.CONTAINS)
        if (!graph.hasEdge(containsId)) {
          const edge: GraphEdge = {
            id: containsId,
            source: fileNodeId,
            target: sid,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: {
              file: relPath,
              line: def.startLine,
              snippet: snippet(file.content, def.startLine),
            },
          }
          graph.addEdgeWithKey(containsId, fileNodeId, sid, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
