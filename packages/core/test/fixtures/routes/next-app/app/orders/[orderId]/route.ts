export async function GET() {
  return new Response('ok')
}

export async function POST() {
  return new Response('created', { status: 201 })
}
