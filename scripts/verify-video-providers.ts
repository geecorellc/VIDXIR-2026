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
 * The fifteen invariants, in execution order. Steps 1-10 run with mock providers
 * *off*, which is the honest reading of a production deployment that has
 * configured nothing; steps 11-13 turn them on, because that is the only way to
 * exercise the generation path without billing anyone:
 *
 *    1. stock is selectable on every plan, with no AI provider configured
 *    2. unconfigured providers report NOT_CONFIGURED and cannot be reached
 *    3. unknown providers, invented model ids and invented modes are refused
 *    4. the four branded Vidxir AI models exist, each on one vendor and one credential
 *    5. no vendor name reaches a customer-facing label, and no client string
 *       reaches a vendor URL
 *    6. the capability matrix is declared rather than assumed, and an unsupported
 *       resolution is refused
 *    7. plan entitlements gate AI video and the premium models
 *    8. no secret is reachable from anything the client is sent
 *    9. no provider module performs I/O at import, and the plan layer is
 *       vendor-agnostic
 *   10. the mock provider is unreachable in a production configuration
 *   11. AI selection resolves mode/model/format, and an impossible pairing is
 *       refused
 *   12. a generated clip carries its model, licence, prompt and geometry (§22, §29)
 *   13. a generated image carries the same provenance, for continuity references
 *   14. the §20 provider audit table, from the real environment
 *   15. no destructive or billable external action — asserted about this script
 *
 * Steps 4-6 are the branded model layer's own invariants (Phase 12 §2, §3, §4,
 * §16), and they are the ones that cannot be checked any other way. Whether the
 * cinematic model actually renders is the vendor's business; whether *selecting*
 * Tal 3.0 reaches that vendor rather than another is Vidxir AI's, and a mistake there
 * generates successfully, bills correctly and produces the wrong model's output
 * with nothing to indicate it. §3's rule is checked in the same place because it
 * has the same shape: a leak is invisible in review and obvious to a scan.
 *
 * ## What this script does NOT do
 *
 * §24's prohibitions, held to literally. It makes **no** call to any generation
 * API — not the four vendors behind the branded models, not Runway; **no** YouTube
 * read, upload or publication; **no** Stripe charge, checkout, subscription or
 * portal session. It writes nothing to Postgres, enqueues nothing, and touches no
 * production data —
 * every check below is a pure function of the environment and the module graph.
 * It prints no credential value: §20 asks for CONFIGURED / NOT_CONFIGURED and the
 * variable *names*, and that is the most it knows how to say.
 *
 * The one clip and the one image it generates come from the `mock` provider, which
 * synthesises a PNG in-process and has no `requiredEnvVars` — they exist so
 * invariants 12 and 13 are proven against real `generateClip` and `generateImage`
 * calls rather than around them.
 *
 * `resetEnvCache()` between the two halves is what makes each answer about the
 * configuration it claims to be about: without it, step 1's "nothing configured"
 * claim and step 11's "a provider is ready" claim would be read from the same
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

const TOTAL_STEPS = 15;
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
  process.env["VIDXIR_USE_MOCK_PROVIDERS"] = "false";
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
  // 4. the four branded models exist, each on one vendor and one credential
  // -----------------------------------------------------------------------
  /**
   * §2, checked against the registry rather than against the UI, because the UI is
   * where the names are *shown* and the registry is where they are *decided*. The
   * failure this exists for is a rename that reaches the picker and not the router:
   * a model labelled "Tal 3.0" that resolves to a different vendor's endpoint
   * generates successfully, bills correctly, and produces the wrong output with
   * nothing to indicate it.
   *
   * Read from `allVideoGenStatuses()`, so the invariant holds whether or not a
   * credential is set: an operator with nothing configured still gets it checked.
   */
  {
    const { allVideoGenStatuses } = await import("@/lib/providers/video-gen");
    const { videoFormats } = await import("@/lib/video/format");

    /** §2's table, verbatim: the customer-facing name and the variable that buys it. */
    const BRANDED: ReadonlyArray<{
      id: string;
      label: string;
      envVar: string;
      premium: boolean;
    }> = [
      { id: "tal/1.0", label: "Tal 1.0 — Fast Model", envVar: "DASHSCOPE_API_KEY", premium: false },
      { id: "tal/2.0", label: "Tal 2.0 — Creators Model", envVar: "MINIMAX_API_KEY", premium: false },
      { id: "tal/3.0", label: "Tal 3.0 — Cinematic Model", envVar: "SEEDANCE_API_KEY", premium: false },
      { id: "tal/3.1", label: "Tal 3.1 — Ultra Model", envVar: "GEMINI_API_KEY", premium: true },
    ];

    const statuses = allVideoGenStatuses();
    const known = new Set(videoFormats().map((s) => s.format));
    const usedProviders = new Set<string>();

    for (const branded of BRANDED) {
      const owners = statuses.filter((s) => s.models.some((m) => m.id === branded.id));
      must(
        owners.length === 1,
        `${branded.id} is declared by ${owners.length} providers; each branded model ` +
          `belongs to exactly one vendor, or the picker would list it twice and the ` +
          `router would have to guess which one to submit to.`,
      );
      const owner = owners[0];
      if (!owner) fail(`${branded.id} is missing from the registry; §2 requires all four.`);

      const model = owner.models.find((m) => m.id === branded.id);
      if (!model) fail(`${branded.id} vanished between the filter and the lookup.`);

      must(
        model.label === branded.label,
        `${branded.id} is labelled "${model.label}"; §2 names it "${branded.label}", and ` +
          `the label is what a customer reads.`,
      );
      must(
        model.premium === branded.premium,
        `${branded.id} reports premium=${model.premium}; §3 makes only the Ultra model ` +
          `premium, and this decides which plan may select it.`,
      );
      must(
        owner.requiredEnvVars.length === 1 && owner.requiredEnvVars[0] === branded.envVar,
        `${branded.id}'s provider requires [${owner.requiredEnvVars.join(", ")}]; §2 maps ` +
          `it to ${branded.envVar} alone. More than one credential means the model cannot ` +
          `be enabled without an unrelated environment change.`,
      );
      must(
        !usedProviders.has(owner.provider),
        `${branded.id} shares a provider with an earlier branded model; the four tiers are ` +
          `four distinct backends, and collapsing two would make one silently unreachable.`,
      );
      usedProviders.add(owner.provider);

      must(
        model.description.trim().length > 0 && model.bestFor.trim().length > 0,
        `${branded.id} has no description or "best for" line; §3 specifies both, and the ` +
          `picker would render a blank row.`,
      );
      must(
        model.formats.length > 0 && model.formats.every((f) => known.has(f)),
        `${branded.id} declares formats [${model.formats.join(", ")}], which is empty or ` +
          `names a frame format.ts does not define.`,
      );
    }

    // Nothing else may be offered. A leftover aggregator entry is exactly what §14
    // forbids — "do not leave dead model options in the UI".
    const unexpected = statuses
      .flatMap((s) => s.models.filter((m) => !m.legacy))
      .map((m) => m.id)
      .filter((id) => !BRANDED.some((b) => b.id === id) && id !== "mock/placeholder");
    must(
      unexpected.length === 0,
      `the registry offers [${unexpected.join(", ")}] alongside the branded models. §14 ` +
        `requires the retired catalogue to be unselectable, not merely deprioritised.`,
    );

    ok("the four branded models exist, each on one vendor and one credential");
    detail(
      `${BRANDED.map((b) => b.label).join(", ")} — four distinct backends, one variable ` +
        `each; no other selectable model in the registry`,
    );
  }

  // -----------------------------------------------------------------------
  // 5. no vendor name reaches a label, and no client string reaches a URL
  // -----------------------------------------------------------------------
  /**
   * §3 and §14's rule, and §10's, in one place because they are the same static
   * question asked of two things: what the customer is *told*, and what the vendor
   * is *sent*.
   *
   * The name half is checked against the payload a client receives rather than
   * against the module source, because the source has to name the vendors — every
   * adapter documents the API it submits to, and a scan of the module would either
   * fail on its own docblock or be relaxed until it tested nothing. The URL half is
   * checked against the source, because an assembled URL is never returned to
   * anyone and so cannot be inspected any other way.
   *
   * The patterns are word-anchored on purpose. "fal" is a substring of ordinary
   * English — "fall", "default", "final" — and an unanchored scan would flag
   * innocent copy, which is how an assertion like this ends up deleted.
   */
  {
    const { generationOptions } = await import("@/lib/video/generation-plan");
    const { publicModels } = await import("@/lib/providers/video-gen");
    const source = sourceOf("lib/providers/video-gen.ts");

    const VENDORS: ReadonlyArray<RegExp> = [
      /\bfal\b/i,
      /fal\.ai/i,
      /\bseedance\b/i,
      /\bminimax\b/i,
      /\bhailuo\b/i,
      /\bkling\b/i,
      /\bwan\b/i,
      /\bveo\b/i,
      /\bgemini\b/i,
      /\bimagen\b/i,
      /\bdashscope\b/i,
      /\balibaba\b/i,
      /\bbytedance\b/i,
      /\bvolcengine\b/i,
      /\bark\b/i,
      /\bqwen\b/i,
    ];

    for (const [label, payload] of [
      ["generationOptions(scale)", generationOptions("scale")],
      ["generationOptions(studio)", generationOptions("studio")],
      ["generationOptions(starter)", generationOptions("starter")],
      ["publicModels()", publicModels()],
    ] as const) {
      const serialised = JSON.stringify(payload) ?? "";
      for (const vendor of VENDORS) {
        must(
          !vendor.test(serialised),
          `${label} matches ${String(vendor)}. §3 forbids the underlying provider name in ` +
            `a customer-facing payload; the operator surfaces carry it instead.`,
        );
      }
    }

    // The field itself, not just its value: a type that cannot hold the vendor is
    // the enforceable version of "do not expose it".
    for (const model of publicModels()) {
      must(
        !Object.hasOwn(model, "provider"),
        `${model.id} carries a "provider" field in the public payload. §3 is enforced by ` +
          `absence — a UI cannot render what it was never sent.`,
      );
    }

    /**
     * Every URL the adapters build. The `${...}` segments are the interesting part:
     * a client-supplied string interpolated into a vendor path is §10's whole
     * concern, and the only interpolations that may appear are a configured base
     * URL, an env-selected model name, or a task id the vendor itself just issued —
     * encoded.
     *
     * `data:` URIs are separated out rather than scanned as paths. A data URI is a
     * request *payload* — the continuity reference stills of §6 travel as one — and it
     * has no host and no path segments, so the rules below do not describe it: a media
     * type there cannot traverse a directory or redirect a request. They get their own,
     * stricter check immediately after, because "not a path" is not the same as
     * "unconstrained".
     */
    const allUrls = [...source.matchAll(/url:\s*(?:`([^`]+)`|"([^"]+)")/g)].flatMap((m) =>
      [m[1] ?? m[2]].filter((value): value is string => typeof value === "string"),
    );
    const dataUris = allUrls.filter((url) => url.startsWith("data:"));
    const urls = allUrls.filter((url) => !url.startsWith("data:"));
    must(
      urls.length >= 8,
      `only ${urls.length} request URLs were found in video-gen.ts; five adapters each ` +
        `submit and poll, so a much smaller number means this scan is reading the wrong ` +
        `thing and passing vacuously.`,
    );

    /**
     * A data URI's media type must come from a fixed allowlist, never from the asset row.
     *
     * `assets.mimeType` is attacker-influenceable in principle — it is stored data — and
     * a media type spliced into a payload the vendor parses is the injection this rule
     * exists to prevent. The adapter narrows it against `SEEDANCE_REFERENCE_MIME_TYPES`
     * before building the URI, so what is asserted here is that the allowlist exists,
     * that it is actually applied, and that the URI is built from the narrowed local
     * rather than straight from the reference.
     */
    for (const uri of dataUris) {
      const interpolations = [...uri.matchAll(/\$\{([^}]+)\}/g)].flatMap((m) =>
        m[1] ? [m[1].trim()] : [],
      );
      for (const expression of interpolations) {
        must(
          expression === "mime" || expression.endsWith('.toString("base64")'),
          `the data URI "${uri}" interpolates \`${expression}\`. Only an allowlisted ` +
            `media type and base64-encoded bytes may appear in a payload the vendor ` +
            `parses.`,
        );
      }
      must(
        !/\$\{[^}]*\.mimeType[^}]*\}/.test(uri),
        `the data URI "${uri}" splices a stored mimeType straight in; it must be ` +
          `narrowed against the allowlist first.`,
      );
    }
    must(
      /SEEDANCE_REFERENCE_MIME_TYPES\s*=\s*\[/.test(source) &&
        /SEEDANCE_REFERENCE_MIME_TYPES[\s\S]{0,200}?\.includes\(/.test(source),
      `video-gen.ts builds a data URI but does not narrow the media type against a ` +
        `declared allowlist. §10: what reaches a vendor payload must be chosen here, ` +
        `not echoed from a stored row.`,
    );

    /**
     * Locals that are provably a single read of `env()`, resolved rather than trusted.
     *
     * An adapter that reads its model id once and uses it in both the request body and
     * the path — as the Veo and Seedance ones now do, because the reference-image
     * capability is version-gated and has to be tested before the body is built — puts a
     * local in the path where `env().X` used to be inline. That is the same value, but
     * the scan cannot know it without looking.
     *
     * So a name qualifies only when *every* binding of it in the file is a
     * `const <name> = env().<VAR>;` and it is never assigned anywhere else. The name is
     * deliberately allowed to be bound more than once — two adapters each read their own
     * model id into a local of the same name, and both are configuration — but a single
     * `let`, a re-assignment, or one binding from any other initialiser disqualifies it
     * and the check below rejects the URL. That keeps the rule enforcing what it always
     * enforced: a path segment comes from configuration, not from a caller.
     */
    const envLocals = new Set(
      [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*env\(\)\.[A-Z0-9_]+\s*;/g)]
        .flatMap((m) => (m[1] ? [m[1]] : []))
        .filter((name) => {
          const envBindings = [
            ...source.matchAll(
              new RegExp(`\\bconst\\s+${name}\\s*=\\s*env\\(\\)\\.[A-Z0-9_]+\\s*;`, "g"),
            ),
          ].length;
          const allBindings = [
            ...source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, "g")),
          ].length;
          const assignments = [
            ...source.matchAll(new RegExp(`\\b${name}\\s*=[^=]`, "g")),
          ].length;
          // Every declaration is an env read, and nothing assigns to it afterwards.
          return allBindings === envBindings && assignments === envBindings;
        }),
    );

    for (const url of urls) {
      must(!url.includes(".."), `"${url}" contains a path traversal segment.`);
      const interpolations = [...url.matchAll(/\$\{([^}]+)\}/g)].flatMap((m) =>
        m[1] ? [m[1].trim()] : [],
      );
      for (const expression of interpolations) {
        must(
          expression === "base" ||
            expression === "operationName" ||
            /^[A-Z_]+_API$/.test(expression) ||
            /^env\(\)\.[A-Z0-9_]+$/.test(expression) ||
            envLocals.has(expression) ||
            expression.startsWith("encodeURIComponent("),
          `"${url}" interpolates \`${expression}\`, which is neither a configured base, an ` +
            `env-selected model, a vendor-issued operation name, nor URI-encoded. A client ` +
            `string must not become a path segment.`,
        );
      }
    }

    // A key belongs in `env()`, read at call time. A literal here would be
    // committed, and rotating it would mean a deploy.
    must(
      !/\b(?:sk|key|token)[-_]?[a-zA-Z0-9]{24,}/.test(source),
      "video-gen.ts contains something shaped like a hardcoded credential.",
    );
    // The retired route, asserted gone rather than assumed (§14).
    for (const dead of ["queue.fal.run", "fal.media", "FAL_KEY", "fal-ai/"]) {
      must(
        !source.includes(dead),
        `video-gen.ts still references "${dead}"; §14 removes the aggregator video route, ` +
          `and a reachable remnant is one careless edit from being selectable again.`,
      );
    }

    ok("no vendor name reaches a customer-facing label, and no client string reaches a URL");
    detail(
      `${VENDORS.length} vendor patterns absent from 4 client-bound payloads; ` +
        `${urls.length} request URLs interpolate only configured or encoded values; the ` +
        `retired aggregator route is gone from the module`,
    );
  }

  // -----------------------------------------------------------------------
  // 6. capabilities are declared, and an unsupported resolution is refused
  // -----------------------------------------------------------------------
  /**
   * §4, §5 and §16. The rule §4 states — "do not show an option that the underlying
   * model does not actually support" — is only half a guarantee if the UI is the
   * thing enforcing it, so what is checked here is the other half: the resolver
   * refuses what the matrix does not declare, and the matrix does not declare
   * anything the adapter cannot do.
   *
   * `imageGeneration` is the sharpest case (§5, §18.5). A model that claimed it and
   * had no image method would fail at the vendor after a credit was reserved, which
   * is why the registry asserts the pairing at import; this step reads the matrix
   * back out, so the assertion is proven load-bearing rather than assumed.
   */
  {
    const {
      allVideoGenStatuses,
      assertImageQuality,
      assertQuality,
      imageModels,
      publicModels,
    } = await import("@/lib/providers/video-gen");
    const { VIDEO_QUALITIES } = await import("@/lib/video/quality");
    const { videoFormats } = await import("@/lib/video/format");

    const every = allVideoGenStatuses().flatMap((s) => s.models);
    const known = new Set(videoFormats().map((f) => f.format));
    let refused = 0;

    for (const model of every) {
      const caps = model.capabilities;

      must(
        caps.qualities.length > 0,
        `${model.id} declares no resolutions, so nothing could ever be generated with it.`,
      );
      must(
        caps.durations.length > 0 && caps.durations.every((d) => d > 0),
        `${model.id} declares durations [${caps.durations.join(", ")}]; a clip length of ` +
          `zero or less is not a length.`,
      );
      must(
        Math.max(...caps.durations) === model.maxClipSeconds,
        `${model.id} advertises maxClipSeconds=${model.maxClipSeconds} but its longest ` +
          `declared duration is ${Math.max(...caps.durations)}. §4 shows the duration to ` +
          `the user and §9 prices from it, so the two must be one number.`,
      );
      must(
        model.formats.every((f) => known.has(f)),
        `${model.id} declares a frame format.ts does not define.`,
      );
      must(
        caps.textToVideo || caps.imageGeneration,
        `${model.id} generates neither video from text nor images, so it cannot be ` +
          `selected for anything.`,
      );
      // §5's resolver requirement, read off the matrix: the two describe one
      // capability, and disagreeing means one of them is fabricated (§19).
      must(
        caps.imageGeneration === caps.imageQualities.length > 0,
        `${model.id} says imageGeneration=${caps.imageGeneration} with ` +
          `${caps.imageQualities.length} image resolutions.`,
      );

      /**
       * Every quality Vidxir AI knows, asked of every model. A declared one resolves to
       * itself; an undeclared one is refused rather than snapped to the nearest,
       * because §12 quotes a credit price from the resolution and snapping is only
       * ever correct for an *absent* choice.
       */
      for (const quality of VIDEO_QUALITIES) {
        if (caps.qualities.includes(quality)) {
          must(
            assertQuality(model, quality) === quality,
            `${model.id} declares ${quality} but assertQuality returned something else.`,
          );
        } else {
          refusal(
            () => assertQuality(model, quality),
            `${quality} on ${model.id}, which does not declare it`,
          );
          refused += 1;
        }
      }
      must(
        caps.qualities.includes(assertQuality(model, null)),
        `${model.id}'s default resolution is not one it declares, so an absent choice ` +
          `resolves to something it cannot generate.`,
      );

      for (const quality of VIDEO_QUALITIES) {
        if (caps.imageQualities.includes(quality)) continue;
        refusal(
          () => assertImageQuality(model, quality),
          `image quality ${quality} on ${model.id}`,
        );
        refused += 1;
      }
    }

    // §5: image generation is a capability every branded model has, not a separate
    // system bolted beside them, so the same registry has to answer both questions
    // and has to answer yes for all of them.
    const imaging = imageModels();
    for (const model of imaging) {
      must(
        model.capabilities.imageGeneration,
        `${model.id} appears in imageModels() without declaring imageGeneration.`,
      );
      must(
        publicModels().some((p) => p.id === model.id),
        `${model.id} offers image generation but is absent from the public catalogue.`,
      );
    }

    /**
     * Every offered model, not a subset.
     *
     * §5 calls image generation first-class across the branded models, and the
     * failure this guards is specific: if one model cannot make a still, a project
     * on it either gets no continuity references or gets them from a *different*
     * model, whose look then disagrees with every scene the project actually
     * renders. Scoped to the offered catalogue so a deployment that enables one
     * provider still passes, and so the retired Runway model — which correctly
     * generates no stills — is not counted against it.
     */
    for (const model of publicModels()) {
      must(
        model.capabilities.imageGeneration,
        `${model.id} is offered for AI video but generates no stills, so a project ` +
          `on it must borrow continuity references from another model (§5).`,
      );
    }

    ok("capabilities are declared per model, and an undeclared resolution is refused");
    detail(
      `${every.length} models checked; ${refused} undeclared resolution requests refused; ` +
        `imageGeneration and imageQualities agree on every model; ${imaging.length} ` +
        `model(s) offer image generation on this configuration`,
    );
  }

  // -----------------------------------------------------------------------
  // 7. plan entitlements gate AI video and the premium models
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
  // 8. no secret is reachable from anything the client is sent
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
  // 9. no provider module performs I/O at import time
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
  // 10. the mock provider is unreachable in a production configuration
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
      "VIDXIR_USE_MOCK_PROVIDERS is still on in this step; the check would be vacuous.",
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

    /**
     * The allow-list is the server's, and an unknown id in it is dropped rather
     * than trusted — an operator typo must not create a provider.
     *
     * `ark` and `dashscope` are not typos: they are the vendors' own names for two
     * of the backends, kept as aliases so an operator who writes what the vendor
     * console calls it gets the provider they meant. `fal` is the interesting entry
     * — §14 retires that route, so the id must resolve to *nothing* rather than to
     * a surviving provider, and this is where "do not leave the old route
     * accidentally selectable" stops being a claim.
     *
     * Restored afterwards rather than deleted: step 14 prints the audit table for
     * *this* deployment, and a step that left the variable unset would make that
     * table describe a configuration the operator does not have.
     */
    const operatorList = process.env["VIDEO_GEN_PROVIDERS"];
    process.env["VIDEO_GEN_PROVIDERS"] = "ark,dashscope,fal,mock,nonexistent-vendor";
    resetEnvCache();
    const forced = (await import("@/lib/providers/video-gen")).videoGenProviderIds();
    must(
      !forced.includes("mock"),
      "`mock` in VIDEO_GEN_PROVIDERS enabled it with mock mode off; the mock must be " +
        "reachable only through VIDXIR_USE_MOCK_PROVIDERS.",
    );
    for (const dropped of ["nonexistent-vendor", "fal"]) {
      must(
        !(forced as string[]).includes(dropped),
        `"${dropped}" in VIDEO_GEN_PROVIDERS was accepted as a provider id.`,
      );
    }
    must(
      forced.length === 2 &&
        forced.includes("seedance") &&
        forced.includes("qwen"),
      `"ark,dashscope,fal" resolved to [${forced.join(", ")}]; the two vendor spellings are ` +
        `aliases of two branded backends, and the retired aggregator id resolves to none.`,
    );
    if (operatorList === undefined) delete process.env["VIDEO_GEN_PROVIDERS"];
    else process.env["VIDEO_GEN_PROVIDERS"] = operatorList;
    resetEnvCache();

    ok("the mock provider cannot be selected in a production configuration");
    detail(
      "`mock` listed in VIDEO_GEN_PROVIDERS is still refused; an unknown vendor id is " +
        "dropped; a vendor's own spelling resolves to its branded backend; the retired " +
        "aggregator id enables nothing (§14)",
    );
  }

  // -----------------------------------------------------------------------
  // 11, 12, 13. AI selection, clip provenance and image provenance
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
  process.env["VIDXIR_USE_MOCK_PROVIDERS"] = "true";
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

    // ---- 11. every model resolves, and only for the formats it supports ----
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

    // ---- 12. provenance and licence on a generated clip --------------------
    const { generateClip } = await import("@/lib/providers/video-gen");
    const target = models[0];
    if (!target) fail("no model to generate with.");

    const clip = await generateClip(
      {
        prompt: "A verification placeholder frame",
        modelId: target.id,
        format: "portrait",
        quality: null,
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

    // ---- 13. the same provenance on a generated image ----------------------
    /**
     * §5, exercised rather than merely declared. Continuity references are the
     * reason image generation exists (§6), and a reference image with no record of
     * which model made it is unusable for exactly that purpose: the continuity
     * checker has to know whether two frames came from the same model before it can
     * read a difference between them as a continuity error.
     *
     * `purpose` is carried through and asserted because it is what distinguishes a
     * character reference from a thumbnail in storage, and §5 lists both.
     */
    const { generateImage, imageModels } = await import("@/lib/providers/video-gen");
    const imageTarget = imageModels()[0];
    if (!imageTarget) {
      fail(
        "no model offers image generation with mock providers on; §5 requires the " +
          "capability to exist somewhere in the registry.",
      );
    }

    const image = await generateImage(
      {
        prompt: "A verification placeholder character reference",
        modelId: imageTarget.id,
        format: "portrait",
        quality: null,
        purpose: "character",
        index: 0,
      },
      { usage: { traceId: "verify-video-providers" } },
    );

    must(image.bytes.length > 0, "the generated image is empty.");
    must(
      image.modelId === imageTarget.id,
      "the image does not record which model produced it, so a continuity reference " +
        "cannot be compared against the frames it was meant to constrain.",
    );
    must(
      image.purpose === "character",
      `the image reports purpose "${image.purpose}"; the requested purpose decides where ` +
        `it is stored and what it may be reused for (§5).`,
    );
    must(
      image.mimeType.startsWith("image/"),
      `the image reports mime type "${image.mimeType}", which is not an image.`,
    );
    must(image.license.length > 0, "the image carries no licence statement (§29).");
    must(
      image.matchedOn.length > 0,
      "the image does not record the prompt that produced it, so provenance is lost.",
    );
    if (image.width !== null && image.height !== null) {
      must(
        image.height > image.width,
        `a portrait image request produced ${image.width}x${image.height}.`,
      );
    }

    ok("a generated image carries its model, purpose, licence and prompt");
    detail(
      `${image.provider}/${image.modelId} produced ${image.bytes.length} bytes ` +
        `(${image.mimeType}, ${image.width ?? "?"}x${image.height ?? "?"}) for the ` +
        `"${image.purpose}" purpose; licence: "${image.license}"`,
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
  // 14. the §20 provider audit table, from the real environment
  // -----------------------------------------------------------------------
  /**
   * Printed from the actual configuration rather than maintained by hand, so it
   * cannot drift. Names and states only — §20 forbids printing a value, and this
   * script never reads one for display.
   */
  process.env["VIDXIR_USE_MOCK_PROVIDERS"] = "false";
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
  // 15. no destructive or billable external action
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
      `provider and model names are refused with 400, the four branded Vidxir AI models ` +
      `each sit on one vendor and one credential with no vendor name in any ` +
      `customer-facing payload, an undeclared resolution is refused rather than ` +
      `snapped, plan entitlements gate AI video and the premium models server-side, ` +
      `no provider credential appears in any client-bound payload, no provider module ` +
      `performs I/O at import, the mock provider is unreachable in a production ` +
      `configuration, and a generated clip and image each carry their model, licence ` +
      `and provenance.` +
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
