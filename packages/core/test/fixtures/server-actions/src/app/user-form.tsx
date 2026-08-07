'use client'

import { useActionState } from 'react'
import { createUser, deleteUser } from '@/app/actions'
import { updateUser } from '@/app/admin/actions'

// A client component that references imported Server Actions four ways. Each
// reference must land a `file ──CALLS──▶ action` edge (ADR-168): referenced, not
// only called, is what closes the form-action gap.
export function UserForm({ id }: { id: string }) {
  // (c) useActionState argument.
  const [state, formAction] = useActionState(deleteUser, null)
  // (d) .bind receiver.
  const boundUpdate = updateUser.bind(null, id)

  async function handleReset(): Promise<void> {
    // (a) a direct call.
    await createUser(new FormData())
  }

  return (
    // (b) an action={fn} JSX attribute.
    <form action={createUser}>
      <button formAction={formAction} onClick={handleReset}>
        {String(state)}
      </button>
      <input onChange={boundUpdate} />
    </form>
  )
}
