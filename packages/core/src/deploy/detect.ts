/**
 * `neat deploy` substrate detection + artifact generation (ADR-073 §2).
 *
 * Three substrates, detected in order:
 *
 *   1. Docker + `docker compose` present → emit `docker-compose.neat.yml`.
 *   2. Bare machine with `systemctl` available → emit `neat.service`.
 *   3. Fallback → print a `docker run` snippet to stdout.
 *
 * Every branch generates a fresh `NEAT_AUTH_TOKEN` (32 bytes, base64url),
 * prints it once, and never embeds it in the on-disk artifact — the file
 * names the env-var, the operator stores the value out of band.
 *
 * Every branch also prints the OTel env-vars block the operator pastes into
 * their application services' deploy platform.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export type Substrate = 'docker-compose' | 'systemd' | 'docker-run'

export interface DetectOptions {
  cwd?: string
  // Detection is shellable-out by injected probes; tests pass these to avoid
  // depending on the local docker / systemctl installation.
  hasDocker?: () => Promise<boolean>
  hasSystemd?: () => Promise<boolean>
}

export interface DeployArtifact {
  substrate: Substrate
  // Path written to disk; undefined for the docker-run fallback (stdout-only).
  artifactPath?: string
  // The newly generated bearer token. Printed once by the caller, never
  // re-read from disk.
  token: string
  // The body of the artifact. Always returned so callers (and tests) can
  // inspect what was written without re-reading the file.
  contents: string
  // The shell command the operator runs to bring NEAT up on this substrate.
  startCommand: string
}

export function generateToken(): string {
  // 32 bytes → 43-byte base64url (no padding). Plenty of entropy; URL-safe
  // so the operator can paste it into env-var dashboards that escape `=`.
  return randomBytes(32).toString('base64url')
}

async function probeBinary(binary: string, arg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, [arg], { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 2000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export async function detectSubstrate(opts: DetectOptions = {}): Promise<Substrate> {
  const hasDocker = opts.hasDocker ?? (() => probeBinary('docker', 'version'))
  const hasSystemd = opts.hasSystemd ?? (() => probeBinary('systemctl', '--version'))
  if (await hasDocker()) return 'docker-compose'
  if (await hasSystemd()) return 'systemd'
  return 'docker-run'
}

const IMAGE = 'ghcr.io/neat-technologies/neat:latest'

export function emitDockerCompose(cwd: string): string {
  // Compose v3 — declares the three documented ports + a data volume. The
  // operator's deploy platform supplies `NEAT_AUTH_TOKEN`; the file names
  // the var with no default, so a missing env stops the container from
  // coming up rather than running unauthenticated.
  return [
    'services:',
    '  neat:',
    `    image: ${IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    '      NEAT_AUTH_TOKEN: ${NEAT_AUTH_TOKEN:?NEAT_AUTH_TOKEN must be set}',
    '    ports:',
    '      - "8080:8080"',
    '      - "4318:4318"',
    '      - "6328:6328"',
    '    volumes:',
    `      - ${cwd}:/workspace`,
    '      - ./neat-data:/neat-out',
    '',
  ].join('\n')
}

export function emitSystemdUnit(cwd: string): string {
  // Token lives in /etc/neat/neatd.env (NEAT_AUTH_TOKEN=...) so it's readable
  // only by root and the service user. The unit itself stays version-
  // controllable without leaking the secret.
  return [
    '# NEAT_AUTH_TOKEN is read from /etc/neat/neatd.env at startup.',
    '# Put `NEAT_AUTH_TOKEN=<value>` in that file with mode 0640 root:root.',
    '[Unit]',
    'Description=NEAT daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/local/bin/neatd start --foreground',
    `WorkingDirectory=${cwd}`,
    'EnvironmentFile=/etc/neat/neatd.env',
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

export function emitDockerRunSnippet(): string {
  // Single-line `docker run` for substrates we can't detect. Operator pastes
  // their own token in; the variable name keeps the bearer-token-must-be-set
  // shape consistent across all three branches.
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Generate a fresh token once, then store it where your secrets live.',
    ': "${NEAT_AUTH_TOKEN:?NEAT_AUTH_TOKEN must be set}"',
    '',
    `docker run -d --name neat \\`,
    '  -e NEAT_AUTH_TOKEN="$NEAT_AUTH_TOKEN" \\',
    '  -p 8080:8080 -p 4318:4318 -p 6328:6328 \\',
    '  -v "$PWD":/workspace -v /var/lib/neat:/neat-out \\',
    `  ${IMAGE}`,
    '',
  ].join('\n')
}

export interface RenderDeployBlockOptions {
  substrate: Substrate
  // Host the operator's services will reach NEAT at. Defaults to a
  // placeholder so the operator notices and fills it in.
  host?: string
}

// The OTel env-vars block the operator pastes into their deploy platform.
// Format matches the orchestrator summary so the two never drift.
export function renderOtelEnvBlock(token: string, host: string = '<host>'): string {
  return [
    `OTEL_EXPORTER_OTLP_ENDPOINT=https://${host}:4318`,
    `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${token}`,
    'OTEL_SERVICE_NAME=<service>',
  ].join('\n')
}

export async function runDeploy(opts: DetectOptions = {}): Promise<DeployArtifact> {
  const cwd = opts.cwd ?? process.cwd()
  const substrate = await detectSubstrate(opts)
  const token = generateToken()

  switch (substrate) {
    case 'docker-compose': {
      const artifactPath = path.join(cwd, 'docker-compose.neat.yml')
      const contents = emitDockerCompose(cwd)
      await fs.writeFile(artifactPath, contents, 'utf8')
      return {
        substrate,
        artifactPath,
        token,
        contents,
        startCommand: `NEAT_AUTH_TOKEN=${token} docker compose -f ${path.basename(artifactPath)} up -d`,
      }
    }
    case 'systemd': {
      const artifactPath = path.join(cwd, 'neat.service')
      const contents = emitSystemdUnit(cwd)
      await fs.writeFile(artifactPath, contents, 'utf8')
      return {
        substrate,
        artifactPath,
        token,
        contents,
        startCommand: [
          `sudo install -m 0640 -o root -g root <(echo NEAT_AUTH_TOKEN=${token}) /etc/neat/neatd.env`,
          `sudo install -m 0644 neat.service /etc/systemd/system/neat.service`,
          'sudo systemctl daemon-reload && sudo systemctl enable --now neat',
        ].join(' && '),
      }
    }
    case 'docker-run':
    default: {
      const contents = emitDockerRunSnippet()
      // No on-disk artifact for the fallback — operator copies the snippet.
      return {
        substrate: 'docker-run',
        token,
        contents,
        startCommand: `NEAT_AUTH_TOKEN=${token} bash <(cat <<'EOF'\n${contents}EOF\n)`,
      }
    }
  }
}
