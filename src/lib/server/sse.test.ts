import { describe, expect, it } from 'vitest';
import { SSE_HEADERS, offlineSseBody, offlineSseResponse, proxySseResponse, sseData } from './sse';

const enc = new TextEncoder();

function upstreamOf(chunks: string[], keepOpen = false): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!keepOpen) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

describe('SSE helpers', () => {
  it('frames live messages as one data line', () => {
    expect(sseData({ type: 'offline', data: { since: 5, error: 'weg' } })).toBe('data: {"type":"offline","data":{"since":5,"error":"weg"}}\n\n');
  });

  it('offline response is a 200 event stream with retry + offline message', async () => {
    expect(offlineSseBody(1, 'Messdienst läuft nicht')).toBe(
      'retry: 3000\n\ndata: {"type":"offline","data":{"since":1,"error":"Messdienst läuft nicht"}}\n\n',
    );
    const res = offlineSseResponse(1, 'x');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SSE_HEADERS['Content-Type']);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toContain('"type":"offline"');
  });

  it('passes upstream bytes through and ends with the upstream', async () => {
    const up = upstreamOf(['retry: 3000\n\n', 'data: {"type":"hello"}\n\n']);
    let aborted = 0;
    const res = proxySseResponse(up.stream, new AbortController().signal, () => aborted++);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('retry: 3000\n\ndata: {"type":"hello"}\n\n');
    expect(aborted).toBe(1);
  });

  it('client abort cancels the upstream and closes the proxied stream', async () => {
    const up = upstreamOf(['data: 1\n\n'], true);
    const client = new AbortController();
    let aborted = 0;
    const res = proxySseResponse(up.stream, client.signal, () => aborted++);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: 1\n\n');
    client.abort();
    const next = await reader.read();
    expect(next.done).toBe(true);
    expect(aborted).toBe(1);
    expect(up.cancelled()).toBe(true);
  });

  it('an already aborted client signal never reads the upstream', async () => {
    const up = upstreamOf(['data: 1\n\n'], true);
    const client = new AbortController();
    client.abort();
    let aborted = 0;
    const res = proxySseResponse(up.stream, client.signal, () => aborted++);
    expect(await res.text()).toBe('');
    expect(aborted).toBe(1);
  });
});
