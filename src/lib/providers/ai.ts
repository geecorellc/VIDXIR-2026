/**
 * AIProvider — structured generation through Claude (§32, §9).
 *
 * One entry point, `generateJson()`, which takes a JSON Schema and returns a
 * validated object. Everything downstream (research angles, scripts, scene
 * plans, metadata, thumbnail concepts) asks for a shape and gets that shape or
 * an error — never prose that a caller has to guess its way through.
 *
 * Three decisions worth stating:
 *
 *  - **Structured outputs, not "return JSON" in the prompt.** `output_config.
 *    format` constrains the decoder, so the response is parseable by
 *    construction. A model asked politely for JSON eventually returns a code
 *    fence, and a regex-based unwrapper is a bug waiting for the day it matters.
 *  - **The schema is also validated locally.** The API constrains the shape, but
 *    this module still checks it with Zod before returning, because §42's
 *    "never fake it" applies to our own optimism too: a field the caller relies
 *    on must be present, not assumed.
 *  - **No mock.** With `TALLY_USE_MOCK_PROVIDERS` the capability registry
 *    reports `mock` and callers show a configuration state; there is deliberately
 *    no canned-script generator here. A believable fake script is exactly the
 *    thing that makes a broken pipeline look like a working one.
 *
 * §48: without `ANTHROPIC_API_KEY` every call throws `NotConfiguredError`, which
 * the API layer renders as a 503 naming the variable.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { env } from "@/lib/env";
import {
  NotConfiguredError,
  ProviderError,
  ProviderOutOfCreditError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { withUsage, type UsageContext } from "@/lib/providers/usage";

const log = logger.child({ component: "ai", provider: "anthropic" });

export const AI_PROVIDER = "anthropic";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY"] as const;

const CONFIG_HINT =
  "Create a key at https://console.anthropic.com/settings/keys and set " +
  "ANTHROPIC_API_KEY.";

/** True when the API key is present. */
export function isAiConfigured(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY);
}

export function aiMissingEnvVars(): string[] {
  return isAiConfigured() ? [] : [...REQUIRED_ENV];
}

/**
 * The client, or a 503.
 *
 * Cached per key: the SDK holds a connection pool, and rebuilding it per request
 * would discard keep-alive on the hottest path in the product.
 */
let cachedClient: { key: string; client: Anthropic } | undefined;

function client(): Anthropic {
  const key = env().ANTHROPIC_API_KEY;
  if (!key) {
    throw new NotConfiguredError("Claude", [...REQUIRED_ENV], CONFIG_HINT);
  }
  if (cachedClient?.key !== key) {
    cachedClient = {
      key,
      client: new Anthropic({
        apiKey: key,
        // Generation is a background job, so a long request is fine; a hung one
        // is not. The worker's own timeout is the outer bound.
        timeout: 10 * 60_000,
        // The SDK retries 408/429/5xx with backoff. Two is enough that a blip
        // recovers and few enough that a real outage surfaces promptly.
        maxRetries: 2,
      }),
    };
  }
  return cachedClient.client;
}

/** Drop the cached client. Test-only, for asserting the not-configured path. */
export function resetAiClientCache(): void {
  cachedClient = undefined;
}

export interface GenerateJsonOptions<T extends z.ZodTypeAny> {
  /** System prompt: the role and the rules. */
  system: string;
  /** User turn: the task and its data. */
  prompt: string;
  /**
   * Zod schema for the result. Converted to JSON Schema for the request and used
   * again locally to validate the response.
   */
  schema: T;
  /** JSON Schema for `output_config.format`. See `jsonSchema()` below. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Reasoning effort. Defaults to ANTHROPIC_EFFORT. Cheap mechanical
   * transformations pass "low"; a script outline wants the default.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Accounting context, so every call lands in `api_usage` (§41). */
  usage: Omit<UsageContext, "provider" | "operation" | "model"> & {
    operation: string;
  };
}

/**
 * Generate a JSON object matching `schema`.
 *
 * Adaptive thinking is on: these are judgement tasks (is this topic actually an
 * opportunity, does this hook earn the next thirty seconds) where reasoning
 * measurably changes the answer. `budget_tokens` is deliberately absent — Opus 5
 * rejects it with a 400.
 */
export async function generateJson<T extends z.ZodTypeAny>(
  options: GenerateJsonOptions<T>,
): Promise<z.infer<T>> {
  const e = env();
  const anthropic = client();
  const model = e.ANTHROPIC_MODEL;

  const raw = await withUsage(
    {
      provider: AI_PROVIDER,
      operation: options.usage.operation,
      model,
      userId: options.usage.userId ?? null,
      projectId: options.usage.projectId ?? null,
      jobId: options.usage.jobId ?? null,
      traceId: options.usage.traceId ?? null,
    },
    async () => {
      try {
        return await anthropic.messages.create({
          model,
          max_tokens: options.maxTokens ?? 8_000,
          system: options.system,
          messages: [{ role: "user", content: options.prompt }],
          thinking: { type: "adaptive" },
          output_config: {
            effort: options.effort ?? e.ANTHROPIC_EFFORT,
            format: { type: "json_schema", schema: options.jsonSchema },
          },
        });
      } catch (error) {
        throw translate(error);
      }
    },
    (message) => ({
      // Input + output tokens: the figure that maps to the invoice.
      quantity: message.usage.input_tokens + message.usage.output_tokens,
      unit: "tokens",
    }),
  );

  const text = raw.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    throw new ProviderError("Claude", "The model returned an empty response.", {
      retryable: true,
      details: { stopReason: raw.stop_reason },
    });
  }

  // `max_tokens` reached mid-object: the text is truncated JSON, and parsing it
  // would either throw here or — worse — succeed on a half-written array and
  // hand the caller silently incomplete data.
  if (raw.stop_reason === "max_tokens") {
    throw new ProviderError(
      "Claude",
      "The model's response was cut off before it finished. Try a shorter request.",
      { retryable: false, details: { stopReason: raw.stop_reason } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("Claude", "The model returned malformed JSON.", {
      retryable: true,
      details: { stopReason: raw.stop_reason },
    });
  }

  const result = options.schema.safeParse(parsed);
  if (!result.success) {
    // Structured outputs make this unlikely, not impossible. Retryable: a second
    // sample usually conforms, and the alternative is passing a half-shaped
    // object to a caller that trusts its type.
    log.warn("model output failed local validation", {
      operation: options.usage.operation,
      issues: result.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    throw new ProviderError(
      "Claude",
      "The model's response did not match the expected structure.",
      { retryable: true },
    );
  }

  log.debug("generation complete", {
    operation: options.usage.operation,
    userId: options.usage.userId ?? undefined,
    inputTokens: raw.usage.input_tokens,
    outputTokens: raw.usage.output_tokens,
    status: "ok",
  });

  return result.data;
}

/**
 * Map an SDK error onto Tally's taxonomy (§30).
 *
 * The distinction that matters: 429 and 5xx are worth another attempt, 401 and
 * 400 are not. Retrying a bad request forever is how a queue fills up.
 *
 * Exported for tests. Classification is the part of this module worth pinning —
 * whether a failure retries, and what the operator is told to fix, both follow
 * from it — and it cannot be exercised through `generateJson` without either a
 * live account in a specific broken state or a mocked SDK client.
 */
export function translate(error: unknown): Error {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;

    if (status === 401 || status === 403) {
      return new ProviderAuthError(
        "Claude",
        "Claude rejected the API key. Check ANTHROPIC_API_KEY.",
        error,
      );
    }
    // A 400 whose message is about billing, not about the request. The key is
    // valid, so this is not an auth failure, and no amount of retrying will add
    // credit — it needs naming so the operator knows what to fix (§30, §48).
    if (status === 400 && /credit balance is too low|purchase credits/i.test(error.message)) {
      return new ProviderOutOfCreditError("Claude", error);
    }
    if (status === 429) {
      const header = error.headers?.get?.("retry-after");
      const seconds = Number(header);
      return new ProviderRateLimitError(
        "Claude",
        Number.isFinite(seconds) && seconds > 0 ? seconds : 30,
        error,
      );
    }
    if (status === 408 || error instanceof Anthropic.APIConnectionTimeoutError) {
      return new ProviderTimeoutError("Claude", 10 * 60_000);
    }
    if (status >= 500 || error instanceof Anthropic.APIConnectionError) {
      return new ProviderError("Claude", "Claude is temporarily unavailable.", {
        retryable: true,
        cause: error,
      });
    }
    return new ProviderError("Claude", error.message, {
      retryable: false,
      cause: error,
    });
  }

  return new ProviderError("Claude", "Generation failed.", {
    retryable: true,
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON Schema object literal.
 *
 * Written by hand rather than generated from the Zod schema. Two reasons: the
 * schemas here are small and stable, and a hand-written one can carry
 * `description` strings that materially steer the output — which is where most
 * of the quality lives. The Zod schema stays the local validator, so the pair
 * cannot silently diverge without a test failing.
 */
export function jsonSchema(properties: {
  properties: Record<string, unknown>;
  required: string[];
}): Record<string, unknown> {
  return {
    type: "object",
    properties: properties.properties,
    required: properties.required,
    additionalProperties: false,
  };
}

/** A string array property with a description and bounds. */
export function stringArray(
  description: string,
  bounds: { minItems?: number; maxItems?: number } = {},
): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: { type: "string" },
    ...(bounds.minItems === undefined ? {} : { minItems: bounds.minItems }),
    ...(bounds.maxItems === undefined ? {} : { maxItems: bounds.maxItems }),
  };
}
