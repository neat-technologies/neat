import { infraId } from '@neat.is/types'

// The identity of a messaging destination, a Kafka topic / queue / stream
// (identity.md, #1641 option B). Both the static producer extractors
// (extract/calls/kafka.ts) and OTel ingest (ingest/messaging.ts) key a destination
// the same way, so a declared PUBLISHES_TO/CONSUMES_FROM edge and an observed one
// fuse onto one InfraNode instead of twinning. The id is `infra:<system>-topic:
// <destination>`; the `-topic` kind generalises across the systems the semantic
// conventions name (kafka -> kafka-topic). Pure; imports only the types id helper.

// The InfraNode kind for a messaging system's destination: `<system>-topic`
// (kafka -> kafka-topic).
export function messagingDestinationKind(system: string): string {
  return `${system}-topic`
}

// A messaging destination's id and InfraNode kind. Both the static and observed
// sides call this, so the id and kind come out identical and the edges fuse.
export function messagingDestinationIdentity(system: string, destination: string): { id: string; kind: string } {
  const kind = messagingDestinationKind(system)
  return { id: infraId(kind, destination), kind }
}
