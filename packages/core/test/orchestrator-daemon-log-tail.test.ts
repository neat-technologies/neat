import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDaemonLogTail, daemonLogPath } from '../src/orchestrator.js'

// #1238 — a bare run that can't bring the daemon up waits 60 seconds and then
// says only "daemon did not become ready within 60000ms". The actual reason is
// already written, in plain English, to neat-out/daemon.log — a file a
// first-timer has no reason to know exists. The timeout now prints its tail.

const dirs: string[] = []

async function project(log?: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-daemonlog-')))
  dirs.push(dir)
  if (log !== undefined) {
    await fs.mkdir(path.join(dir, 'neat-out'), { recursive: true })
    await fs.writeFile(daemonLogPath(dir), log, 'utf8')
  }
  return dir
}

afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

describe('readDaemonLogTail', () => {
  it('returns the last meaningful lines, newest last', async () => {
    const dir = await project('one\ntwo\nthree\nfour\n')
    expect(await readDaemonLogTail(dir, 2)).toEqual(['three', 'four'])
  })

  it('keeps a multi-line diagnostic intact', async () => {
    // The message that surfaced this issue runs to three lines and is only
    // useful whole.
    const diagnostic = [
      'neatd: REST listening on http://127.0.0.1:8081',
      'neatd: OTLP listening on http://127.0.0.1:4319/v1/traces',
      'neatd: web UI standalone build missing at .../server.js.',
      '       run `npm run build --workspace @neat.is/web` first, or set NEAT_WEB_DISABLED=1.',
    ].join('\n')
    const dir = await project(`${diagnostic}\n`)
    const tail = await readDaemonLogTail(dir)
    expect(tail).toHaveLength(4)
    expect(tail[2]).toContain('web UI standalone build missing')
    expect(tail[3]).toContain('NEAT_WEB_DISABLED=1')
  })

  it('drops blank lines so the tail is all signal', async () => {
    const dir = await project('first\n\n\n   \nlast\n')
    expect(await readDaemonLogTail(dir)).toEqual(['first', 'last'])
  })

  it('returns nothing rather than throwing when there is no log', async () => {
    // This runs on a path that has already failed; it must not turn a bad
    // message into a crash.
    const dir = await project()
    expect(await readDaemonLogTail(dir)).toEqual([])
  })

  it('returns nothing for an empty or whitespace-only log', async () => {
    expect(await readDaemonLogTail(await project(''))).toEqual([])
    expect(await readDaemonLogTail(await project('\n\n   \n'))).toEqual([])
  })

  it('caps the tail so a long boot sequence is not pasted wholesale', async () => {
    const dir = await project(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'))
    const tail = await readDaemonLogTail(dir)
    expect(tail.length).toBeLessThanOrEqual(12)
    expect(tail.at(-1)).toBe('line 499')
  })

  it('handles CRLF, so a Windows-written log reads the same', async () => {
    const dir = await project('alpha\r\nbeta\r\n')
    expect(await readDaemonLogTail(dir)).toEqual(['alpha', 'beta'])
  })
})
