import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

// Env-driven URL — the common production case. The literal host is unknowable
// at static time, so the edge lands on the stable supabase:env target.
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

// Literal URL — the host resolves directly.
const direct = createClient('https://abcdefgh.supabase.co', 'anon-key')

// @supabase/ssr server client, env-driven.
const server = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  cookies: {},
})

export async function load() {
  const { data } = await supabase.from('orders').select('*')
  const user = await server.auth.getUser()
  const file = await direct.storage.from('avatars').download('a.png')
  return { data, user, file }
}
