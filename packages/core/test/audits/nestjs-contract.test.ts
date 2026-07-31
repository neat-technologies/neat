import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../../../..')

describe('ADR-155 NestJS compatibility contract', () => {
  it('records the fusion decision and governed extraction/installer scope', () => {
    const decisions = readFileSync(path.join(REPO, 'docs/decisions.md'), 'utf8')
    const extraction = readFileSync(path.join(REPO, 'docs/contracts/static-extraction.md'), 'utf8')
    const installerScope = readFileSync(
      path.join(REPO, 'docs/contracts/installer-scope.md'),
      'utf8',
    )

    expect(decisions).toMatch(/ADR-155 — NestJS decorator routes/)
    expect(extraction).toMatch(/\| NestJS \|/)
    expect(extraction).toMatch(/@nestjs\/core/)
    expect(installerScope).toMatch(/NestJS uses the vanilla Node installer path/)
  })

  it('keeps the in-scope baseline fixture in the CI test corpus', () => {
    const fixture = path.join(
      REPO,
      'packages/core/test/fixtures/nestjs-baseline/src/users.controller.ts',
    )
    expect(existsSync(fixture)).toBe(true)
  })
})
