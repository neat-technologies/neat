// The exit-code policy. The action never fails the PR check on its own errors;
// the one deliberate failure is the opt-in security gate (security-gate: fail)
// on a known vulnerability the PR introduced.

/** Mark the run failed by the security gate. Sets the code, doesn't throw, so the graph comment still posts. */
export function failSecurityGate() {
  process.exitCode = 1
}

/** The entrypoint's error handler: log, then exit 0 unless the security gate already failed the run. */
export function exitAfterError(e) {
  console.error('neat-action:', e.message)
  process.exit(process.exitCode === 1 ? 1 : 0)
}
