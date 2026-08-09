import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as jsoncParse } from 'jsonc-parser'
import {
  runEditorCommand,
  NEAT_MCP_SERVER,
  NEAT_OPENCODE_SERVER,
  NEAT_CRUSH_SERVER,
  GRAPH_FIRST_MARKER_OPEN,
  type EditorClientId,
} from '../src/editors-cli.js'

// The editor install verbs — `neat cursor` / `devin` / `gemini` / `qwen` /
// `amazonq` / `roocode` / `zed` / `opencode` / `crush` — write NEAT's stdio MCP
// server into each client's own config, merge-never-clobber, and (where the
// client has a single always-on rules file) drop the graph-first guidance into
// it. Everything runs against a temp MCP-config path + a temp project dir via the
// NEAT_<CLIENT>_CONFIG override, never the real ~/.cursor / ~/.gemini /
// ~/.config/zed / ~/.config/opencode / ~/.config/crush / etc.

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
  // The server object written under `<containerKey>.neat`. Omitted for the
  // clients that take the flat NEAT_MCP_SERVER shape; OpenCode and Crush set
  // their own.
  serverEntry?: Record<string, unknown>
}

const CLIENTS: ClientMeta[] = [
  { id: 'cursor', configEnv: 'NEAT_CURSOR_CONFIG', containerKey: 'mcpServers', rulesFile: '.cursorrules' },
  { id: 'devin', configEnv: 'NEAT_DEVIN_CONFIG', containerKey: 'mcpServers', rulesFile: '.windsurfrules' },
  { id: 'gemini', configEnv: 'NEAT_GEMINI_CONFIG', containerKey: 'mcpServers', rulesFile: 'GEMINI.md' },
  { id: 'qwen', configEnv: 'NEAT_QWEN_CONFIG', containerKey: 'mcpServers', rulesFile: 'QWEN.md' },
  { id: 'amazonq', configEnv: 'NEAT_AMAZONQ_CONFIG', containerKey: 'mcpServers', rulesFile: null },
  { id: 'roocode', configEnv: 'NEAT_ROOCODE_CONFIG', containerKey: 'mcpServers', rulesFile: null },
  { id: 'zed', configEnv: 'NEAT_ZED_CONFIG', containerKey: 'context_servers', rulesFile: '.rules' },
  {
    id: 'opencode',
    configEnv: 'NEAT_OPENCODE_CONFIG',
    containerKey: 'mcp',
    rulesFile: 'AGENTS.md',
    serverEntry: { ...NEAT_OPENCODE_SERVER },
  },
  {
    id: 'crush',
    configEnv: 'NEAT_CRUSH_CONFIG',
    containerKey: 'mcp',
    rulesFile: 'AGENTS.md',
    serverEntry: { ...NEAT_CRUSH_SERVER },
  },
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
        // Exactly this client's server object — the flat {command, args} for
        // most, OpenCode's / Crush's own shape where they carry one. toEqual
        // pins the full shape (per-client shape specifics get their own blocks).
        expect(servers.neat).toEqual(client.serverEntry ?? NEAT_MCP_SERVER)

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
        // And ours is added alongside, in this client's server shape.
        expect(mcp[client.containerKey].neat).toEqual(client.serverEntry ?? NEAT_MCP_SERVER)
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

// OpenCode and Crush are the two clients that share the `mcp` container key but
// carry their own server-object shape, so each gets an explicit shape lock on top
// of the generic matrix above.
describe('neat opencode — the mcp-key, array-command shape', () => {
  it('writes OpenCode\'s server object: array command, type "local", enabled', async () => {
    await withTmpEnv('NEAT_OPENCODE_CONFIG', 'AGENTS.md', async ({ mcpPath, projectDir }) => {
      const code = await runEditorCommand('opencode', ['--apply'], projectDir)
      expect(code).toBe(0)

      const parsed = jsoncParse(await fs.readFile(mcpPath, 'utf8'))
      // Servers live under `mcp`, not `mcpServers`.
      expect(parsed.mcp.neat).toEqual(NEAT_OPENCODE_SERVER)
      // The distinctive bits: command is an ARRAY, type is "local", enabled true.
      expect(Array.isArray(parsed.mcp.neat.command)).toBe(true)
      expect(parsed.mcp.neat.command).toEqual(['npx', '-y', '@neat.is/mcp'])
      expect(parsed.mcp.neat.type).toBe('local')
      expect(parsed.mcp.neat.enabled).toBe(true)
    })
  })

  it('preserves another mcp server and top-level keys under the mcp key', async () => {
    await withTmpEnv('NEAT_OPENCODE_CONFIG', 'AGENTS.md', async ({ mcpPath, projectDir }) => {
      await fs.mkdir(path.dirname(mcpPath), { recursive: true })
      await fs.writeFile(
        mcpPath,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          mcp: { other: { type: 'local', command: ['foo'], enabled: true } },
          theme: 'opencode',
        }),
      )
      await runEditorCommand('opencode', ['--apply'], projectDir)

      const parsed = jsoncParse(await fs.readFile(mcpPath, 'utf8'))
      expect(parsed.mcp.other).toEqual({ type: 'local', command: ['foo'], enabled: true })
      expect(parsed.$schema).toBe('https://opencode.ai/config.json')
      expect(parsed.theme).toBe('opencode')
      expect(parsed.mcp.neat).toEqual(NEAT_OPENCODE_SERVER)
    })
  })

  it('resolves the config from NEAT_OPENCODE_CONFIG and re-run is a byte-identical no-op', async () => {
    await withTmpEnv('NEAT_OPENCODE_CONFIG', 'AGENTS.md', async ({ mcpPath, projectDir }) => {
      await runEditorCommand('opencode', ['--apply'], projectDir)
      const first = await fs.readFile(mcpPath, 'utf8')
      await runEditorCommand('opencode', ['--apply'], projectDir)
      const second = await fs.readFile(mcpPath, 'utf8')
      expect(second).toBe(first)
      expect(Object.keys(jsoncParse(second).mcp)).toEqual(['neat'])
    })
  })
})

describe('neat crush — the mcp-key, type:stdio shape', () => {
  it('writes Crush\'s server object: type "stdio", string command, args', async () => {
    await withTmpEnv('NEAT_CRUSH_CONFIG', 'AGENTS.md', async ({ mcpPath, projectDir }) => {
      const code = await runEditorCommand('crush', ['--apply'], projectDir)
      expect(code).toBe(0)

      const parsed = jsoncParse(await fs.readFile(mcpPath, 'utf8'))
      expect(parsed.mcp.neat).toEqual(NEAT_CRUSH_SERVER)
      // The distinctive bits: explicit type "stdio", string command, args array.
      expect(parsed.mcp.neat.type).toBe('stdio')
      expect(typeof parsed.mcp.neat.command).toBe('string')
      expect(parsed.mcp.neat.command).toBe('npx')
      expect(parsed.mcp.neat.args).toEqual(['-y', '@neat.is/mcp'])
    })
  })

  it('preserves another mcp server and top-level keys under the mcp key', async () => {
    await withTmpEnv('NEAT_CRUSH_CONFIG', 'AGENTS.md', async ({ mcpPath, projectDir }) => {
      await fs.mkdir(path.dirname(mcpPath), { recursive: true })
      await fs.writeFile(
        mcpPath,
        JSON.stringify({
          mcp: { other: { type: 'stdio', command: 'node', args: ['x.js'] } },
          options: { keep: true },
        }),
      )
      await runEditorCommand('crush', ['--apply'], projectDir)

      const parsed = jsoncParse(await fs.readFile(mcpPath, 'utf8'))
      expect(parsed.mcp.other).toEqual({ type: 'stdio', command: 'node', args: ['x.js'] })
      expect(parsed.options).toEqual({ keep: true })
      expect(parsed.mcp.neat).toEqual(NEAT_CRUSH_SERVER)
    })
  })

  it('resolves the config from NEAT_CRUSH_CONFIG and re-run is a byte-identical no-op', async () => {
    await withTmpEnv('NEAT_CRUSH_CONFIG', 'AGENTS.md', async ({ mcpPath, projectDir }) => {
      await runEditorCommand('crush', ['--apply'], projectDir)
      const first = await fs.readFile(mcpPath, 'utf8')
      await runEditorCommand('crush', ['--apply'], projectDir)
      const second = await fs.readFile(mcpPath, 'utf8')
      expect(second).toBe(first)
      expect(Object.keys(jsoncParse(second).mcp)).toEqual(['neat'])
    })
  })
})
