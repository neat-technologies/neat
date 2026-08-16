import { describe, it, expect } from 'vitest'
import {
  latencyBucketIndex,
  recordLatency,
  latencyPercentiles,
  type LatencyHistogram,
} from '../src/latency-digest.js'

describe('latency-digest', () => {
  it('reads no percentiles from an empty or missing histogram', () => {
    expect(latencyPercentiles(undefined)).toBeUndefined()
    expect(latencyPercentiles({})).toBeUndefined()
  })

  it('a run of spans produces a p95 near the true 95th percentile', () => {
    const hist: LatencyHistogram = {}
    for (let ms = 1; ms <= 100; ms++) recordLatency(hist, ms)
    const p = latencyPercentiles(hist)!
    expect(p).toBeDefined()
    // Bucketed estimate — assert it lands in the right neighbourhood, not exact.
    expect(p.p50).toBeGreaterThan(44)
    expect(p.p50).toBeLessThan(58)
    expect(p.p95).toBeGreaterThan(85)
    expect(p.p95).toBeLessThan(106)
    expect(p.p95).toBeGreaterThanOrEqual(p.p50)
  })

  it('a constant latency reads back as that latency at every percentile', () => {
    const hist: LatencyHistogram = {}
    for (let i = 0; i < 50; i++) recordLatency(hist, 200)
    const p = latencyPercentiles(hist)!
    expect(p.p50).toBeGreaterThan(190)
    expect(p.p50).toBeLessThan(215)
    expect(p.p95).toBeGreaterThan(190)
    expect(p.p95).toBeLessThan(215)
  })

  it('a saturated tail lifts p95 well above p50', () => {
    const hist: LatencyHistogram = {}
    for (let i = 0; i < 90; i++) recordLatency(hist, 10) // healthy bulk
    for (let i = 0; i < 10; i++) recordLatency(hist, 5000) // saturated tail (10%)
    const p = latencyPercentiles(hist)!
    expect(p.p50).toBeLessThan(20)
    expect(p.p95).toBeGreaterThan(1000)
  })

  it('bucket index is monotonic in latency', () => {
    let prev = -1
    for (const ms of [0, 0.5, 1, 2, 5, 10, 50, 100, 1000, 60000]) {
      const idx = latencyBucketIndex(ms)
      expect(idx).toBeGreaterThanOrEqual(prev)
      prev = idx
    }
  })

  it('degenerate durations fall into the zero bucket, never throw', () => {
    expect(latencyBucketIndex(0)).toBe(0)
    expect(latencyBucketIndex(-5)).toBe(0)
    expect(latencyBucketIndex(NaN)).toBe(0)
    // A non-finite duration is degenerate, not a real measurement — it lands in
    // the zero bucket rather than being counted as an enormous latency.
    expect(latencyBucketIndex(Infinity)).toBe(0)
  })

  it('stays bounded — a huge, wildly varied run keeps a small bucket set', () => {
    const hist: LatencyHistogram = {}
    for (let i = 0; i < 100000; i++) recordLatency(hist, (i % 5000) + 0.1)
    // Fixed-resolution histogram: bucket count is bounded regardless of span count.
    expect(Object.keys(hist).length).toBeLessThan(600)
  })

  it('is deterministic — same durations, same percentiles', () => {
    const a: LatencyHistogram = {}
    const b: LatencyHistogram = {}
    const samples = [3, 7, 7, 12, 40, 40, 40, 900, 12, 3]
    for (const s of samples) recordLatency(a, s)
    for (const s of [...samples].reverse()) recordLatency(b, s)
    expect(latencyPercentiles(a)).toEqual(latencyPercentiles(b))
  })
})
