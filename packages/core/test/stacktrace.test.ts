import { describe, it, expect } from 'vitest'
import { deepestApplicationFrame } from '../src/stacktrace.js'

// Stacktrace code-locus recovery (ADR-216). The parser recovers the deepest
// APPLICATION frame — the frame nearest the throw site that is not runtime /
// vendor code — across the common frame shapes, keying only on generic frame
// syntax and generic vendor-prefix markers (never a language name).

describe('deepestApplicationFrame', () => {
  it('recovers the deepest application frame from a Python traceback, skipping site-packages', () => {
    const trace = [
      'Traceback (most recent call last):',
      '  File "/usr/local/lib/python3.12/site-packages/opentelemetry/trace/__init__.py", line 589, in use_span',
      '    yield span',
      '  File "/usr/local/lib/python3.12/site-packages/opentelemetry/sdk/trace/__init__.py", line 1105, in start_as_current_span',
      '    yield span',
      '  File "/usr/src/app/recommendation_server.py", line 96, in get_product_list',
      '    product_ids = [x.id for x in cat_response.products_list]',
      "AttributeError: 'ListProductsResponse' object has no attribute 'products_list'",
    ].join('\n')

    const frame = deepestApplicationFrame(trace)
    expect(frame).not.toBeNull()
    expect(frame!.file).toBe('/usr/src/app/recommendation_server.py')
    expect(frame!.line).toBe(96)
    expect(frame!.fn).toBe('get_product_list')
  })

  it('recovers the throw-site frame from a Node/V8 stack (most recent first), skipping node_modules and node: internals', () => {
    const trace = [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '    at getProductList (/usr/src/app/server.js:96:32)',
      '    at /usr/src/app/node_modules/@grpc/grpc-js/build/src/server-call.js:180:20',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n')

    const frame = deepestApplicationFrame(trace)
    expect(frame).not.toBeNull()
    expect(frame!.file).toBe('/usr/src/app/server.js')
    expect(frame!.line).toBe(96)
    expect(frame!.fn).toBe('getProductList')
  })

  it('recovers a bare (anonymous) Node frame with no function name', () => {
    const trace = [
      'Error: boom',
      '    at /usr/src/app/worker.js:12:9',
      '    at /usr/src/app/node_modules/bullmq/dist/worker.js:400:10',
    ].join('\n')

    const frame = deepestApplicationFrame(trace)
    expect(frame).not.toBeNull()
    expect(frame!.file).toBe('/usr/src/app/worker.js')
    expect(frame!.line).toBe(12)
    expect(frame!.fn).toBeUndefined()
  })

  it('recovers the throw-site frame from a JVM-style stack (most recent first)', () => {
    const trace = [
      'java.lang.NullPointerException: Cannot invoke "..." because "products" is null',
      '\tat com.example.rec.RecommendationServer.getProductList(RecommendationServer.java:96)',
      '\tat io.grpc.internal.ServerCallImpl.internalClose(ServerCallImpl.java:342)',
      '\tat java.base/java.lang.Thread.run(Thread.java:840)',
    ].join('\n')

    const frame = deepestApplicationFrame(trace)
    expect(frame).not.toBeNull()
    expect(frame!.file).toBe('RecommendationServer.java')
    expect(frame!.line).toBe(96)
    expect(frame!.fn).toBe('com.example.rec.RecommendationServer.getProductList')
  })

  it('recovers nothing from an all-vendor stacktrace — never fabricates a locus', () => {
    const trace = [
      'Traceback (most recent call last):',
      '  File "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line 552, in _call_behavior',
      '    response = behavior(...)',
      '  File "/usr/local/lib/python3.12/site-packages/opentelemetry/instrumentation/grpc/_server.py", line 300, in telemetry_interceptor',
      '    raise error',
      'RuntimeError: interceptor failed',
    ].join('\n')

    expect(deepestApplicationFrame(trace)).toBeNull()
  })

  it('recovers nothing from a stacktrace with no frames at all, or none provided', () => {
    expect(deepestApplicationFrame(undefined)).toBeNull()
    expect(deepestApplicationFrame('')).toBeNull()
    expect(deepestApplicationFrame('AttributeError: nope, no frames here')).toBeNull()
  })

  it('picks the last (deepest) application frame when several are present in a Python trace', () => {
    const trace = [
      'Traceback (most recent call last):',
      '  File "/usr/src/app/main.py", line 10, in main',
      '    handle()',
      '  File "/usr/src/app/handlers.py", line 44, in handle',
      '    do_work()',
      '  File "/usr/src/app/work.py", line 88, in do_work',
      '    raise ValueError("x")',
      'ValueError: x',
    ].join('\n')

    const frame = deepestApplicationFrame(trace)
    expect(frame!.file).toBe('/usr/src/app/work.py')
    expect(frame!.line).toBe(88)
    expect(frame!.fn).toBe('do_work')
  })
})
