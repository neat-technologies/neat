import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { classifyLockHolder, lockHolderMessage, type LockHolderProbe } from '../src/registry.js'

// #432 — `neat init` used to hang the full lock timeout and then tell the user
// to "remove the file by hand" regardless of who held the lock. Following that
// while neatd is alive corrupts the registry for the live daemon. The holder
// resolution now names the holder and gates the remove-by-hand advice on there
// being no live daemon.

// Fake PIDs the probe treats as alive — distinct from our own process.pid so
// the self-contention guard doesn't swallow them. DEAD_PID is never reported
// alive.
const COMMAND_PID = 424242
const DAEMON_PID = 525252
const DEAD_PID = 2 ** 30

function probe(over: Partial<LockHolderProbe> = {}): LockHolderProbe {
  const alive = new Set([COMMAND_PID, DAEMON_PID])
  return {
    isPidAlive: (pid) => alive.has(pid),
    daemonPidFromFile: async () => undefined,
    daemonResponds: async () => false,
    ...over,
  }
}

describe('classifyLockHolder', () => {
  let tmpDir: string
  let lockPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-lock-'))
    lockPath = path.join(tmpDir, 'projects.json.lock')
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reports the daemon when a live daemon answers /health, even for an empty orphan lock', async () => {
    // The real-world trigger: a 0-byte orphan lock left on disk while neatd
    // runs. No PID in the lock, but the daemon is alive and answering.
    await fs.writeFile(lockPath, '', 'utf8')
    const holder = await classifyLockHolder(
      lockPath,
      probe({
        daemonPidFromFile: async () => DAEMON_PID,
        daemonResponds: async () => true,
      }),
    )
    expect(holder).toEqual({ kind: 'daemon', pid: DAEMON_PID })

    const msg = lockHolderMessage(holder, lockPath, 5000)
    expect(msg).toContain('neat daemon')
    expect(msg).toContain(`pid ${DAEMON_PID}`)
    expect(msg).not.toContain('remove the file by hand')
  })

  it('reports the daemon without an HTTP probe when the lock PID is the daemon PID', async () => {
    await fs.writeFile(lockPath, `${DAEMON_PID}\n`, 'utf8')
    let probed = false
    const holder = await classifyLockHolder(
      lockPath,
      probe({
        daemonPidFromFile: async () => DAEMON_PID,
        daemonResponds: async () => {
          probed = true
          return false
        },
      }),
    )
    expect(holder).toEqual({ kind: 'daemon', pid: DAEMON_PID })
    // The lock already named the daemon, so we don't need the network probe.
    expect(probed).toBe(false)
  })

  it('reports another neat command for a live non-daemon holder', async () => {
    await fs.writeFile(lockPath, `${COMMAND_PID}\n`, 'utf8')
    const holder = await classifyLockHolder(
      lockPath,
      // No daemon running, and the port does not answer.
      probe({ daemonPidFromFile: async () => undefined, daemonResponds: async () => false }),
    )
    expect(holder).toEqual({ kind: 'command', pid: COMMAND_PID })

    const msg = lockHolderMessage(holder, lockPath, 5000)
    expect(msg).toContain('Another neat command')
    expect(msg).toContain(`pid ${COMMAND_PID}`)
    expect(msg).not.toContain('remove the file by hand')
  })

  it('falls back to the stale remediation for a dead PID and no daemon', async () => {
    await fs.writeFile(lockPath, `${DEAD_PID}\n`, 'utf8')
    const holder = await classifyLockHolder(lockPath, probe())
    expect(holder).toEqual({ kind: 'stale' })

    const msg = lockHolderMessage(holder, lockPath, 5000)
    expect(msg).toContain('remove the file by hand')
    expect(msg).toContain(lockPath)
  })

  it('does not classify our own process as the blocking daemon', async () => {
    // A daemon serializing two of its own registry writes contends with itself.
    // Its own PID in both the lock and the pidfile must not fast-fail it.
    await fs.writeFile(lockPath, `${process.pid}\n`, 'utf8')
    const holder = await classifyLockHolder(
      lockPath,
      probe({
        isPidAlive: () => true,
        daemonPidFromFile: async () => process.pid,
        daemonResponds: async () => true,
      }),
    )
    expect(holder.kind).toBe('stale')
  })
})
