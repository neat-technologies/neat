import { describe, it, expect } from 'vitest'
import { detectHost, isVSCodeProper, forkDescriptorFor } from '../src/host'

describe('host detection (VS Code vs fork)', () => {
  it('stock VS Code and Insiders resolve to the native path', () => {
    expect(detectHost('Visual Studio Code')).toEqual({ kind: 'vscode' })
    expect(detectHost('Visual Studio Code - Insiders')).toEqual({ kind: 'vscode' })
    expect(isVSCodeProper('Visual Studio Code')).toBe(true)
  })

  it('Cursor is a fork and maps to the `neat cursor` verb + ~/.cursor/mcp.json', () => {
    const v = detectHost('Cursor')
    expect(v.kind).toBe('fork')
    if (v.kind !== 'fork') throw new Error('unreachable')
    expect(v.fork.id).toBe('cursor')
    expect(v.fork.cliVerb).toBe('cursor')
    expect(v.fork.configHomeSegments).toEqual(['.cursor', 'mcp.json'])
  })

  it('Windsurf / Cascade maps to the `neat devin` verb + the legacy Codeium path', () => {
    for (const name of ['Windsurf', 'Cascade']) {
      const fork = forkDescriptorFor(name)
      expect(fork.id).toBe('windsurf')
      expect(fork.cliVerb).toBe('devin')
      expect(fork.configHomeSegments).toEqual(['.codeium', 'windsurf', 'mcp_config.json'])
    }
  })

  it('Kiro is a fork with a config path but no CLI verb', () => {
    const fork = forkDescriptorFor('Kiro')
    expect(fork.id).toBe('kiro')
    expect(fork.cliVerb).toBeNull()
    expect(fork.configHomeSegments).toEqual(['.kiro', 'settings', 'mcp.json'])
  })

  it('an unknown fork falls back to no verb and no guessed path', () => {
    const v = detectHost('Some Other Editor')
    expect(v.kind).toBe('fork')
    if (v.kind !== 'fork') throw new Error('unreachable')
    expect(v.fork.id).toBe('unknown')
    expect(v.fork.cliVerb).toBeNull()
    expect(v.fork.configHomeSegments).toBeNull()
  })

  it('is case-insensitive and tolerates build suffixes', () => {
    expect(detectHost('cursor nightly').kind).toBe('fork')
    expect(forkDescriptorFor('CURSOR').id).toBe('cursor')
    expect(isVSCodeProper('VSCodium')).toBe(false)
  })

  it('an undefined appName is treated as a fork, never as stock VS Code', () => {
    expect(isVSCodeProper(undefined)).toBe(false)
    expect(detectHost(undefined).kind).toBe('fork')
  })
})
