import path from 'node:path'
import { infraId } from '@neat.is/types'
import { lineOf, snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Match `producer.send({ topic: "orders" ... })` and `producer.send({
// topic: 'orders' })` plus the two-arg form `producer.send("orders", ...)`.
// Kafka client libraries vary; these two forms cover kafkajs + node-rdkafka
// well enough for static extraction. Same shape covers consumer.subscribe.
const PRODUCER_TOPIC_RE =
  /(?:producer|kafkaProducer)[\s\S]{0,40}?\.send\s*\(\s*\{[\s\S]{0,200}?topic\s*:\s*['"`]([^'"`]+)['"`]/g
const CONSUMER_TOPIC_RE =
  /(?:consumer|kafkaConsumer)[\s\S]{0,40}?\.(?:subscribe|run)\s*\(\s*\{[\s\S]{0,200}?topic[s]?\s*:\s*(?:\[\s*)?['"`]([^'"`]+)['"`]/g

// --- Go (Sarama) ---
//
// The otel-demo `checkout` service is Go using IBM/Shopify Sarama; the JS regexes
// above never match its `sarama.ProducerMessage{Topic: "orders"}` shape, so the
// observed `PUBLISHES_TO infra:kafka-topic:orders` edge orphaned with no static
// twin. These read the Go call sites as data — the same "polyglot files are read,
// the extractor stays TypeScript" approach proto.ts uses — and mint the SAME
// `infra:kafka-topic:<topic>` node the JS path and the OBSERVED span land on, so
// declared and observed queue topology fuse on one node.
//
// Everything below is gated on a real Sarama import: without it an arbitrary Go
// struct named `ProducerMessage` or any `.Consume(...)` method would mint a
// phantom topic. This mirrors the import gate calls/go.ts and routes.ts use.
const SARAMA_IMPORT_RE = /"[^"]*\/sarama"/

// Producer: `sarama.ProducerMessage{Topic: "orders"}` (sync SendMessage) and
// `producer.Input() <- &sarama.ProducerMessage{Topic: topicVar}` (async). The
// `Topic` field can sit anywhere in the struct literal, so scan a bounded window
// for it and capture either a string literal (interpreted `"x"` or raw `` `x` ``)
// or a bare identifier we resolve to an in-file literal below.
const GO_PRODUCER_RE =
  /ProducerMessage\s*\{[\s\S]{0,300}?\bTopic\s*:\s*(?:"([^"]+)"|`([^`]+)`|([A-Za-z_]\w*))/g

// Consumer group: `consumerGroup.Consume(ctx, []string{"orders"}, handler)`. The
// topic list is the `[]string{...}` argument; it may hold literals or identifiers.
const GO_CONSUMER_RE = /\.Consume\s*\([\s\S]{0,120}?\[\]string\s*\{([^}]*)\}/g

// Every string literal (interpreted or raw) inside a captured `[]string{...}` body.
const GO_STRING_LITERAL_RE = /"([^"]+)"|`([^`]+)`/g

// A bare identifier — the fallback when the topic is a const/var rather than a
// literal at the call site.
const GO_IDENT_RE = /[A-Za-z_]\w*/g

function findAll(re: RegExp, text: string): { topic: string; index: number }[] {
  re.lastIndex = 0
  const out: { topic: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ topic: m[1]!, index: m.index })
  }
  return out
}

// Resolve a Go identifier to an in-file string literal — `topic := "orders"`,
// `topic = "orders"`, `const KafkaTopic = "orders"` (const-block members read as
// `KafkaTopic = "orders"`), and typed `var topic string = "orders"`. A value that
// isn't an in-file literal — `topic := os.Getenv("KAFKA_TOPIC")`, a computed
// string — has no literal RHS and stays unresolved rather than guessed: NEAT would
// be inventing a topic name it cannot see.
function resolveGoLiteral(ident: string, text: string): string | undefined {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `\\b${esc}(?:\\s+\\w[\\w.\\[\\]*]*)?\\s*(?::=|=)\\s*(?:"([^"]+)"|\`([^\`]+)\`)`,
  )
  const m = re.exec(text)
  if (!m) return undefined
  return m[1] ?? m[2]
}

// Character offset of the topic token at the tail of a producer match, so evidence
// points at the `Topic: "orders"` line rather than the head of the struct literal.
function producerTopicAnchor(match: RegExpExecArray): number {
  const [full] = match
  const tokenLen = match[1]
    ? match[1].length + 2 // "x"
    : match[2]
      ? match[2].length + 2 // `x`
      : (match[3]?.length ?? 0) // ident
  return match.index + full.length - tokenLen
}

type Emit = (
  topic: string,
  edgeType: 'PUBLISHES_TO' | 'CONSUMES_FROM',
  anchor: number,
) => void

// Walk a Go file's Sarama producer / consumer-group call sites, emitting a topic
// per resolved site. No-op unless the file imports Sarama.
function goSaramaEndpoints(text: string, emit: Emit): void {
  if (!SARAMA_IMPORT_RE.test(text)) return

  GO_PRODUCER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = GO_PRODUCER_RE.exec(text)) !== null) {
    const literal = m[1] ?? m[2]
    const anchor = producerTopicAnchor(m)
    if (literal) {
      emit(literal, 'PUBLISHES_TO', anchor)
    } else if (m[3]) {
      const resolved = resolveGoLiteral(m[3], text)
      if (resolved) emit(resolved, 'PUBLISHES_TO', anchor)
    }
  }

  GO_CONSUMER_RE.lastIndex = 0
  while ((m = GO_CONSUMER_RE.exec(text)) !== null) {
    const inside = m[1] ?? ''
    const anchor = m.index + Math.max(0, m[0].indexOf('[]string'))
    let sawLiteral = false
    GO_STRING_LITERAL_RE.lastIndex = 0
    let s: RegExpExecArray | null
    while ((s = GO_STRING_LITERAL_RE.exec(inside)) !== null) {
      const topic = s[1] ?? s[2]
      if (topic) {
        emit(topic, 'CONSUMES_FROM', anchor)
        sawLiteral = true
      }
    }
    if (sawLiteral) continue
    // `[]string{topicVar}` — resolve each identifier to an in-file literal.
    GO_IDENT_RE.lastIndex = 0
    let id: RegExpExecArray | null
    while ((id = GO_IDENT_RE.exec(inside)) !== null) {
      const resolved = resolveGoLiteral(id[0], text)
      if (resolved) emit(resolved, 'CONSUMES_FROM', anchor)
    }
  }
}

export function kafkaEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  const make = (
    topic: string,
    edgeType: 'PUBLISHES_TO' | 'CONSUMES_FROM',
    anchor?: number,
  ): void => {
    const key = `${edgeType}|${topic}`
    if (seen.has(key)) return
    seen.add(key)
    // JS callers pass no anchor and fall back to finding the topic string. The Go
    // path already knows the exact call-site offset (the topic may be a const, so
    // its literal lives elsewhere in the file), so count newlines up to it.
    const line =
      anchor !== undefined
        ? file.content.slice(0, anchor).split('\n').length
        : lineOf(file.content, topic)
    out.push({
      infraId: infraId('kafka-topic', topic),
      name: topic,
      kind: 'kafka-topic',
      edgeType,
      // JS: `producer.send({topic: 'x'})` / `consumer.subscribe({topic: 'x'})`
      // (kafkajs / node-rdkafka). Go: `sarama.ProducerMessage{Topic: 'x'}` /
      // `consumerGroup.Consume(ctx, []string{'x'}, …)`. Both are framework-aware
      // call sites — verified-call-site tier (ADR-066).
      confidenceKind: 'verified-call-site',
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }

  if (path.extname(file.path) === '.go') {
    goSaramaEndpoints(file.content, make)
  } else {
    for (const { topic } of findAll(PRODUCER_TOPIC_RE, file.content)) make(topic, 'PUBLISHES_TO')
    for (const { topic } of findAll(CONSUMER_TOPIC_RE, file.content)) make(topic, 'CONSUMES_FROM')
  }
  return out
}
