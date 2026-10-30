/** Offline OpenRouter stream fixtures. They make no network call. */

/** Server-sent events in the form that OpenRouter streams a chat completion. */
export function sseResponse(events: unknown[], init: ResponseInit = {}): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    ...init,
    headers: { "content-type": "text/event-stream", ...(init.headers as Record<string, string>) },
  });
}

interface CompletionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One completion in the shape of a response that OpenRouter does not stream. */
interface CompletionFixture {
  id: string;
  model: string;
  provider: string;
  object?: string;
  created?: number;
  service_tier?: string;
  choices: Array<{
    index?: number;
    finish_reason: string;
    logprobs?: null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning?: string;
      reasoning_details?: unknown[];
      reasoning_content?: string;
      tool_calls?: CompletionToolCall[];
    };
  }>;
  usage?: Record<string, unknown>;
}

/**
 * The same completion as OpenRouter streams it: reasoning, text, each tool call, the finish
 * reason, and at the end the usage with the cost.
 */
function completionEvents(completion: CompletionFixture): unknown[] {
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created ?? 1,
    model: completion.model,
    provider: completion.provider,
    ...(completion.service_tier ? { service_tier: completion.service_tier } : {}),
  };
  const choice = completion.choices[0]!;
  const message = choice.message;
  const delta = (value: Record<string, unknown>, finishReason: string | null = null) => ({
    ...base,
    choices: [{ index: 0, delta: value, finish_reason: finishReason }],
  });
  const events: unknown[] = [];
  if (message.reasoning || message.reasoning_details)
    events.push(
      delta({
        role: "assistant",
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
      }),
    );
  if (message.content) events.push(delta({ role: "assistant", content: message.content }));
  for (const [index, call] of (message.tool_calls ?? []).entries())
    events.push(
      delta({
        tool_calls: [{ index, id: call.id, type: "function", function: call.function }],
      }),
    );
  events.push(delta({}, choice.finish_reason));
  if (completion.usage) events.push({ ...base, choices: [], usage: completion.usage });
  return events;
}

export function streamedCompletion(completion: CompletionFixture, init?: ResponseInit): Response {
  return sseResponse(completionEvents(completion), init);
}

/** One chunk of an OpenRouter stream with the given delta. */
export function chunk(
  generationId: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): unknown {
  return {
    id: generationId,
    object: "chat.completion.chunk",
    created: 1,
    model: "fake/model",
    provider: "Fake Provider",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** More events are a fault of the transport. The stream then ends without a finish. */
const ENDLESS_STREAM_SAFETY_BOUND = 2_000;

/**
 * A stream that sends the first events and then the next event again and again. With no next
 * event, the stream holds after the first events. Only an abort of the request ends it, so a
 * test can prove that the transport stopped it. `counter.pulled` counts the sent events.
 */
export function endlessStream(
  signal: AbortSignal | null | undefined,
  first: unknown[],
  next: (() => unknown) | null,
  counter: { pulled: number } = { pulled: 0 },
): Response {
  const encoder = new TextEncoder();
  const queue = [...first];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) return controller.error(signal.reason);
      const event =
        queue.shift() ??
        (next && counter.pulled < ENDLESS_STREAM_SAFETY_BOUND ? next() : undefined);
      if (event === undefined) {
        if (next) return controller.close();
        return new Promise<void>((done) => {
          signal?.addEventListener(
            "abort",
            () => {
              controller.error(signal.reason);
              done();
            },
            { once: true },
          );
        });
      }
      counter.pulled++;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The read-only generation record of OpenRouter with a known charge. */
export function generationRecord(generationId: string, costUsd: number): Response {
  return Response.json({
    data: {
      id: generationId,
      total_cost: costUsd,
      created_at: "2026-10-03T00:00:00.000Z",
      model: "fake/model",
      provider_name: "Fake Provider",
      cancelled: true,
      request_id: "req-offline",
    },
  });
}
