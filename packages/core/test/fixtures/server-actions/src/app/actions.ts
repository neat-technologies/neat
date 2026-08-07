'use server'

// A module-level "use server" directive: every exported async function in this
// file is a Server Action (ADR-168), so both createUser and deleteUser mint a
// ServerActionNode.

export async function createUser(formData: FormData): Promise<{ id: string }> {
  const name = String(formData.get('name'))
  return { id: name }
}

export async function deleteUser(id: string): Promise<void> {
  console.log('delete', id)
}
