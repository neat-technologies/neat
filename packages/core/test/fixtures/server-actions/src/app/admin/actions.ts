// No module-level directive here — an action is minted only for the function
// carrying its own in-body "use server" directive.

export async function updateUser(id: string, patch: Record<string, unknown>): Promise<void> {
  'use server'
  console.log('update', id, patch)
}

// Exported and async, but no "use server" directive (module-level or in-body):
// this is NOT a Server Action, and must not mint a node.
export async function logAudit(event: string): Promise<void> {
  console.log('audit', event)
}
