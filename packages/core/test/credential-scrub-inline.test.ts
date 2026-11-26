import { describe, expect, it } from 'vitest'
import { redactSecretValues } from '../src/credential-scrub.js'
import { clipEvidence } from '../src/extract/calls/shared.js'

// Credentials written inline in source or error text (#1769): an evidence
// snippet is a source line, so the scrub has to read the ways JS, TS and Python
// usually spell a credential, not only JSON fields and upper-case env lines.

describe('redactSecretValues: inline credentials', () => {
  const cases: Array<[string, string, string]> = [
    ['unquoted object key', 'new Client({ host: "db", user: "admin", password: "examplePassw0rd" })', 'new Client({ host: "db", user: "admin", password: "[REDACTED]" })'],
    ['camelCase key, single quotes', "axios.post(url, { apiKey: 'exampleKeyValue123' })", "axios.post(url, { apiKey: '[REDACTED]' })"],
    ['backtick value', 'const opts = { secret: `exampleSecret42` }', 'const opts = { secret: `[REDACTED]` }'],
    ['quoted key', "{ 'client_secret': 'cs-example-1' }", "{ 'client_secret': '[REDACTED]' }"],
    ['camelCase const', 'const apiKey = "zq8Lm2Xv9Kp4Rt7Wy1Bn6Cd3Fg5Hj0Qs"', 'const apiKey = "[REDACTED]"'],
    ['lower-case assignment', 'let password = "hunter2hunter2"', 'let password = "[REDACTED]"'],
    ['prefixed name', 'this.dbPassword = "examplePw1"', 'this.dbPassword = "[REDACTED]"'],
    ['python assignment', 'api_key = "example-python-key"', 'api_key = "[REDACTED]"'],
    ['python secret key', "SECRET_KEY = 'django-insecure-example'", "SECRET_KEY = '[REDACTED]'"],
    ['access key', 'const secretAccessKey = "exampleAccessKey99"', 'const secretAccessKey = "[REDACTED]"'],
    ['auth token', 'authToken: "example-auth-token"', 'authToken: "[REDACTED]"'],
    ['env fallback ||', 'const s = process.env.SECRET || "fallbackS3cretValue99"', 'const s = process.env.SECRET || "[REDACTED]"'],
    ['env fallback ??', "process.env['API_KEY'] ?? 'exampleFallbackKey'", "process.env['API_KEY'] ?? '[REDACTED]'"],
    ['python environ.get', 'os.environ.get("DB_PASSWORD", "examplePw2")', 'os.environ.get("DB_PASSWORD", "[REDACTED]")'],
    ['python getenv', "os.getenv('TOKEN', 'exampleTok3')", "os.getenv('TOKEN', '[REDACTED]')"],
    ['upper-case name assigned an environ.get fallback', 'API_TOKEN = os.environ.get("API_TOKEN", "py-fallback-tok3n-123")', 'API_TOKEN = os.environ.get("API_TOKEN", "[REDACTED]")'],
    ['upper-case name assigned a getenv fallback', "DB_PASSWORD = os.getenv('DB_PASSWORD', 'examplePw4')", "DB_PASSWORD = os.getenv('DB_PASSWORD', '[REDACTED]')"],
    ['env line still redacted', 'NPM_TOKEN=exampleNpmTok3n99 npm publish', 'NPM_TOKEN=[REDACTED] npm publish'],
    ['quoted env line still redacted', "export AWS_SECRET_ACCESS_KEY='exampleAwsSecret1'", "export AWS_SECRET_ACCESS_KEY='[REDACTED]'"],
    ['unquoted password= in a log', 'connect failed: host=db user=admin password=examplePassw0rd sslmode=require', 'connect failed: host=db user=admin password=[REDACTED] sslmode=require'],
    ['error prose', 'password authentication failed for user "admin" with password examplePassw0rd', 'password authentication failed for user "admin" with password [REDACTED]'],
  ]
  for (const [name, input, expected] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactSecretValues(input)
      expect(out).toBe(expected)
      // Idempotent: the at-rest rewrite and the load-time edge scrub rely on it.
      expect(redactSecretValues(out)).toBe(out)
    })
  }

  it('leaves code that carries no literal alone', () => {
    for (const text of [
      'function login(user: string, password: string): Promise<void>',
      'const token = req.headers.authorization',
      'token: req.headers["x-token"],',
      'if (password === "") return',
      'if (token == "") return',
      'const password = ""',
      'const apiKey = `${prefix}-${suffix}`',
      'const tokenizer = "bert-base"',
      'const password_reset_url = "https://example.com/reset"',
      'const s = process.env.SECRET || defaultSecret',
      'Send a password reset email',
      'log in with password authentication enabled',
      'password authentication failed for user "admin"',
      'const onToken = (token) => "x"',
      'SECRET_KEY = os.environ["SECRET_KEY"]',
      'API_KEY = load_key()',
    ]) {
      expect(redactSecretValues(text)).toBe(text)
    }
  })

  it('runs on an evidence snippet', () => {
    const line = '  const db = new Client({ password: "examplePassw0rd", host: "db" })'
    const out = clipEvidence(line)
    expect(out).not.toContain('examplePassw0rd')
    expect(out).toContain('password: "[REDACTED]"')
  })
})
