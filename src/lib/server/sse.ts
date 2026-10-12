// Server-sent events helpers for /api/live (proxy of the engine's /live stream).
// docs/research/stack.md §4: an EventSource that receives a non-200 response closes for good,
// so "engine offline" is a 200 stream with `retry:` + an offline message that then ends.
import type { LiveMessage } from '../shared/types';

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export const SSE_RETRY_MS = 3000;

/** One SSE message carrying a LiveMessage as JSON (`data:` line + blank line). */
export function sseData(msg: LiveMessage): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}

export function offlineSseBody(since: number, error: string): string {
  return `retry: ${SSE_RETRY_MS}\n\n${sseData({ type: 'offline', data: { since, error } })}`;
}

/** 200 text/event-stream that tells the browser to retry in 3 s and then ends. */
export function offlineSseResponse(since: number, error: string): Response {
  return new Response(offlineSseBody(since, error), { status: 200, headers: SSE_HEADERS });
}

/**
 * Pass the engine's SSE bytes through unchanged. Cleanup runs on client abort
 * (`request.signal`, which fires reliably – ReadableStream.cancel() does not in Next 16) and when
 * the engine closes the stream (the browser then reconnects after `retry`).
 */
export function proxySseResponse(upstream: ReadableStream<Uint8Array>, clientSignal: AbortSignal, abortUpstream: () => void): Response {
  const reader = upstream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    reader.cancel().catch(() => undefined);
    abortUpstream();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        finish();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (clientSignal.aborted) onAbort();
      else clientSignal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        const { value, done } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        finish();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      finish();
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
