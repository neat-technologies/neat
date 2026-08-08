import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as jsoncParse } from 'jsonc-parser'
import {
  runEditorCommand,
  NEAT_MCP_SERVER,
  GRAPH_FIRST_MARKER_OPEN,
  type EditorClientId,
} from '../src/editors-cli.js'

// The editor install verbs — `neat cursor` / `devin` / `gemini` / `qwen` /
// `amazonq` / `roocode` / `zed` — write NEAT's stdio MCP server into each
// client's own config, merge-never-clobber, and (where the client has a single
// always-on rules file) drop the graph-first guidance into it. Everything runs
// against a temp MCP-config path + a temp project dir via the NEAT_<CLIENT>_CONFIG
// override, never the real ~/.cursor / ~/.gemini / ~/.config/zed / etc.

const here = path.dirname(fileURLToPath(import.meta.url))
const SHIPPED_GUIDE = path.resolve(here, '../../claude-skill/GRAPH_FIRST.md')

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-editors-cli-'))
  return await fs.realpath(dir)
}

interface ClientMeta {
  id: EditorClientId
  configEnv: string
  containerKey: string
  // The rules/context file NEAT's guidance lands in, or null for the
  // MCP-config-only verbs (Amazon Q, Roo Code).
  rulesFile: string | null
}

const CLIENTS: ClientMeta[] = [
  { id: 'cursor', configEnv: 'NEAT_CURSOR_CONFIG', containerKey: 'mcpServers', rulesFile: '.cursorrules' },
  { id: 'devin', configEnv: 'NEAT_DEVIN_CONFIG', containerKey: 'mcpServers', rulesFile: '.windsurfrules' },
  { id: 'gemini', configEnv: 'NEAT_GEMINI_CONFIG', containerKey: 'mcpServers', rulesFile: 'GEMINI.md' },
  { id: 'qwen', configEnv: 'NEAT_QWEN_CONFIG', containerKey: 'mcpServers', rulesFile: 'QWEN.md' },
  { id: 'amazonq', configEnv: 'NEAT_AMAZONQ_CONFIG', containerKey: 'mcpServers', rulesFile: null },
  { id: 'roocode', configEnv: 'NEAT_ROOCODE_CONFIG', containerKey: 'mcpServers', rulesFile: null },
  { id: 'zed', configEnv: 'NEAT_ZED_CONFIG', containerKey: 'context_servers', rulesFile: '.rules' },
]

interface Env {
  mcpPath: string
  rulesPath: string
  projectDir: string
}

// Run against a temp MCP config path + a temp project dir, muting stdout/stderr.
async function withTmpEnv<T>(
  configEnv: string,
  rulesFile: string | null,
  fn: (env: Env) => Promise<T>,
): Promise<T> {
  const root = await makeTmp()
  tmpDirs.push(root)
  const mcpPath = path.join(root, 'client', 'mcp.json')
  const projectDir = path.join(root, 'proj')
  await fs.mkdir(projectDir, { recursive: true })
  // A placeholder path when the client has no rules file — it should never be
  // written, and tests that touch rules only run for clients that have one.
  const rulesPath = path.join(projectDir, rulesFile ?? '__no_rules_file__')

  const prevCfg = process.env[configEnv]
  const prevLog = console.log
  const prevErr = console.error
  process.env[configEnv] = mcpPath
  console.log = () => {}
  console.error = () => {}
  try {
    return await fn({ mcpPath, rulesPath, projectDir })
  } finally {
    console.log = prevLog
    console.error = prevErr
    if (prevCfg === undefined) delete process.env[configEnv]
    else process.env[configEnv] = prevCfg
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

for (const client of CLIENTS) {
  describe(`neat ${client.id} --apply`, () => {
    it('writes a valid MCP config carrying the neat server (and, where the client has one, a rules file with the guidance block)', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, rulesPath, projectDir }) => {
        const code = await runEditorCommand(client.id, ['--apply'], projectDir)
        expect(code).toBe(0)

        // The config landed at the NEAT_<CLIENT>_CONFIG override path.
        expect(await exists(mcpPath)).toBe(true)
        const mcp = jsoncParse(await fs.readFile(mcpPath, 'utf8'))
        const servers = mcp[client.containerKey]
        expect(servers.neat).toEqual(NEAT_MCP_SERVER)
        // Flat command-string shape, not a nested command object.
        expect(typeof servers.neat.command).toBe('string')
        expect(servers.neat.command).toBe('npx')
        expect(servers.neat.args).toEqual(['-y', '@neat.is/mcp'])

        if (client.rulesFile) {
          const rules = await fs.readFile(rulesPath, 'utf8')
          expect(rules).toContain(GRAPH_FIRST_MARKER_OPEN)
          // The guidance itself, verbatim from the shipped GRAPH_FIRST.md.
          const guide = await fs.readFile(SHIPPED_GUIDE, 'utf8')
          expect(rules).toContain(guide.trim())
        } else {
          // MCP-config-only verbs never write a rules file.
          expect(await exists(rulesPath)).toBe(false)
        }
      })
    })

    it('re-run is idempotent — files are byte-identical, one server, one block', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, rulesPath, projectDir }) => {
        await runEditorCommand(client.id, ['--apply'], projectDir)
        const mcp1 = await fs.readFile(mcpPath, 'utf8')

        await runEditorCommand(client.id, ['--apply'], projectDir)
        const mcp2 = await fs.readFile(mcpPath, 'utf8')

        expect(mcp2).toBe(mcp1)
        // Exactly one neat server after re-running.
        expect(Object.keys(jsoncParse(mcp2)[client.containerKey])).toEqual(['neat'])

        if (client.rulesFile) {
          const rules2 = await fs.readFile(rulesPath, 'utf8')
          const openCount = rules2.split(GRAPH_FIRST_MARKER_OPEN).length - 1
          expect(openCount).toBe(1)
        }
      })
    })

    it('preserves an existing MCP server and other top-level keys', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, projectDir }) => {
        await fs.mkdir(path.dirname(mcpPath), { recursive: true })
        await fs.writeFile(
          mcpPath,
          JSON.stringify({
            [client.containerKey]: {
              github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
            },
            someOtherKey: { keep: true },
          }),
        )

        const code = await runEditorCommand(client.id, ['--apply'], projectDir)
        expect(code).toBe(0)

        const mcp = jsoncParse(await fs.readFile(mcpPath, 'utf8'))
        // The user's server and unrelated top-level key survive untouched.
        expect(mcp[client.containerKey].github).toEqual({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        })
        expect(mcp.someOtherKey).toEqual({ keep: true })
        // And ours is added alongside.
        expect(mcp[client.containerKey].neat).toEqual(NEAT_MCP_SERVER)
      })
    })

    it('plan mode (no --apply) writes nothing', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, rulesPath, projectDir }) => {
        const code = await runEditorCommand(client.id, [], projectDir)
        expect(code).toBe(0)
        expect(await exists(mcpPath)).toBe(false)
        expect(await exists(rulesPath)).toBe(false)
      })
    })

    it('malformed existing MCP config fails honest — exit 1, no partial write', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, rulesPath, projectDir }) => {
        await fs.mkdir(path.dirname(mcpPath), { recursive: true })
        await fs.writeFile(mcpPath, '{ this is not json')

        const code = await runEditorCommand(client.id, ['--apply'], projectDir)
        expect(code).toBe(1)
        // The bad file is left exactly as it was, and no rules file is created.
        expect(await fs.readFile(mcpPath, 'utf8')).toBe('{ this is not json')
        if (client.rulesFile) expect(await exists(rulesPath)).toBe(false)
      })
    })

    it('rejects an unknown flag with exit code 2', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ projectDir }) => {
        expect(await runEditorCommand(client.id, ['--bogus'], projectDir)).toBe(2)
      })
    })

    if (client.rulesFile) {
      it('preserves hand-written rules content, fencing only NEAT\'s block', async () => {
        await withTmpEnv(client.configEnv, client.rulesFile, async ({ rulesPath, projectDir }) => {
          await fs.writeFile(rulesPath, '# My project rules\n\nAlways write tests.\n')
          await runEditorCommand(client.id, ['--apply'], projectDir)

          const rules = await fs.readFile(rulesPath, 'utf8')
          expect(rules).toContain('# My project rules')
          expect(rules).toContain('Always write tests.')
          expect(rules).toContain(GRAPH_FIRST_MARKER_OPEN)

          // A re-run still leaves exactly one block and keeps the user's text.
          await runEditorCommand(client.id, ['--apply'], projectDir)
          const again = await fs.readFile(rulesPath, 'utf8')
          expect(again.split(GRAPH_FIRST_MARKER_OPEN).length - 1).toBe(1)
          expect(again).toContain('Always write tests.')
        })
      })
    }
  })
}

// Zed is the one client whose config is JSONC: a fresh settings.json ships with
// `//` comments, so the merge edits the file in place rather than reparsing and
// rewriting it. The comments — and every other setting — must survive.
describe('neat zed — JSONC settings.json', () => {
  it('a config with // comments survives --apply: comments kept, context_servers.neat inserted, flat command string written', async () => {
    await withTmpEnv('NEAT_ZED_CONFIG', '.rules', async ({ mcpPath, projectDir }) => {
      await fs.mkdir(path.dirname(mcpPath), { recursive: true })
      const original = [
        '{',
        '  // Zed settings — a comment the user wrote and must keep',
        '  "theme": "One Dark",',
        '  "buffer_font_size": 15, // trailing inline comment',
        '  "context_servers": {',
        '    // an MCP server the user already added by hand',
        '    "other": { "command": "foo", "args": ["bar"] }',
        '  }',
        '}',
        '',
      ].join('\n')
      await fs.writeFile(mcpPath, original)

      const code = await runEditorCommand('zed', ['--apply'], projectDir)
      expect(code).toBe(0)

      const after = await fs.readFile(mcpPath, 'utf8')
      // Every comment survives — the whole point of editing JSONC in place.
      expect(after).toContain('// Zed settings — a comment the user wrote and must keep')
      expect(after).toContain('// trailing inline comment')
      expect(after).toContain('// an MCP server the user already added by hand')
      // User settings survive too.
      expect(after).toContain('"theme": "One Dark"')

      const parsed = jsoncParse(after)
      // The user's existing server is untouched, ours is added alongside.
      expect(parsed.context_servers.other).toEqual({ command: 'foo', args: ['bar'] })
      expect(parsed.context_servers.neat).toEqual(NEAT_MCP_SERVER)
      // Flat command-string shape Zed's current schema expects (not the legacy
      // nested command:{path,args} form).
      expect(typeof parsed.context_servers.neat.command).toBe('string')
      expect(parsed.context_servers.neat.command).toBe('npx')
      expect(parsed.context_servers.neat.args).toEqual(['-y', '@neat.is/mcp'])
    })
  })

  it('re-run over a commented config is a byte-identical no-op', async () => {
    await withTmpEnv('NEAT_ZED_CONFIG', '.rules', async ({ mcpPath, projectDir }) => {
      await fs.mkdir(path.dirname(mcpPath), { recursive: true })
      await fs.writeFile(
        mcpPath,
        ['{', '  // keep me', '  "theme": "One Dark"', '}', ''].join('\n'),
      )
      await runEditorCommand('zed', ['--apply'], projectDir)
      const first = await fs.readFile(mcpPath, 'utf8')
      await runEditorCommand('zed', ['--apply'], projectDir)
      const second = await fs.readFile(mcpPath, 'utf8')
      expect(second).toBe(first)
      expect(second).toContain('// keep me')
    })
  })
})
