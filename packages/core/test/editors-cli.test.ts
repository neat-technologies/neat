import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  runEditorCommand,
  NEAT_MCP_SERVER,
  GRAPH_FIRST_MARKER_OPEN,
  GRAPH_FIRST_MARKER_CLOSE,
} from '../src/editors-cli.js'

// `neat cursor` / `neat windsurf` — install NEAT's MCP server + graph-first
// guidance into the two VS Code-family clients. Everything runs against a temp
// MCP-config path + a temp project dir, never the real ~/.cursor or ~/.codeium.

const here = path.dirname(fileURLToPath(import.meta.url))
const SHIPPED_GUIDE = path.resolve(here, '../../claude-skill/GRAPH_FIRST.md')

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-editors-cli-'))
  return await fs.realpath(dir)
}

// Each client differs only in its config-path env override and rules filename.
const CLIENTS = [
  { id: 'cursor' as const, configEnv: 'NEAT_CURSOR_CONFIG', rulesFile: '.cursorrules' },
  { id: 'windsurf' as const, configEnv: 'NEAT_WINDSURF_CONFIG', rulesFile: '.windsurfrules' },
]

interface Env {
  mcpPath: string
  rulesPath: string
  projectDir: string
}

// Run against a temp MCP config path + a temp project dir, muting stdout/stderr.
async function withTmpEnv<T>(
  configEnv: string,
  rulesFile: string,
  fn: (env: Env) => Promise<T>,
): Promise<T> {
  const root = await makeTmp()
  tmpDirs.push(root)
  const mcpPath = path.join(root, 'client', 'mcp.json')
  const projectDir = path.join(root, 'proj')
  await fs.mkdir(projectDir, { recursive: true })
  const rulesPath = path.join(projectDir, rulesFile)

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
    it('writes a valid MCP config carrying the neat server and a rules file with the guidance block', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, rulesPath, projectDir }) => {
        const code = await runEditorCommand(client.id, ['--apply'], projectDir)
        expect(code).toBe(0)

        const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf8'))
        expect(mcp.mcpServers.neat).toEqual(NEAT_MCP_SERVER)
        expect(mcp.mcpServers.neat.command).toBe('npx')
        expect(mcp.mcpServers.neat.args).toEqual(['-y', '@neat.is/mcp'])

        const rules = await fs.readFile(rulesPath, 'utf8')
        expect(rules).toContain(GRAPH_FIRST_MARKER_OPEN)
        expect(rules).toContain(GRAPH_FIRST_MARKER_CLOSE)
        // The guidance itself, verbatim from the shipped GRAPH_FIRST.md.
        const guide = await fs.readFile(SHIPPED_GUIDE, 'utf8')
        expect(rules).toContain(guide.trim())
      })
    })

    it('re-run is idempotent — files are byte-identical, one server, one block', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, rulesPath, projectDir }) => {
        await runEditorCommand(client.id, ['--apply'], projectDir)
        const mcp1 = await fs.readFile(mcpPath, 'utf8')
        const rules1 = await fs.readFile(rulesPath, 'utf8')

        await runEditorCommand(client.id, ['--apply'], projectDir)
        const mcp2 = await fs.readFile(mcpPath, 'utf8')
        const rules2 = await fs.readFile(rulesPath, 'utf8')

        expect(mcp2).toBe(mcp1)
        expect(rules2).toBe(rules1)

        // Exactly one neat server and one guidance block after re-running.
        const openCount = rules2.split(GRAPH_FIRST_MARKER_OPEN).length - 1
        expect(openCount).toBe(1)
        expect(Object.keys(JSON.parse(mcp2).mcpServers)).toEqual(['neat'])
      })
    })

    it('preserves an existing MCP server and other top-level keys', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ mcpPath, projectDir }) => {
        await fs.mkdir(path.dirname(mcpPath), { recursive: true })
        await fs.writeFile(
          mcpPath,
          JSON.stringify({
            mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
            someOtherKey: { keep: true },
          }),
        )

        const code = await runEditorCommand(client.id, ['--apply'], projectDir)
        expect(code).toBe(0)

        const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf8'))
        // The user's server and unrelated top-level key survive untouched.
        expect(mcp.mcpServers.github).toEqual({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        })
        expect(mcp.someOtherKey).toEqual({ keep: true })
        // And ours is added alongside.
        expect(mcp.mcpServers.neat).toEqual(NEAT_MCP_SERVER)
      })
    })

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
        // The bad file is left exactly as it was, and the rules file is never
        // created — nothing partial.
        expect(await fs.readFile(mcpPath, 'utf8')).toBe('{ this is not json')
        expect(await exists(rulesPath)).toBe(false)
      })
    })

    it('rejects an unknown flag with exit code 2', async () => {
      await withTmpEnv(client.configEnv, client.rulesFile, async ({ projectDir }) => {
        expect(await runEditorCommand(client.id, ['--bogus'], projectDir)).toBe(2)
      })
    })
  })
}
