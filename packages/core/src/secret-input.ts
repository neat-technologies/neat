// Reading a secret the user hands NEAT without it landing anywhere it
// persists: not argv (shell history, `ps`), not the terminal scrollback, not an
// agent's transcript (Newdryve #10). `--token-stdin` on `neat login` and
// `neat connector add` reads from here: a no-echo prompt on a terminal, or
// whatever is piped in (`pbpaste | neat login --token-stdin …`).

// Prompt for a secret WITHOUT echoing it — the token must not land in the
// terminal scrollback. Returns undefined when stdin is not a TTY. Control keys
// are matched by code point so no literal control bytes sit in this source.
export async function readSecretNoEcho(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin
  if (!stdin.isTTY) return undefined
  process.stdout.write(prompt)
  return new Promise<string>((resolve) => {
    const chars: string[] = []
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
    }
    const onData = (ch: string): void => {
      const code = ch.charCodeAt(0)
      if (ch === '\n' || ch === '\r' || code === 4) {
        // Enter or Ctrl-D — done.
        cleanup()
        process.stdout.write('\n')
        resolve(chars.join(''))
      } else if (code === 3) {
        // Ctrl-C — abort the login without writing anything.
        cleanup()
        process.stdout.write('\n')
        process.exit(130)
      } else if (code === 127 || ch === '\b') {
        // Backspace / delete.
        chars.pop()
      } else {
        chars.push(ch)
      }
    }
    stdin.on('data', onData)
  })
}

/** All of stdin when it is a pipe, without the trailing newline. */
export async function readPipedSecret(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

/** `--token-stdin`: a no-echo prompt on a terminal, else the piped input. */
export async function readTokenStdin(prompt: string): Promise<string | undefined> {
  return process.stdin.isTTY ? readSecretNoEcho(prompt) : readPipedSecret()
}
