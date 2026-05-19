import { renderToString } from 'react-dom/server'

export default function handleRequest() {
  return new Response(renderToString('hello'), {
    headers: { 'content-type': 'text/html' },
  })
}
