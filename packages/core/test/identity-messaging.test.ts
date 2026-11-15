import { describe, it, expect } from 'vitest'
import { messagingDestinationIdentity, messagingDestinationKind } from '../src/identity/messaging.js'

// #1641 option B: the messaging-destination id must come out identical whether the
// static Kafka extractor or OTel ingest builds it, or the declared and observed
// queue edges twin.
describe('messaging destination identity', () => {
  it('builds infra:<system>-topic:<destination> with the system kind', () => {
    expect(messagingDestinationIdentity('kafka', 'orders')).toEqual({ id: 'infra:kafka-topic:orders', kind: 'kafka-topic' })
  })

  it('matches the id and kind the static Kafka extractor used (so static and observed fuse)', () => {
    expect(messagingDestinationIdentity('kafka', 'payments').id).toBe('infra:kafka-topic:payments')
    expect(messagingDestinationIdentity('kafka', 'payments').kind).toBe('kafka-topic')
  })

  it('generalises to other messaging systems', () => {
    expect(messagingDestinationIdentity('socket.io', '/chat#message')).toEqual({
      id: 'infra:socket.io-topic:/chat#message',
      kind: 'socket.io-topic',
    })
    expect(messagingDestinationKind('rabbitmq')).toBe('rabbitmq-topic')
  })
})
