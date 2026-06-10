import { createClient } from '@supabase/supabase-js'

// Same client construction as production code, but in a test file. Test-scope
// exclusion (ADR-065 #1) must keep this from minting any outbound CALLS edge.
const supabase = createClient('https://testonly.supabase.co', 'anon-key')

export async function fetchOrders() {
  return supabase.from('orders').select('*')
}
