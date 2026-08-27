/**
 * Prove the video-generation provider layer is honest in a real Node process (§24).
 *
 * `verify-providers.ts` answers a different question: it *calls* each configured
 * provider to see whether the credential works. That question cannot be asked of
 * a video model — §11, §12 and §24 all forbid a live generation request, and one
 * Veo clip costs real money. So this script proves the property that is actually
 * at stake and is actually checkable without spending anything: **the layer tells
 * the truth about what it can do, and refuses everything else.**
 *
 * That matters because the failure modes here are all quiet. A provider that
 * reports itself ready without a key produces a 500 at generation time, after the
 * user has waited through scripting. A registry that accepts an unknown model id
 * interpolates a client string into a vendor API path. A picker payload that
 * carries a credential leaks it to every browser that opens the page. None of
 * these fail a unit test that mocks the environment; all of them are visible to a
 * process that reads the real one.
 *
 * The thirteen invariants, in execution order. Steps 1-9 run with mock providers
 * *off*, which is the honest reading of a production deployment that has
 * configured nothing; steps 10-11 turn them on, because that is the only way to
 * exercise the generation path without billing anyone:
 *
 *    1. stock is selectable on every plan, with no AI provider configured
 *    2. unconfigured providers report NOT_CONFIGURED and cannot be reached
 *    3. unknown providers, invented model ids and invented modes are refused
 *    4. every fal.ai model is a distinct, selectable entry on one credential
 *    5. each fal.ai model has its own endpoint slug, none hardcoded with a key
 *    6. plan entitlements gate AI video and the premium models
 *    7. no secret is reachable from anything the client is sent
 *    8. no provider module performs I/O at import, and the plan layer is
 *       vendor-agnostic
 *    9. the mock provider is unreachable in a production configuration
 *   10. AI selection resolves mode/model/format, and an impossible pairing is
 *       refused
 *   11. a generated clip carries its model, licence, prompt and geometry (§22, §29)
 *   12. the §20 provider audit table, from the real environment
 *   13. no destructive or billable external action — asserted about this script
 *
 * Steps 4 and 5 are the fal.ai catalogue's own invariants, and they are the ones
 * that cannot be checked any other way. Whether Kling actually renders is fal.ai's
 * business; whether *selecting* Kling reaches Kling's endpoint rather than
 * Seedance's is Tally's, and a mistake there generates successfully, bills
 * correctly and produces the wrong model's output with nothing to indicate it.
 *
 * ## What this script does NOT do
 *
 * §24's prohibitions, held to literally. It makes **no** call to fal.ai, Google
 * AI, Runway or any other generation API; **no** YouTube read, upload or
 * publication; **no** Stripe charge, checkout, subscription or portal session. It
 * writes nothing to Postgres, enqueues nothing, and touches no production data —
 * every check below is a pure function of the environment and the module graph.
 * It prints no credential value: §20 asks for CONFIGURED / NOT_CONFIGURED and the
 * variable *names*, and that is the most it knows how to say.
 *
 * The one clip it generates comes from the `mock` provider, which synthesises a
 * PNG in-process and has no `requiredEnvVars` — it exists so invariants 8 and 9
 * are proven against a real `generateClip` call rather than around it.
 *
 * `resetEnvCache()` between the two halves is what makes each answer about the
 * configuration it claims to be about: without it, step 1's "nothing configured"
 * claim and step 8's "a provider is ready" claim would be read from the same
 * cached environment, and one of them would be false.
 *
 *   npx tsx scripts/verify-video-providers.ts
 *
 * Exits non-zero on the first failure. A provider being unconfigured is a
 * documented state and not a failure — it is what most deployments look like, and
 * a script that failed on it would just be turned off.
 */
import "@/lib/load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOTAL_STEPS = 13;
let step = 0;

function ok(message: string): void {
  step += 1;
  console.log(`  ${step}. OK  ${message}`);
}

function detail(message: string): void {
  console.log(`        ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Assert, with the failure phrased as what would now be wrong in production. */
function must(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/** Run `fn` and return the error it threw, or fail if it did not throw. */
function refusal(fn: () => unknown, what: string): { code: string; status: number } {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) fail(`${what} was accepted; it must be refused.`);
  const error = thrown as { code?: unknown; status?: unknown; message?: unknown };
  return {
    code: typeof error.code === "string" ? error.code : "untyped",
    status: typeof error.status === "number" ? error.status : 0,
  };
}

/** Source of one of our own modules, for the static checks. */
function sourceOf(relative: string): string {
  return readFileSync(join(process.cwd(), "src", relative), "utf8");
}

const PLAN_TIERS = ["starter", "studio", "scale"] as const;

async function main(): Promise<void> {
  console.log(
    "\nvideo provider verification " +
      "(no generation API call, no upload, no charge, no database write)\n",
  );

  const { resetEnvCache } = await import("@/lib/env");

  // -----------------------------------------------------------------------
  // 1. stock is selectable on every plan, with no AI provider configured
  // -----------------------------------------------------------------------
  /**
   * The pre-Phase-11 guarantee (§13).
   *
   * Read with mock providers forced off, because that is what a real deployment
   * that has configured nothing looks like — and the thing §13 promises is that
   * such a deployment still works exactly as it did before Phase 11. Stock is not
   * gated on a video-gen provider existing, and asking for it must never reach the
   * registry at all.
   */
  process.env["TALLY_USE_MOCK_PROVIDERS"] = "false";
  resetEnvCache();

  {
    const { generationOptions, validateSelection } = await import(
      "@/lib/video/generation-plan"
    );
    const { videoFormats } = await import("@/lib/video/format");

    for (const tier of PLAN_TIERS) {
      const options = generationOptions(tier);
      const stock = options.modes.find((m) => m.mode === "STOCK");
      must(
        stock !== undefined && !stock.locked,
        `stock footage is not offered on the ${tier} plan; it is included on every plan.`,
      );

      const selection = validateSelection({ mode: "STOCK", tier });
      must(
        selection.generationMode === "STOCK" && selection.generationModel === null,
        `a stock selection on ${tier} did not resolve to STOCK with no model.`,
      );
    }

    // Every format is offered in stock mode, and an unrecognised one falls back to
    // the default rather than being stored as-is.
    for (const spec of videoFormats()) {
      const selection = validateSelection({
        mode: "STOCK",
        format: spec.format,
        tier: "starter",
      });
      must(
        selection.videoFormat === spec.format,
        `stock mode dropped the ${spec.format} format.`,
      );
    }
    must(
      validateSelection({ mode: "STOCK", format: "hexagonal", tier: "starter" })
        .videoFormat === "landscape",
      "an unknown format was stored rather than falling back to the default.",
    );

    // A model with stock is a contradiction, not a hint to switch mode.
    const withModel = refusal(
      () =>
        validateSelection({ mode: "STOCK", model: "mock/placeholder", tier: "scale" }),
      "a stock selection carrying a video model",
    );
    must(
      withModel.status === 400,
      `a stock+model selection was refused with ${withModel.status}; expected 400.`,
    );

    ok("stock footage is selectable on every plan with no AI provider configured");
    detail(
      `all three formats round-trip; an unknown format falls back to landscape; ` +
        `stock+model is refused with 400 ${withModel.code}`,
    );
  }

  // -----------------------------------------------------------------------
  // 2. unconfigured providers report NOT_CONFIGURED and cannot be reached
  // -----------------------------------------------------------------------
  /**
   * Checked here, while mock providers are still off, because that is the only
   * configuration in which the answer is meaningful. §11 and §12 both say the same
   * thing in different words: do not pretend a provider is operational when its
   * credential is absent.
   *
   * The step order throughout is by environment rather than by topic: everything
   * answerable with nothing configured runs first, so no earlier step's answer
   * depends on mock mode having been turned on.
   */
  {
    const { allVideoGenStatuses, isVideoGenConfigured, resolveModel } = await import(
      "@/lib/providers/video-gen"
    );

    const statuses = allVideoGenStatuses();
    must(statuses.length > 0, "the provider registry is empty; it must list every known provider.");

    for (const status of statuses) {
      if (status.state === "ready") {
        must(
          status.missingEnvVars.length === 0,
          `${status.provider} reports ready with ${status.missingEnvVars.join(", ")} unset. ` +
            `A ready provider must have every credential present.`,
        );
      }
      if (status.state === "not_configured") {
        must(
          status.missingEnvVars.length > 0,
          `${status.provider} reports not_configured but names no missing variable, ` +
            `so an operator cannot tell what to set.`,
        );
        must(
          status.hint.length > 0,
          `${status.provider} reports not_configured with no hint about where the credential comes from.`,
        );
      }
      // §20: names only, never values.
      for (const name of [...status.requiredEnvVars, ...status.missingEnvVars]) {
        must(
          /^[A-Z][A-Z0-9_]*$/.test(name),
          `${status.provider} reports "${name}" as an env var name; that is not a name shape.`,
        );
      }
    }

    // A model behind an unconfigured provider is refused at resolve time, so the
    // failure happens before a request is built rather than as a vendor 401.
    let unconfiguredProbed = 0;
    for (const status of statuses) {
      if (status.state !== "not_configured" && status.state !== "disabled") continue;
      for (const model of status.models) {
        const error = refusal(
          () => resolveModel(model.id),
          `model ${model.id} behind ${status.state} provider ${status.provider}`,
        );
        must(
          error.status === 400 || error.code === "provider_not_configured",
          `${model.id} was refused with ${error.status} ${error.code}; expected a 400 ` +
            `(not available on this deployment) or provider_not_configured.`,
        );
        unconfiguredProbed += 1;
      }
    }

    const ready = statuses.filter((s) => s.state === "ready");
    must(
      isVideoGenConfigured() === (ready.length > 0 || statuses.some((s) => s.state === "mock")),
      "isVideoGenConfigured() disagrees with the per-provider states.",
    );

    ok("unconfigured providers report NOT_CONFIGURED and cannot be reached");
    detail(
      `${statuses.length} providers known; ${ready.length} ready; ` +
        `${unconfiguredProbed} model ids behind an unconfigured or disabled provider all refused`,
    );
  }

  // -----------------------------------------------------------------------
  // 3. unknown providers, invented model ids and invented modes are refused
  // -----------------------------------------------------------------------
  /**
   * §10's rule, and the reason it is a security property rather than a validation
   * nicety: a model id that reached `generate` unchecked would be interpolated
   * into a vendor API path. A client must not be able to choose that string.
   */
  {
    const { resolveModel } = await import("@/lib/providers/video-gen");

    const invented = [
      "fal/seedance-99-ultra",
      "seedance/v99-ultra",
      "veo/9.9",
      "openai/sora",
      "mock/../../etc/passwd",
      // The fal.ai endpoint slug rather than the catalogue id. A client that
      // learned a real vendor path must not be able to submit it as a model.
      "fal-ai/bytedance/seedance/v1/pro/text-to-video",
      "fal/../../veo3",
      "",
      "not-a-namespaced-id",
      "fal",
      "seedance",
      "FAL/SEEDANCE-1-PRO",
    ];
    for (const id of invented) {
      const error = refusal(() => resolveModel(id), `invented model id "${id}"`);
      must(
        error.status === 400 || error.code === "provider_not_configured",
        `"${id}" was refused with ${error.status} ${error.code}; expected 400 or a ` +
          `configuration refusal, never a generic 500.`,
      );
    }

    // The same refusal through the selection layer a route actually calls, so this
    // is not merely a property of an internal function.
    const { validateSelection } = await import("@/lib/video/generation-plan");
    for (const mode of ["", "AI", "stock", "AI_VIDEO_PRO", "__proto__"]) {
      const error = refusal(
        () => validateSelection({ mode, tier: "scale" }),
        `invented generation mode "${mode}"`,
      );
      must(error.status === 400, `mode "${mode}" was refused with ${error.status}; expected 400.`);
    }

    ok("unknown providers, invented model ids and invented modes are all refused");
    detail(
      `${invented.length} model ids and 5 mode strings refused with 400 or a ` +
        `configuration error; none reached a provider`,
    );
  }

  // -----------------------------------------------------------------------
  // 4. the fal.ai catalogue routes each model to its own endpoint
  // -----------------------------------------------------------------------
  /**
   * §14, and the reason it is checked statically rather than by generating: the
   * catalogue is the only thing standing between "the user picked Kling" and a URL,
   * so a duplicated or malformed endpoint would silently bill one vendor's model
   * for another's. None of that is visible without a paid generation — but all of
   * it is visible in the table itself.
   *
   * Read from `allVideoGenStatuses()`, so this holds whether or not `FAL_KEY` is
   * set: an operator with nothing configured still gets the invariant checked.
   */
  {
    const { allVideoGenStatuses } = await import("@/lib/providers/video-gen");
    const { videoFormats } = await import("@/lib/video/format");

    const fal = allVideoGenStatuses().find((s) => s.provider === "fal");
    if (!fal) fail("the fal.ai provider is missing from the registry.");
    must(
      fal.models.length > 1,
      `fal.ai lists ${fal.models.length} model(s); it is a catalogue provider and the ` +
        `whole point of it is that a user can choose between models.`,
    );
    must(
      fal.requiredEnvVars.length === 1 && fal.requiredEnvVars[0] === "FAL_KEY",
      `fal.ai requires ${fal.requiredEnvVars.join(", ") || "nothing"}; the catalogue is ` +
        `reached with one credential, so anything else here means a model has been ` +
        `given its own configuration and can no longer be added without an env change.`,
    );

    const known = new Set(videoFormats().map((s) => s.format));
    const ids = new Set<string>();
    for (const model of fal.models) {
      must(
        model.id.startsWith("fal/") && /^fal\/[a-z0-9][a-z0-9-]*$/.test(model.id),
        `"${model.id}" is not a fal catalogue id; ids are namespaced and lowercase so ` +
          `nothing in one can be read as a path segment of a vendor URL.`,
      );
      must(!ids.has(model.id), `${model.id} appears twice in the catalogue.`);
      ids.add(model.id);
      must(
        model.label.trim().length > 0 && model.description.trim().length > 0,
        `${model.id} has no label or description; the picker would render a blank row.`,
      );
      must(
        model.formats.length > 0 && model.formats.every((f) => known.has(f)),
        `${model.id} declares formats [${model.formats.join(", ")}], which is empty or ` +
          `names a frame format.ts does not define.`,
      );
    }

    ok("every fal.ai model is a distinct, selectable catalogue entry on one credential");
    detail(
      `${fal.models.length} models — ${fal.models.map((m) => m.label).join(", ")} — ` +
        `all behind FAL_KEY alone`,
    );
  }

  // -----------------------------------------------------------------------
  // 5. one endpoint per model, and no credential in the catalogue
  // -----------------------------------------------------------------------
  /**
   * The half of the above that the public status type deliberately does not carry:
   * an endpoint slug is an implementation detail and is not sent to a client, so it
   * is checked against the source instead. Two models sharing a slug is the bug
   * this exists for — it produces a picker where selecting Kling generates
   * Seedance, bills correctly, and looks entirely successful.
   */
  {
    const source = sourceOf("lib/providers/video-gen.ts");

    const endpoints = [...source.matchAll(/endpoint:\s*"([^"]+)"/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    must(
      endpoints.length > 1,
      "no fal.ai endpoints were found in video-gen.ts; the catalogue check below " +
        "would pass vacuously.",
    );
    must(
      new Set(endpoints).size === endpoints.length,
      `two fal.ai models share an endpoint: [${endpoints.join(", ")}]. Selecting one ` +
        `model would generate on another.`,
    );
    for (const endpoint of endpoints) {
      must(
        /^[a-z0-9][a-z0-9./-]*$/.test(endpoint) && !endpoint.includes(".."),
        `"${endpoint}" is not a plain fal.ai model slug.`,
      );
    }

    // A key belongs in `env()`, read at call time. A literal here would be
    // committed, and rotating it would mean a deploy.
    must(
      !/\b(?:fal|key)[-_]?[a-f0-9]{16,}/i.test(source),
      "video-gen.ts contains something shaped like a hardcoded credential.",
    );

    ok("each fal.ai model has its own endpoint slug, and none is hardcoded with a key");
    detail(`${endpoints.length} distinct endpoints; no credential literal in the module`);
  }

  // -----------------------------------------------------------------------
  // 6. plan entitlements gate AI video and the premium models
  // -----------------------------------------------------------------------
  /**
   * §19, verified against the real plan matrix rather than a fixture. The
   * entitlement is checked before the model is looked at, so a starter-plan
   * request is refused for the reason that is true of it.
   */
  {
    const { validateSelection } = await import("@/lib/video/generation-plan");
    // From `plans/enforce`, not the `plans` barrel: the barrel is the catalogue,
    // and the enforcement point is deliberately the module a worker can import.
    const { hasFeature } = await import("@/lib/plans/enforce");
    const { allVideoGenStatuses } = await import("@/lib/providers/video-gen");

    must(
      !hasFeature("starter", "aiVideoGeneration"),
      "the starter plan includes aiVideoGeneration; §19 gates AI video behind a paid plan.",
    );
    must(
      !hasFeature("studio", "premiumVideoModels"),
      "the studio plan includes premiumVideoModels; the premium tier must be distinct.",
    );
    must(
      hasFeature("scale", "aiVideoGeneration") && hasFeature("scale", "premiumVideoModels"),
      "the scale plan is missing an AI video entitlement.",
    );

    // Refused on the entitlement, before the model id is examined — so the error is
    // about the plan even when the named model does not exist.
    const starter = refusal(
      () => validateSelection({ mode: "AI_VIDEO", model: "does/not-exist", tier: "starter" }),
      "AI video on the starter plan",
    );
    must(
      starter.code === "feature_not_in_plan" && starter.status === 402,
      `AI video on starter was refused with ${starter.status} ${starter.code}; ` +
        `expected 402 feature_not_in_plan.`,
    );

    // Every premium model, refused for a plan that has AI video but not the premium
    // tier. Enumerated from the registry so a model added later is covered.
    const premium = allVideoGenStatuses().flatMap((s) => s.models.filter((m) => m.premium));
    for (const model of premium) {
      const error = refusal(
        () => validateSelection({ mode: "AI_VIDEO", model: model.id, tier: "studio" }),
        `premium model ${model.id} on the studio plan`,
      );
      must(
        error.code === "feature_not_in_plan" || error.status === 400,
        `${model.id} on studio was refused with ${error.status} ${error.code}; expected ` +
          `402 feature_not_in_plan, or 400 if this deployment has not configured it.`,
      );
    }

    ok("plan entitlements gate AI video and the premium models server-side");
    detail(
      `starter refused with 402 feature_not_in_plan before the model was read; ` +
        `${premium.length} premium models refused on the studio plan`,
    );
  }

  // -----------------------------------------------------------------------
  // 7. no secret is reachable from anything the client is sent
  // -----------------------------------------------------------------------
  /**
   * §10, §20 and §21 converge here: never send a provider API key to the browser.
   *
   * Rather than eyeball the shape, this compares the serialised payloads against
   * the *actual values* of every provider credential in this environment. A value
   * is read to be searched for and is never printed — a match would be reported as
   * the variable's name.
   */
  {
    const { env } = await import("@/lib/env");
    const { generationOptions } = await import("@/lib/video/generation-plan");
    const { allVideoGenStatuses, videoGenStatuses } = await import(
      "@/lib/providers/video-gen"
    );

    const SECRET_VARS = [
      "FAL_KEY",
      "GEMINI_API_KEY",
      "RUNWAY_API_KEY",
      "YOUTUBE_API_KEY",
      "GOOGLE_CLIENT_SECRET",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "ELEVENLABS_API_KEY",
      "PEXELS_API_KEY",
      "STRIPE_SECRET_KEY",
      "SESSION_SECRET",
      "ENCRYPTION_KEY",
    ] as const;

    const e = env() as unknown as Record<string, unknown>;
    /** Values long enough to be a credential rather than a flag. */
    const secrets = SECRET_VARS.flatMap((name) => {
      const value = e[name];
      return typeof value === "string" && value.length >= 8 ? [{ name, value }] : [];
    });

    const payloads: Array<[string, unknown]> = [
      ["generationOptions(starter)", generationOptions("starter")],
      ["generationOptions(studio)", generationOptions("studio")],
      ["generationOptions(scale)", generationOptions("scale")],
      ["videoGenStatuses()", videoGenStatuses()],
      ["allVideoGenStatuses()", allVideoGenStatuses()],
    ];

    /** Every property name appearing anywhere in a payload, at any depth. */
    function keysOf(value: unknown, into = new Set<string>()): Set<string> {
      if (Array.isArray(value)) {
        for (const item of value) keysOf(item, into);
      } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          into.add(key);
          keysOf(child, into);
        }
      }
      return into;
    }

    for (const [label, payload] of payloads) {
      const serialised = JSON.stringify(payload) ?? "";

      // The check that actually matters: the live value of every configured
      // credential, searched for in what the client would receive.
      for (const secret of secrets) {
        must(
          !serialised.includes(secret.value),
          `${label} contains the value of ${secret.name}. A provider credential must ` +
            `never reach the browser.`,
        );
      }

      /**
       * Credential-shaped *field names*, for a secret this script does not know to
       * look for. Deliberately scoped to keys rather than to the whole serialised
       * blob: `requiredEnvVars` carries variable names by design, and Veo's
       * `serviceNote` explains in prose which credential it needs and why the
       * existing OAuth client cannot be reused (§12) — both are documentation an
       * operator should see, and a substring scan would flag them as leaks.
       */
      for (const key of keysOf(payload)) {
        must(
          !/(^|_)(api)?_?(key|secret|token|password)($|_)|credential/i.test(key),
          `${label} has a field named "${key}", which is where a credential would live.`,
        );
      }

      // An assembled Authorization header is a value, not a name, and has no
      // legitimate reason to appear in a picker payload.
      must(
        !serialised.includes("Bearer "),
        `${label} contains an assembled Authorization header.`,
      );
    }

    ok("no provider credential is reachable from any client-bound payload");
    detail(
      `${payloads.length} payloads compared against the live values of ` +
        `${secrets.length} configured credentials (${SECRET_VARS.length} names checked); ` +
        `no value printed`,
    );
  }

  // -----------------------------------------------------------------------
  // 8. no provider module performs I/O at import time
  // -----------------------------------------------------------------------
  /**
   * Why this is checked statically rather than by observing a process: an import
   * that opened a socket would already have opened it by the time any assertion
   * ran. The registry is imported by the picker route, so a top-level `fetch`
   * there would turn rendering a page into a vendor API call.
   */
  {
    const registry = sourceOf("lib/providers/video-gen.ts");
    const plan = sourceOf("lib/video/generation-plan.ts");
    const format = sourceOf("lib/video/format.ts");

    // Module scope is everything before the first `function`/`const x = (` body —
    // approximated by checking that no I/O call appears at column 0.
    for (const [name, source] of [
      ["video-gen.ts", registry],
      ["generation-plan.ts", plan],
      ["format.ts", format],
    ] as const) {
      const topLevel = source
        .split("\n")
        .filter((line) => /^[a-zA-Z(]/.test(line) && !/^(export|import|type|interface|function|class|async|declare)\b/.test(line));
      for (const line of topLevel) {
        must(
          !/\b(fetch|require)\s*\(/.test(line),
          `${name} performs I/O at module scope: ${line.trim()}`,
        );
      }
    }

    // `format.ts` decides pixel dimensions and must stay a pure lookup — a network
    // call or an env read here would make the frame size deployment-dependent.
    must(
      !/\bfetch\s*\(/.test(format) && !/\benv\s*\(\s*\)/.test(format),
      "format.ts reads the environment or the network; frame geometry must be a pure constant.",
    );

    // The generation-plan layer must not hold provider-specific branches (§9).
    for (const vendor of ["fal.run", "fal.ai", "generativelanguage", "runwayml", "FAL_KEY", "GEMINI_API_KEY"]) {
      must(
        !plan.includes(vendor),
        `generation-plan.ts mentions ${vendor}; provider specifics belong behind the ` +
          `registry, not in the selection layer.`,
      );
    }

    ok("no provider module performs I/O at import time, and the plan layer is vendor-agnostic");
    detail(
      "format.ts is a pure lookup; generation-plan.ts names no vendor host or credential",
    );
  }

  // -----------------------------------------------------------------------
  // 9. the mock provider is unreachable in a production configuration
  // -----------------------------------------------------------------------
  /**
   * The quiet failure this prevents: a deployment that silently serves
   * placeholder stills as generated video. The mock exists for tests and local
   * work, so what must be true is that production cannot select it — checked here
   * with mock mode still off.
   */
  {
    const { usingMockProviders } = await import("@/lib/env");
    const { resolveModel, videoGenProviderIds } = await import(
      "@/lib/providers/video-gen"
    );

    must(
      !usingMockProviders(),
      "TALLY_USE_MOCK_PROVIDERS is still on in this step; the check would be vacuous.",
    );
    must(
      !videoGenProviderIds().includes("mock"),
      "the mock provider is enabled with mock mode off. Production could serve placeholders.",
    );

    const error = refusal(
      () => resolveModel("mock/placeholder"),
      "the mock model with mock providers off",
    );
    must(
      error.status === 400,
      `mock/placeholder was refused with ${error.status}; expected 400 (not available here).`,
    );

    // The allow-list is the server's, and an unknown id in it is dropped rather
    // than trusted — an operator typo must not create a provider. `seedance` is
    // the exception and is not a typo: it is the pre-catalogue name for fal.ai,
    // kept working so an existing deployment's environment still resolves.
    //
    // Restored afterwards rather than deleted: step 12 prints the audit table for
    // *this* deployment, and a step that left the variable unset would make that
    // table describe a configuration the operator does not have.
    const operatorList = process.env["VIDEO_GEN_PROVIDERS"];
    process.env["VIDEO_GEN_PROVIDERS"] = "seedance,fal,mock,nonexistent-vendor";
    resetEnvCache();
    const forced = (await import("@/lib/providers/video-gen")).videoGenProviderIds();
    must(
      !forced.includes("mock"),
      "`mock` in VIDEO_GEN_PROVIDERS enabled it with mock mode off; the mock must be " +
        "reachable only through TALLY_USE_MOCK_PROVIDERS.",
    );
    must(
      !(forced as string[]).includes("nonexistent-vendor"),
      "an unknown provider id in VIDEO_GEN_PROVIDERS was accepted.",
    );
    must(
      forced.length === 1 && forced[0] === "fal",
      `"seedance,fal" resolved to [${forced.join(", ")}]; the old and new spellings are ` +
        `one provider, and counting them twice would list every model twice in the picker.`,
    );
    if (operatorList === undefined) delete process.env["VIDEO_GEN_PROVIDERS"];
    else process.env["VIDEO_GEN_PROVIDERS"] = operatorList;
    resetEnvCache();

    ok("the mock provider cannot be selected in a production configuration");
    detail(
      "`mock` listed in VIDEO_GEN_PROVIDERS is still refused; an unknown vendor id is " +
        "dropped; the legacy `seedance` spelling resolves to fal.ai exactly once",
    );
  }

  // -----------------------------------------------------------------------
  // 10, 11. AI selection, format propagation, and clip provenance
  // -----------------------------------------------------------------------
  /**
   * From here on, mock providers are on.
   *
   * This is the one way to exercise the generation path end to end without
   * violating §24: the mock synthesises a PNG in-process, needs no credential and
   * contacts nothing. Everything above the provider — the entitlement check, the
   * model resolution, the format handling, the plan, the licence and provenance
   * fields — is the real code, which is exactly the layer where the defects that
   * matter live.
   */
  process.env["TALLY_USE_MOCK_PROVIDERS"] = "true";
  resetEnvCache();

  {
    const { generationOptions, generationPlanFor, validateSelection } = await import(
      "@/lib/video/generation-plan"
    );
    const { availableModels, resolveModel, videoGenStatuses } = await import(
      "@/lib/providers/video-gen"
    );
    const { formatSpec } = await import("@/lib/video/format");

    const models = availableModels();
    must(models.length > 0, "no video models are available with mock providers on.");

    const options = generationOptions("scale");
    must(options.aiAvailable, "AI video is unavailable on the scale plan with a provider ready.");
    must(
      options.models.length === models.length,
      "the picker payload and the registry disagree about how many models exist.",
    );
    must(
      generationOptions("starter").models.every((m) => m.locked),
      "a model is unlocked on the starter plan, which does not include AI video.",
    );

    // ---- 8. every model resolves, and only for the formats it supports -----
    let pairsChecked = 0;
    for (const model of models) {
      const resolved = resolveModel(model.id);
      must(
        resolved.model.id === model.id,
        `resolveModel("${model.id}") returned ${resolved.model.id}.`,
      );

      for (const format of ["landscape", "portrait", "square"] as const) {
        const supported = model.formats.includes(format);
        pairsChecked += 1;
        if (supported) {
          const plan = generationPlanFor({
            generationMode: "AI_VIDEO",
            generationModel: model.id,
            videoFormat: format,
          });
          const spec = formatSpec(format);
          // `format` is the name, `spec` the geometry the render stage targets.
          must(
            plan.format === format &&
              plan.spec.width === spec.width &&
              plan.spec.height === spec.height &&
              plan.spec.fps === spec.fps,
            `the plan for ${model.id} in ${format} carries the wrong geometry.`,
          );
          must(
            plan.model?.id === model.id && plan.mode === "AI_VIDEO",
            `the plan for ${model.id} lost the model or the mode.`,
          );
        } else {
          // §16: a model that cannot produce a frame shape must refuse it rather
          // than silently generate the wrong one and leave it to be letterboxed.
          const error = refusal(
            () =>
              generationPlanFor({
                generationMode: "AI_VIDEO",
                generationModel: model.id,
                videoFormat: format,
              }),
            `${model.id} in the unsupported ${format} format`,
          );
          must(
            error.status === 400,
            `${model.id} + ${format} was refused with ${error.status}; expected 400.`,
          );
        }
      }
    }

    // AI without a model is a 400, not a silent fallback to stock — a user who
    // chose AI video and got stock footage was not told.
    const noModel = refusal(
      () => validateSelection({ mode: "AI_VIDEO", tier: "scale" }),
      "AI video with no model chosen",
    );
    must(noModel.status === 400, `AI video with no model gave ${noModel.status}; expected 400.`);

    ok("AI selection resolves to a usable plan, and the format reaches the model");
    detail(
      `${models.length} models resolved; ${pairsChecked} model/format pairs checked; ` +
        `unsupported pairings and a missing model both refused with 400`,
    );

    // ---- 9. provenance and licence on a generated clip ---------------------
    const { generateClip } = await import("@/lib/providers/video-gen");
    const target = models[0];
    if (!target) fail("no model to generate with.");

    const clip = await generateClip(
      {
        prompt: "A verification placeholder frame",
        modelId: target.id,
        format: "portrait",
        durationMs: 4_000,
        sceneIndex: 0,
      },
      {
        usage: {
          // No userId and no projectId: this script writes nothing to Postgres.
          traceId: "verify-video-providers",
        },
      },
    );

    must(clip.bytes.length > 0, "the generated clip is empty.");
    must(clip.modelId === target.id, "the clip does not record which model produced it.");
    must(clip.license.length > 0, "the clip carries no licence statement (§29).");
    must(
      clip.mimeType.startsWith("image/") || clip.mimeType.startsWith("video/"),
      `the clip reports mime type "${clip.mimeType}", which is neither image nor video.`,
    );
    must(
      clip.matchedOn.length > 0,
      "the clip does not record the prompt that produced it, so provenance is lost.",
    );
    // §16, on the bytes rather than on the request: portrait is taller than wide.
    if (clip.width !== null && clip.height !== null) {
      must(
        clip.height > clip.width,
        `a portrait request produced ${clip.width}x${clip.height}.`,
      );
    }
    // §22: generated, not fetched from somewhere.
    must(
      !/youtube|youtu\.be/i.test(clip.matchedOn),
      "the clip provenance references YouTube; generated content must be independent.",
    );

    ok("a generated clip carries its model, licence, prompt and frame geometry");
    detail(
      `${clip.provider}/${clip.modelId} produced ${clip.bytes.length} bytes ` +
        `(${clip.mimeType}, ${clip.width ?? "?"}x${clip.height ?? "?"}); ` +
        `licence: "${clip.license}"`,
    );

    // Mock mode is the only reason a provider is ready in this step; say so, so a
    // reader does not take it as evidence about a real credential.
    const mocked = videoGenStatuses().filter((s) => s.state === "mock");
    must(
      mocked.length > 0,
      "no provider reports the `mock` state with mock providers on; the clip above " +
        "may have come from a real API.",
    );
    detail(
      `${mocked.length} provider(s) in the mock state: ${mocked
        .map((s) => s.provider)
        .join(", ")} — no external API was contacted`,
    );
  }

  // -----------------------------------------------------------------------
  // 12. the §20 provider audit table, from the real environment
  // -----------------------------------------------------------------------
  /**
   * Printed from the actual configuration rather than maintained by hand, so it
   * cannot drift. Names and states only — §20 forbids printing a value, and this
   * script never reads one for display.
   */
  process.env["TALLY_USE_MOCK_PROVIDERS"] = "false";
  resetEnvCache();

  {
    const { allVideoGenStatuses } = await import("@/lib/providers/video-gen");
    const { capabilityStatus } = await import("@/lib/providers/config");
    const { isYouTubePublicReadConfigured, youtubePublicReadMissingEnvVars } =
      await import("@/lib/providers/youtube");

    step += 1;
    console.log(`  ${step}. OK  provider audit (§20), from this environment\n`);

    const rows: Array<[string, string, string, string]> = [];

    // The link-mode read path, which is what §4 and §5 depend on.
    rows.push([
      "youtube (public read)",
      "Source analysis + trend research",
      isYouTubePublicReadConfigured() ? "CONFIGURED" : "NOT_CONFIGURED",
      youtubePublicReadMissingEnvVars().join(", ") || "YOUTUBE_API_KEY",
    ]);

    // Stock footage, unchanged from Phase 6 and required in STOCK mode.
    const visuals = capabilityStatus("visuals");
    rows.push([
      "stock visuals",
      "STOCK generation mode",
      visuals.state === "ready"
        ? "CONFIGURED"
        : visuals.state === "mock"
          ? "MOCK"
          : "NOT_CONFIGURED",
      visuals.missingEnvVars.join(", ") || "—",
    ]);

    for (const status of allVideoGenStatuses()) {
      rows.push([
        `${status.provider} (video gen)`,
        "AI_VIDEO generation mode",
        status.state === "ready"
          ? "CONFIGURED"
          : status.state === "disabled"
            ? "NOT_ENABLED"
            : status.state === "mock"
              ? "MOCK"
              : "NOT_CONFIGURED",
        status.missingEnvVars.join(", ") || status.requiredEnvVars.join(", ") || "—",
      ]);
    }

    const w = [24, 34, 16] as const;
    console.log(
      `        ${"Provider".padEnd(w[0])}${"Purpose".padEnd(w[1])}` +
        `${"State".padEnd(w[2])}Env vars (names only)`,
    );
    console.log(`        ${"-".repeat(w[0] + w[1] + w[2] + 24)}`);
    for (const [provider, purpose, state, vars] of rows) {
      console.log(
        `        ${provider.padEnd(w[0])}${purpose.padEnd(w[1])}${state.padEnd(w[2])}${vars}`,
      );
    }

    const configured = rows.filter(([, , state]) => state === "CONFIGURED").length;
    console.log("");
    detail(
      `${rows.length} providers audited, ${configured} CONFIGURED. ` +
        `No value was read or printed — §20 asks for names and states only.`,
    );
    for (const [provider, , state, vars] of rows) {
      if (state === "NOT_CONFIGURED") {
        detail(
          `${provider} is NOT_CONFIGURED and is reported as unavailable rather than ` +
            `attempted. Set ${vars} to enable it.`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 13. no destructive or billable external action
  // -----------------------------------------------------------------------
  /**
   * Asserted about this script's own source, in the same spirit as
   * `verify-hardening.ts`'s final step: the claim "no charge, no upload, no
   * generation call" should be mechanically checkable rather than a promise in a
   * comment that a later edit could quietly falsify.
   */
  {
    const self = readFileSync(
      join(process.cwd(), "scripts", "verify-video-providers.ts"),
      "utf8",
    );
    // Ignore the docblock and the comments, where these words appear by necessity.
    const code = self
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return t.length > 0 && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

    /**
     * Each pattern is anchored to a *call* or an *import*, never to a bare word.
     *
     * Deliberately, and not just to avoid self-matching: this file names
     * `STRIPE_SECRET_KEY` in the credential list of step 5 precisely so it can
     * check that no Stripe key leaks, and a scan that flagged the name would
     * punish the safety check for existing.
     */
    const forbidden: Array<[RegExp, string]> = [
      [/\bfetch\s*\(/, "a direct network call"],
      [/\bhttps?\s*\.\s*request\s*\(/, "a raw HTTP request"],
      [/from\s+["'](axios|node-fetch|got|undici)["']/, "an HTTP client import"],
      [/from\s+["']stripe["']|\bstripe\s*[.(]/i, "a Stripe call"],
      [
        /(uploadVideo|publishProject|executePublish|startPublish)\s*\(/,
        "a YouTube upload or publication",
      ],
      [/db\s*\.\s*(insert|update|delete)\s*\(/, "a database write"],
      [/\b(enqueue|getQueue)\s*\(/, "a queue write"],
      [/\b(execFile|execFileSync|execSync|spawnSync|spawn|exec)\s*\(/, "a child process"],
      [/\b(writeFile|writeFileSync|appendFileSync|unlinkSync|rmSync)\s*\(/, "a filesystem write"],
    ];
    for (const [pattern, what] of forbidden) {
      must(
        !pattern.test(code),
        `this script performs ${what} (matched ${String(pattern)}), which §24 forbids.`,
      );
    }

    ok("this script performs no billable, destructive or external action");
    detail(
      "no network call, no Stripe call, no upload, no publication, no database or " +
        "queue write, no child process — asserted against this file's own source",
    );
  }

  console.log(
    `\n${step}/${TOTAL_STEPS} checks passed — stock footage is selectable on every plan ` +
      `with nothing configured, AI selection resolves mode/model/format to a usable plan, ` +
      `unconfigured providers report NOT_CONFIGURED and cannot be reached, invented ` +
      `provider and model names are refused with 400, plan entitlements gate AI video ` +
      `and the premium models server-side, no provider credential appears in any ` +
      `client-bound payload, no provider module performs I/O at import, the mock ` +
      `provider is unreachable in a production configuration, and a generated clip ` +
      `carries its model, licence and provenance.` +
      `\nNot verified by design: whether any real generation credential works. §24 ` +
      `forbids a live video-generation request, so provider reachability is not a ` +
      `question this script can answer — only whether the layer is honest about it.\n`,
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      `\n  FAIL at step ${step + 1}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  },
);
