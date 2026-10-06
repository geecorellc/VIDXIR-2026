/**
 * The Bedrock repair round (§32, §42).
 *
 * Bedrock rejects both `output_config.format` and `strict: true` on a tool, so
 * the JSON Schema it is given is advisory: the model usually honours it and
 * occasionally does not. The observed drift is a one-element array emitted as a
 * bare string, which the local Zod pass catches — correctly — and which used to
 * fail the whole request. `generateJson()` now hands the validation errors back
 * once, on Bedrock only.
 *
 * What is asserted here is everything that could go wrong with that idea:
 *
 *  - the repair actually carries the model's own reply and the specific issues,
 *    so it is a correction rather than a re-roll;
 *  - it is **bounded** — one round, then the request fails, because an unbounded
 *    self-correction loop against a paid API is an outage that bills;
 *  - each attempt records its own `api_usage` row, so accounting shows what was
 *    really spent (§41);
 *  - the first-party transport does **not** get a repair round: its decoder is
 *    schema-constrained, so a shape failure there is a defect to surface, not a
 *    sample to retake.
 *
 * The SDK clients are stubbed because the assertions are about request
 * construction and control flow. The Bedrock behaviour they stand in for was
 * established against the live API, and the five AI features are verified
 * end-to-end against real Bedrock separately — this file is not a substitute for
 * that.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { isRetryable } from "@/lib/errors";
import { resetEnvCache } from "@/lib/env";

/** Replies the stubbed transport hands back, in order. Consumed as it serves. */
let replies: Anthropic.Message[] = [];
/** Replies already served, so a request can be compared against what was said. */
let served: Anthropic.Message[] = [];
/** Every request body the module built, for inspection. */
let requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
/** Rows `withUsage` wrote, so "one row per attempt" can be checked (§41). */
let usageRows: Array<Record<string, unknown>> = [];

function create(
  body: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  requests.push(body);
  const next = replies.shift();
  if (!next) throw new Error("stub called more times than the test expected");
  served.push(next);
  return Promise.resolve(next);
}

vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  AnthropicBedrockMantle: class {
    messages = { create };
  },
}));

/**
 * The first-party client is stubbed the same way, by subclassing the real one:
 * `translate()` reads `Anthropic.APIError` off this export, so replacing the
 * module wholesale would break the error taxonomy it shares with Bedrock.
 */
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class Stub extends mod.default {
    override messages = { create } as unknown as Anthropic["messages"];
  }
  return { ...mod, default: Stub };
});

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        usageRows.push(row);
        return Promise.resolve();
      },
    }),
  },
}));

const { generateJson, jsonSchema, resetAiClientCache, stringArray } = await import(
  "@/lib/providers/ai"
);

/** Local placeholders `lib/env` needs to parse. Nothing here connects anywhere. */
const BASE: Record<string, string> = {
  DATABASE_URL: "postgresql://vidxir:vidxir@localhost:5432/vidxir_unit",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_BUCKET: "vidxir-unit",
  S3_ACCESS_KEY_ID: "unit",
  S3_SECRET_ACCESS_KEY: "unit",
  ENCRYPTION_KEY: "a".repeat(64),
  SESSION_SECRET: "b".repeat(64),
};

const MANAGED = [
  "AI_PROVIDER",
  "ANTHROPIC_API_KEY",
  "BEDROCK_REGION",
  "BEDROCK_MODEL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  ...Object.keys(BASE),
] as const;

const original = new Map<string, string | undefined>(
  MANAGED.map((key) => [key, process.env[key]]),
);

function useProvider(provider: "anthropic" | "bedrock"): void {
  for (const key of MANAGED) delete process.env[key];
  for (const [key, value] of Object.entries(BASE)) process.env[key] = value;
  process.env["AI_PROVIDER"] = provider;
  if (provider === "bedrock") process.env["BEDROCK_REGION"] = "us-east-1";
  else process.env["ANTHROPIC_API_KEY"] = "unit-placeholder";
  resetEnvCache();
  resetAiClientCache();
}

beforeEach(() => {
  replies = [];
  served = [];
  requests = [];
  usageRows = [];
});

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  resetAiClientCache();
});

/** The shape under test: the field Bedrock was observed to flatten. */
const Schema = z.object({
  title: z.string(),
  hashtags: z.array(z.string()).max(3),
});

const SCHEMA = jsonSchema({
  properties: {
    title: { type: "string", description: "A title." },
    hashtags: stringArray("Up to three hashtags.", { maxItems: 3 }),
  },
  required: ["title", "hashtags"],
});

function bedrockReply(input: unknown): Anthropic.Message {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "anthropic.claude-opus-5",
    content: [
      { type: "thinking", thinking: "…", signature: "sig" },
      { type: "tool_use", id: "toolu_stub", name: "emit_result", input },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 40 },
  } as unknown as Anthropic.Message;
}

function textReply(text: string): Anthropic.Message {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 40 },
  } as unknown as Anthropic.Message;
}

function generate(): Promise<z.infer<typeof Schema>> {
  return generateJson({
    system: "You emit metadata.",
    prompt: "Draft metadata for a video about index funds.",
    schema: Schema,
    jsonSchema: SCHEMA,
    usage: { operation: "metadata.draft", userId: "user-1" },
  });
}

describe("Bedrock repair round", () => {
  beforeEach(() => useProvider("bedrock"));

  it("recovers when the advisory schema is not honoured", async () => {
    // The live failure: a single hashtag emitted as a bare string.
    replies = [
      bedrockReply({ title: "Index funds", hashtags: "#investing" }),
      bedrockReply({ title: "Index funds", hashtags: ["#investing"] }),
    ];

    await expect(generate()).resolves.toEqual({
      title: "Index funds",
      hashtags: ["#investing"],
    });
    expect(requests).toHaveLength(2);
  });

  it("feeds back the model's own reply and the exact validation errors", async () => {
    replies = [
      bedrockReply({ title: "Index funds", hashtags: "#investing" }),
      bedrockReply({ title: "Index funds", hashtags: ["#investing"] }),
    ];
    await generate();

    const repair = requests[1]!;
    // Task prompt, the assistant turn being corrected, then the errors.
    expect(repair.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    // Echoed verbatim, thinking block included — the API requires that a
    // thinking turn be preserved, and a summary would not be the model's reply.
    expect(repair.messages[1]!.content).toEqual(served[0]!.content);

    /**
     * A `tool_result`, not a text turn. Bedrock requires that a `tool_use` block
     * be answered by a `tool_result` in the immediately following message and
     * rejects anything else with a 400 — the shape this test pins is the one the
     * live API accepts.
     */
    const correction = repair.messages[2]!
      .content as Anthropic.ToolResultBlockParam[];
    expect(correction[0]!.type).toBe("tool_result");
    expect(correction[0]!.is_error).toBe(true);
    // Answering the specific call that failed, not a fabricated id.
    expect(correction[0]!.tool_use_id).toBe("toolu_stub");

    const text = correction[0]!.content as string;
    // The failing field, so the model is told what to fix rather than to try again.
    expect(text).toContain("hashtags");
    expect(text).toMatch(/array/i);

    // Still a forced single-tool request: the repair is the same contract.
    expect(repair.tool_choice).toEqual({ type: "tool", name: "emit_result" });
    expect(repair.tools?.[0]?.name).toBe("emit_result");
  });

  it("is bounded at one round rather than looping against a paid API", async () => {
    replies = [
      bedrockReply({ title: "Index funds", hashtags: "#investing" }),
      bedrockReply({ title: "Index funds", hashtags: "#investing" }),
    ];

    const error = await generate().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Claude on Bedrock");
    // Retryable at the queue level — a fresh sample usually conforms — but this
    // request is over: exactly two calls, not a third.
    expect(isRetryable(error)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("records one api_usage row per attempt (§41)", async () => {
    replies = [
      bedrockReply({ title: "Index funds", hashtags: "#investing" }),
      bedrockReply({ title: "Index funds", hashtags: ["#investing"] }),
    ];
    await generate();

    expect(usageRows).toHaveLength(2);
    for (const row of usageRows) {
      // The repair is billed like any other call, and provenance says which
      // transport served it (§29).
      expect(row["provider"]).toBe("bedrock");
      expect(row["operation"]).toBe("metadata.draft");
      expect(row["ok"]).toBe(true);
      expect(row["quantity"]).toBe(140);
    }
  });

  it("does not repair a truncated reply, which would truncate again", async () => {
    const cut = bedrockReply({ title: "Index funds" });
    (cut as { stop_reason: string }).stop_reason = "max_tokens";
    replies = [cut];

    const error = await generate().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect((error as Error).message).toMatch(/cut off/i);
    expect(isRetryable(error)).toBe(false);
    expect(requests).toHaveLength(1);
  });
});

describe("first-party transport", () => {
  beforeEach(() => useProvider("anthropic"));

  /**
   * No repair round here, deliberately. `output_config.format` constrains the
   * decoder, so a response that fails Zod means the schema pair has diverged or
   * the API changed — a defect worth surfacing, not a sample worth retaking.
   */
  it("fails a malformed reply on the first attempt", async () => {
    replies = [textReply(JSON.stringify({ title: "Index funds", hashtags: "#x" }))];

    const error = await generate().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect((error as Error).message).toContain("did not match the expected structure");
    expect(requests).toHaveLength(1);
    expect(usageRows).toHaveLength(1);
  });

  it("still constrains the decoder rather than using a tool", async () => {
    replies = [
      textReply(JSON.stringify({ title: "Index funds", hashtags: ["#investing"] })),
    ];
    await generate();

    expect(requests[0]!.tools).toBeUndefined();
    expect(requests[0]!.output_config?.format).toEqual({
      type: "json_schema",
      schema: SCHEMA,
    });
  });
});
