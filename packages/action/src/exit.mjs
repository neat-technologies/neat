// The exit-code policy. The action never fails the PR check on its own errors;
// the deliberate failures are the two opt-in gates: the security gate
// (security-gate: fail) on a known vulnerability the PR introduced, and the
// no-regression gate (no-regression-gate: fail) when its verdict does not pass.

/** Mark the run failed by the security gate. Sets the code, doesn't throw, so the graph comment still posts. */
export function failSecurityGate() {
  process.exitCode = 1
}

/** Mark the run failed by the no-regression gate. Sets the code, doesn't throw, so the comments still post. */
export function failNoRegressionGate() {
  process.exitCode = 1
}

/** The entrypoint's error handler: log, then exit 0 unless the security gate already failed the run. */
export function exitAfterError(e) {
  console.error('neat-action:', e.message)
  process.exit(process.exitCode === 1 ? 1 : 0)
}
