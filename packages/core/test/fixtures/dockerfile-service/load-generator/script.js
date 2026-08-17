import http from 'k6/http'
import { sleep } from 'k6'

export const options = {
  vus: 10,
  duration: '30s',
}

export function setup() {
  return { startedAt: Date.now() }
}

export default function loadTest() {
  placeOrder()
  sleep(1)
}

function placeOrder() {
  return http.post('http://frontend:8080/api/checkout')
}
