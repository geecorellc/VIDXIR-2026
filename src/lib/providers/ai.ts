/**
 * AIProvider — structured generation through Claude (§32, §9).
 *
 * One entry point, `generateJson()`, which takes a JSON Schema and returns a
 * validated object. Everything downstream (research angles, scripts, scene
 * plans, metadata, thumbnail concepts) asks for a shape and gets that shape or
 * an error — never prose that a caller has to guess its way through.
 *
 * Two transports, one contract. `AI_PROVIDER` selects between Claude on the
 * first-party Anthropic API (`anthropic`, the default) and Claude on AWS Bedrock
 * (`bedrock`). Callers never learn which one answered: the options struct, the
 * schema validation, the usage accounting and the error taxonomy are identical
 * either way, which is what keeps the choice an operational one rather than a
 * fork in the product (§32).
 *
 * Four decisions worth stating:
 *
 *  - **Schema-constrained decoding, not "return JSON" in the prompt.** A model
 *    asked politely for JSON eventually returns a code fence, and a regex-based
 *    unwrapper is a bug waiting for the day it matters. How the constraint is
 *    expressed differs per transport — see `requestFor()` — because the two
 *    surfaces do not accept the same parameters.
 *  - **The schema is also validated locally.** The API constrains the shape, but
 *    this module still checks it with Zod before returning, because §42's
 *    "never fake it" applies to our own optimism too: a field the caller relies
 *    on must be present, not assumed. This matters more on Bedrock, which does
 *    not accept `strict` tool schemas, so Zod is the only shape guarantee there.
 *  - **No mock.** With `VIDXIR_USE_MOCK_PROVIDERS` the capability registry
 *    reports `mock` and callers show a configuration state; there is deliberately
 *    no canned-script generator here. A believable fake script is exactly the
 *    thing that makes a broken pipeline look like a working one.
 *  - **Credentials are never read from Vidxir AI's own config on Bedrock.** The
 *    Bedrock client resolves them through the standard AWS chain (environment,
 *    shared config/credentials file, SSO cache, container and instance roles), so
 *    an access key never has to live in `.env.local` or in this repo (§33).
 *
 * §48: when the selected transport is not configured every call throws
 * `NotConfiguredError`, which the API layer renders as a 503 naming the exact
 * variable that is missing for *that* transport.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { z } from "zod";
import { bedrockRegion, env } from "@/lib/env";
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

const log = logger.child({ component: "ai" });

export type AiProviderName = "anthropic" | "bedrock";

/**
 * Which transport is selected.
 *
 * A function rather than the constant this used to be, matching the shape every
 * other multi-transport capability already uses (`voiceProviderName()`,
 * `renderProviderName()`). It is written to `api_usage.provider`,
 * `ideas.generated_by` and `script_versions.provider`, so provenance records
 * which surface actually produced a row rather than a fixed label (§29).
 */
export function aiProviderName(): AiProviderName {
  return env().AI_PROVIDER;
}

/** The model id sent to the selected transport. Recorded alongside output (§29). */
export function aiModelName(): string {
  const e = env();
  return e.AI_PROVIDER === "bedrock" ? bedrockModel(e.BEDROCK_MODEL) : e.ANTHROPIC_MODEL;
}

/**
 * Bedrock model ids are namespaced: `anthropic.claude-opus-5`, not the bare
 * first-party `claude-opus-5`, which this API answers with a 404 "does not
 * exist". An operator who sets `BEDROCK_MODEL=claude-opus-5` has expressed an
 * unambiguous intention, so the prefix is added rather than turned into a
 * confusing runtime 404. A value that already carries a vendor prefix is passed
 * through untouched, so this cannot mangle a deliberate choice.
 */
function bedrockModel(configured: string): string {
  return configured.includes(".") ? configured : `anthropic.${configured}`;
}

const ANTHROPIC_HINT =
  "Create a key at https://console.anthropic.com/settings/keys and set " +
  "ANTHROPIC_API_KEY.";

const BEDROCK_HINT =
  "Set BEDROCK_REGION to a region where your account has access to the Claude " +
  "model in BEDROCK_MODEL. AWS credentials come from the standard credential " +
  "chain (environment, shared credentials file, SSO, or an instance/container " +
  "role) and are never read from Vidxir AI's configuration.";

/**
 * True when the selected transport has everything it needs to be *attempted*.
 *
 * On Bedrock that is the region and nothing else, deliberately. Credentials are
 * resolved asynchronously by the AWS chain from sources this process cannot
 * inspect synchronously — a profile, an SSO cache, an instance role — so
 * claiming to have verified them here would be a guess dressed as a check.
 * Absent or expired credentials surface instead as a `ProviderAuthError` naming
 * the chain, which is a distinct and accurate state (§48). This is the same
 * split `render` already makes between "configured" and "the binary is present".
 */
export function isAiConfigured(): boolean {
  return aiProviderName() === "bedrock"
    ? Boolean(bedrockRegion())
    : Boolean(env().ANTHROPIC_API_KEY);
}

export function aiMissingEnvVars(): string[] {
  if (isAiConfigured()) return [];
  return aiProviderName() === "bedrock" ? ["BEDROCK_REGION"] : ["ANTHROPIC_API_KEY"];
}

/**
 * The client, or a 503.
 *
 * Cached per resolved identity: both SDKs hold a connection pool, and rebuilding
 * it per request would discard keep-alive on the hottest path in the product. The
 * cache key covers the transport, the region and the key so that changing any of
 * them in a long-lived process cannot serve a stale client.
 */
type AiClient = Anthropic | AnthropicBedrockMantle;

let cachedClient: { key: string; client: AiClient } | undefined;

/** Shared transport tuning. Both SDKs take the same two options. */
const CLIENT_OPTIONS = {
  // Generation is a background job, so a long request is fine; a hung one
  // is not. The worker's own timeout is the outer bound.
  timeout: 10 * 60_000,
  // The SDK retries 408/429/5xx with backoff. Two is enough that a blip
  // recovers and few enough that a real outage surfaces promptly.
  maxRetries: 2,
} as const;

function client(): AiClient {
  const e = env();

  if (e.AI_PROVIDER === "bedrock") {
    const region = bedrockRegion();
    // Checked before construction, not after: the Bedrock client's constructor
    // throws a bare SDK error when it cannot resolve a region, which would reach
    // the caller as an unclassified 500 instead of the 503-with-a-variable-name
    // §48 requires.
    if (!region) {
      throw new NotConfiguredError("Claude on Bedrock", ["BEDROCK_REGION"], BEDROCK_HINT);
    }
    const cacheKey = `bedrock:${region}`;
    if (cachedClient?.key !== cacheKey) {
      cachedClient = {
        key: cacheKey,
        // No credentials passed: omitting them is what selects the standard AWS
        // provider chain, which is the only place Vidxir AI will read them from (§33).
        client: new AnthropicBedrockMantle({ awsRegion: region, ...CLIENT_OPTIONS }),
      };
    }
    return cachedClient.client;
  }

  const key = e.ANTHROPIC_API_KEY;
  if (!key) {
    throw new NotConfiguredError("Claude", ["ANTHROPIC_API_KEY"], ANTHROPIC_HINT);
  }
  const cacheKey = `anthropic:${key}`;
  if (cachedClient?.key !== cacheKey) {
    cachedClient = {
      key: cacheKey,
      client: new Anthropic({ apiKey: key, ...CLIENT_OPTIONS }),
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
 * The name that appears in operator-facing errors.
 *
 * "Claude" alone would be ambiguous once there are two ways to reach it: an
 * operator reading "Claude rejected our credentials" needs to know whether to
 * rotate an Anthropic key or refresh an AWS session (§48). Exported so the API
 * routes that refuse up front name the same thing this module does.
 */
export function aiProviderLabel(provider: AiProviderName = aiProviderName()): string {
  return provider === "bedrock" ? "Claude on Bedrock" : "Claude";
}

/** Internal alias, kept short at the call sites below. */
const providerLabel = aiProviderLabel;

/** The tool name Bedrock emits structured output through. */
const EMIT_TOOL = "emit_result";

/**
 * How many repair rounds a Bedrock reply gets when it fails local validation.
 *
 * One, and only on Bedrock. The first-party API constrains the decoder to the
 * schema, so a shape failure there is a defect worth surfacing rather than a
 * sample worth retaking. Bedrock accepts neither `output_config.format` nor a
 * `strict` tool, so its schema is advisory and occasional drift — a one-element
 * array emitted as a bare string is the observed case — is a property of the
 * transport, not a bug in the prompt. The repair round hands back the exact
 * validation errors, which is a real second call: it is billed, recorded in
 * `api_usage` like any other, and may itself fail.
 */
const BEDROCK_REPAIR_ROUNDS = 1;

/**
 * Build the request body for the selected transport.
 *
 * Both surfaces are asked for the same thing — an object matching
 * `options.jsonSchema` — but they do not accept the same parameters, and this is
 * the one place that difference is allowed to exist.
 *
 * **First-party API:** `output_config.format` with a `json_schema`. The decoder
 * itself is constrained, so the response is parseable by construction.
 *
 * **Bedrock:** `output_config.format` is rejected outright (400 "output_config.
 * format: Extra inputs are not permitted"), and so is `strict: true` on a tool
 * ("tools.0.custom.strict: Extra inputs are not permitted"). Verified against
 * the live API rather than inferred from a compatibility table. The supported
 * equivalent is a single-tool schema with a forced `tool_choice`, which makes the
 * model emit its answer as tool input validated against the same JSON Schema.
 * The shape guarantee is weaker than a constrained decoder — hence the local Zod
 * pass below is load-bearing here, not belt-and-braces.
 *
 * Adaptive thinking and `effort` are sent on both: these are judgement tasks (is
 * this topic actually an opportunity, does this hook earn the next thirty
 * seconds) where reasoning measurably changes the answer, and Bedrock accepts
 * both parameters alongside forced tool use. `budget_tokens` is deliberately
 * absent — Opus 5 rejects it with a 400.
 */
function requestFor<T extends z.ZodTypeAny>(
  provider: AiProviderName,
  model: string,
  options: GenerateJsonOptions<T>,
  effort: "low" | "medium" | "high" | "xhigh" | "max",
  /**
   * Turns appended after the task prompt. Empty on a first attempt; a repair
   * round passes the model's own reply and the validation errors it has to fix,
   * so the correction is grounded in what it actually produced.
   */
  followUp: readonly Anthropic.MessageParam[] = [],
): Anthropic.MessageCreateParamsNonStreaming {
  const shared = {
    model,
    max_tokens: options.maxTokens ?? 8_000,
    system: options.system,
    messages: [
      { role: "user" as const, content: options.prompt },
      ...followUp,
    ],
    thinking: { type: "adaptive" as const },
  };

  if (provider === "bedrock") {
    return {
      ...shared,
      output_config: { effort },
      tools: [
        {
          name: EMIT_TOOL,
          description:
            "Emit the final result. Every field is required and must follow the " +
            "schema exactly.",
          input_schema: options.jsonSchema as Anthropic.Tool.InputSchema,
        },
      ],
      // Forced rather than `auto`: the caller asked for an object, so a prose
      // reply is not an acceptable outcome to leave available.
      tool_choice: { type: "tool", name: EMIT_TOOL },
    };
  }

  return {
    ...shared,
    output_config: {
      effort,
      format: { type: "json_schema", schema: options.jsonSchema },
    },
  };
}

/** The `emit_result` call in a Bedrock reply, if the model made one. */
function emittedTool(raw: Anthropic.Message): Anthropic.ToolUseBlock | undefined {
  return raw.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use" && block.name === EMIT_TOOL,
  );
}

/**
 * Pull the JSON payload out of a response, per transport.
 *
 * Returns the value already decoded on Bedrock (tool input arrives as an object,
 * so there is nothing to parse) or the concatenated text on the first-party API.
 * Keeping the two apart here is what lets the validation and error handling below
 * be written once.
 */
function extractPayload(
  provider: AiProviderName,
  raw: Anthropic.Message,
  label: string,
): unknown {
  if (provider === "bedrock") {
    const emitted = emittedTool(raw);
    if (!emitted) {
      // The model answered in prose despite a forced tool choice, or refused.
      // Retryable: a second sample normally complies, and the alternative is
      // handing the caller nothing while claiming success.
      throw new ProviderError(
        label,
        "The model did not return a structured result.",
        { retryable: true, details: { stopReason: raw.stop_reason } },
      );
    }
    return emitted.input;
  }

  const text = raw.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    throw new ProviderError(label, "The model returned an empty response.", {
      retryable: true,
      details: { stopReason: raw.stop_reason },
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(label, "The model returned malformed JSON.", {
      retryable: true,
      details: { stopReason: raw.stop_reason },
    });
  }
}

/**
 * Generate a JSON object matching `schema`.
 *
 * Transport-agnostic by construction: the only per-provider branches are the
 * request body and the payload extraction, both isolated above.
 */
export async function generateJson<T extends z.ZodTypeAny>(
  options: GenerateJsonOptions<T>,
): Promise<z.infer<T>> {
  const e = env();
  const provider = e.AI_PROVIDER;
  const label = providerLabel(provider);
  // Constructed before the usage wrapper so a not-configured transport fails as
  // a 503 rather than recording a spurious failed call against a user (§41).
  const anthropic = client();
  const model = aiModelName();
  const effort = options.effort ?? e.ANTHROPIC_EFFORT;

  // Only Bedrock gets a repair round; see BEDROCK_REPAIR_ROUNDS.
  const maxAttempts = provider === "bedrock" ? 1 + BEDROCK_REPAIR_ROUNDS : 1;
  let followUp: Anthropic.MessageParam[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const raw = await withUsage(
      {
        // The transport, so accounting and provenance say which surface was billed.
        provider,
        operation: options.usage.operation,
        model,
        userId: options.usage.userId ?? null,
        projectId: options.usage.projectId ?? null,
        jobId: options.usage.jobId ?? null,
        traceId: options.usage.traceId ?? null,
      },
      async () => {
        try {
          return await anthropic.messages.create(
            requestFor(provider, model, options, effort, followUp),
          );
        } catch (error) {
          throw translate(error);
        }
      },
      (message) => ({
        // Input + output tokens: the figure that maps to the invoice. A repair
        // round records its own row, so the accounting shows what was really
        // spent rather than hiding the second call inside the first (§41).
        quantity: message.usage.input_tokens + message.usage.output_tokens,
        unit: "tokens",
      }),
    );

    // `max_tokens` reached mid-object: the payload is truncated, and reading it
    // would either throw below or — worse — succeed on a half-written array and
    // hand the caller silently incomplete data. Checked before extraction so the
    // diagnosis is the real cause rather than the malformed JSON it produces.
    // Not repairable: a retry of the same prompt truncates in the same place.
    if (raw.stop_reason === "max_tokens") {
      throw new ProviderError(
        label,
        "The model's response was cut off before it finished. Try a shorter request.",
        { retryable: false, details: { stopReason: raw.stop_reason } },
      );
    }

    const parsed = extractPayload(provider, raw, label);
    const result = options.schema.safeParse(parsed);

    if (result.success) {
      // Provider and model are logged on every success: with two transports,
      // "which one served this?" is the first question of any diagnosis, and it
      // must be answerable from the logs alone. Neither value is a secret — no
      // credential, account id or region-derived identity appears here (§33).
      log.debug("generation complete", {
        provider,
        model,
        operation: options.usage.operation,
        userId: options.usage.userId ?? undefined,
        inputTokens: raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
        // 1 unless a repair round was needed, so the rate is measurable.
        attempts: attempt,
        status: "ok",
      });

      return result.data;
    }

    const issues = result.error.issues.slice(0, 5).map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    }));

    log.warn("model output failed local validation", {
      provider,
      model,
      operation: options.usage.operation,
      attempt,
      willRepair: attempt < maxAttempts,
      issues,
    });

    if (attempt >= maxAttempts) {
      // Out of repair rounds. Retryable at the queue level: a fresh sample
      // usually conforms, and the alternative is passing a half-shaped object to
      // a caller whose types say it is complete.
      throw new ProviderError(
        label,
        "The model's response did not match the expected structure.",
        { retryable: true },
      );
    }

    // The model's own reply, then the errors — a correction, not a re-roll. The
    // assistant turn is echoed verbatim (thinking blocks included, which the API
    // requires be preserved) so the repair edits what it produced.
    //
    // The errors come back as a `tool_result`, not as a plain user turn: a
    // `tool_use` block must be answered by a `tool_result` in the very next
    // message, and anything else is a 400 ("`tool_use` ids were found without
    // `tool_result` blocks immediately after") — verified against the live API.
    // Which is the honest framing anyway: the tool call was made and it failed.
    // Present by construction: `extractPayload` throws above when the reply
    // carries no `emit_result` call, so reaching a validation failure on Bedrock
    // means there was one to validate.
    const emitted = emittedTool(raw);
    followUp = [
      { role: "assistant", content: raw.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: emitted?.id ?? "",
            is_error: true,
            content:
              `Rejected — the input did not match the schema for ${EMIT_TOOL}:\n` +
              issues.map((i) => `- ${i.path}: ${i.message}`).join("\n") +
              `\n\nCall ${EMIT_TOOL} again with the same content, fixing only ` +
              "these fields. Keep every other value identical, and match the " +
              "declared type exactly — a field typed as an array must be an " +
              "array even when it holds one element.",
          },
        ],
      },
    ];
  }
}

/**
 * Map an SDK error onto Vidxir AI's taxonomy (§30).
 *
 * The distinction that matters: 429 and 5xx are worth another attempt, 401 and
 * 400 are not. Retrying a bad request forever is how a queue fills up.
 *
 * Both transports raise the same `Anthropic.APIError` subclasses — the Bedrock
 * client extends the same base client, verified against live 401/404/connection
 * failures — so the classification is shared. What differs is the *remedy* in the
 * message: rotating an Anthropic key and refreshing an AWS session are different
 * actions, and §48 asks that the operator be told which one applies.
 *
 * Exported for tests. Classification is the part of this module worth pinning —
 * whether a failure retries, and what the operator is told to fix, both follow
 * from it — and it cannot be exercised through `generateJson` without either a
 * live account in a specific broken state or a mocked SDK client.
 */
export function translate(error: unknown): Error {
  // Read once: an operator debugging a failure needs the message to describe the
  // transport that actually failed.
  const provider = aiProviderName();
  const label = providerLabel(provider);
  const bedrock = provider === "bedrock";

  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;

    if (status === 401 || status === 403) {
      return new ProviderAuthError(
        label,
        bedrock
          ? "AWS rejected the Bedrock request. The credentials from the AWS " +
            "credential chain are missing, expired, or lack " +
            "bedrock:InvokeModel for this model. Refresh them and check " +
            "BEDROCK_REGION."
          : "Claude rejected the API key. Check ANTHROPIC_API_KEY.",
        error,
      );
    }
    /**
     * A 404 from Bedrock means the model id is not available to this account in
     * this region — a configuration error with a specific fix, and one that is
     * easy to hit because Bedrock ids are namespaced (`anthropic.claude-opus-5`)
     * and model access is granted per region. Left unclassified it would surface
     * as a bare "404 not found" against a perfectly valid credential.
     *
     * Not retryable, and deliberately not a `NotConfiguredError`: the variables
     * are set, so reporting them as absent would be wrong.
     */
    if (bedrock && status === 404) {
      return new ProviderError(
        label,
        "Bedrock does not have this Claude model available. Check BEDROCK_MODEL " +
          "(Bedrock ids look like `anthropic.claude-opus-5`) and that the model " +
          "is enabled for your account in BEDROCK_REGION.",
        { retryable: false, cause: error },
      );
    }
    // A 400 whose message is about billing, not about the request. The key is
    // valid, so this is not an auth failure, and no amount of retrying will add
    // credit — it needs naming so the operator knows what to fix (§30, §48).
    if (status === 400 && /credit balance is too low|purchase credits/i.test(error.message)) {
      return new ProviderOutOfCreditError(label, error);
    }
    if (status === 429) {
      const header = error.headers?.get?.("retry-after");
      const seconds = Number(header);
      return new ProviderRateLimitError(
        label,
        Number.isFinite(seconds) && seconds > 0 ? seconds : 30,
        error,
      );
    }
    if (status === 408 || error instanceof Anthropic.APIConnectionTimeoutError) {
      return new ProviderTimeoutError(label, 10 * 60_000);
    }
    if (status >= 500 || error instanceof Anthropic.APIConnectionError) {
      return new ProviderError(label, `${label} is temporarily unavailable.`, {
        retryable: true,
        cause: error,
      });
    }
    return new ProviderError(label, error.message, {
      retryable: false,
      cause: error,
    });
  }

  return new ProviderError(label, "Generation failed.", {
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
