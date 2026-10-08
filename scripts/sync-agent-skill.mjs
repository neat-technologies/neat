#!/usr/bin/env node
// Keep the shipped skill copies and their tool inventory tied to one source.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonicalPath = join(root, 'packages/claude-skill/SKILL.md')
const guidePath = join(root, 'packages/claude-skill/GRAPH_FIRST.md')
const mcpPath = join(root, 'packages/mcp/skill.md')
const pluginPath = join(root, 'plugin/skills/graph-first/SKILL.md')
const manifest = readFileSync(join(root, 'packages/types/src/mcp-tools.ts'), 'utf8')
const server = readFileSync(join(root, 'packages/mcp/src/index.ts'), 'utf8')
const check = process.argv.includes('--check')

const manifestBody = manifest.match(/export const MCP_TOOL_NAMES = \[([\s\S]*?)\] as const/)?.[1]
if (!manifestBody) throw new Error('Cannot read MCP_TOOL_NAMES')
const names = [...manifestBody.matchAll(/'([^']+)'/g)].map((m) => m[1])

function decodeLiteral(literal) {
  const quote = literal[0]
  if (literal.at(-1) !== quote) throw new Error('Unterminated tool description')
  return literal.slice(1, -1).replace(/\\([\\'"nrt])/g, (_, code) =>
    ({ n: '\n', r: '\r', t: '\t' })[code] ?? code,
  )
}

const registrations = new Map()
const pattern = /registerTool\(\s*'([^']+)'\s*,\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g
for (const match of server.matchAll(pattern)) {
  const name = match[1]
  if (registrations.has(name)) throw new Error(`Duplicate MCP registration: ${name}`)
  registrations.set(name, decodeLiteral(match[2]))
}
if (names.length !== registrations.size || names.some((name) => !registrations.has(name))) {
  throw new Error('MCP_TOOL_NAMES and registrations differ')
}

const escapeCell = (value) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const table = [
  '| Tool | Server description |',
  '| --- | --- |',
  ...names.map((name) => `| \`${name}\` | ${escapeCell(registrations.get(name))} |`),
].join('\n')

const start = '<!-- MCP_TOOL_TABLE_START -->'
const end = '<!-- MCP_TOOL_TABLE_END -->'
let canonical = readFileSync(canonicalPath, 'utf8')
const before = canonical.indexOf(start)
const after = canonical.indexOf(end)
if (before < 0 || after < before) throw new Error('Missing generated table markers in canonical skill')
canonical = canonical.slice(0, before + start.length) + '\n' + table + '\n' + canonical.slice(after)

const guideStart = '<!-- GRAPH_FIRST_START -->'
const guideEnd = '<!-- GRAPH_FIRST_END -->'
const guideBefore = canonical.indexOf(guideStart)
const guideAfter = canonical.indexOf(guideEnd)
if (guideBefore < 0 || guideAfter < guideBefore) throw new Error('Missing graph-first guide markers')
const guide = canonical.slice(guideBefore + guideStart.length, guideAfter).trim() + '\n'

const frontmatter = `---\nname: graph-first\ndescription: Query NEAT's live semantic graph before searching files.\n---\n\n`
const outputs = [
  [canonicalPath, canonical],
  [guidePath, guide],
  [mcpPath, canonical],
  [pluginPath, frontmatter + canonical],
]
let stale = false
for (const [path, expected] of outputs) {
  const actual = readFileSync(path, 'utf8')
  if (actual === expected) continue
  stale = true
  if (!check) writeFileSync(path, expected)
  else process.stderr.write(`Skill copy is stale: ${path}\n`)
}
if (check && stale) process.exitCode = 1
