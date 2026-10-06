/**
 * Multi-tenant isolation and plan-enforcement integration tests (§39, §34, §23).
 *
 * The question every test here asks is the same: given a valid session for user
 * A and a real resource id belonging to user B, can A reach it? These have to run
 * against a real database because isolation is a property of the SQL predicate
 * that executes, not of the TypeScript that composes it — a missing `userId` in a
 * WHERE clause type-checks perfectly.
 *
 * Plan enforcement is tested from the subscriptions table in both directions:
 * that a limit refuses, and that raising the tier actually lifts it. §24 forbids
 * granting a feature because a caller claimed a tier, so no test passes a tier
 * the database does not hold.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  createUser,
  hasDatabase,
  jar,
  resetDatabase,
  setTier,
  useDatabase,
} from "./setup";

vi.mock("next/headers", () => ({
  cookies: async () => jar,
}));

const suite = hasDatabase ? describe : describe.skip;

suite("tenant isolation (integration)", () => {
  useDatabase();
  beforeEach(resetDatabase);

  describe("projects", () => {
    it("refuses to read another user's project by id", async () => {
      const { createProject, getProject } = await import("@/lib/projects/service");
      const owner = await createUser({ email: "owner@vidxir.test" });
      const other = await createUser({ email: "other@vidxir.test" });
      const channelId = await createChannel(owner.id);

      const project = await createProject({
        userId: owner.id,
        channelId,
        title: "Owner's video",
        maxVideosPerMonth: null,
      });

      // The owner sees it.
      await expect(getProject(owner.id, project.id)).resolves.toMatchObject({
        id: project.id,
      });

      // A different tenant holding a valid id does not. "Not found" rather than
      // "forbidden" wording avoids confirming the id exists.
      await expect(getProject(other.id, project.id)).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    it("does not list another user's projects", async () => {
      const { createProject, listProjects } = await import(
        "@/lib/projects/service"
      );
      const owner = await createUser({ email: "owner2@vidxir.test" });
      const other = await createUser({ email: "other2@vidxir.test" });
      const ownerChannel = await createChannel(owner.id);
      const otherChannel = await createChannel(other.id);

      await createProject({
        userId: owner.id,
        channelId: ownerChannel,
        title: "A",
        maxVideosPerMonth: null,
      });
      await createProject({
        userId: owner.id,
        channelId: ownerChannel,
        title: "B",
        maxVideosPerMonth: null,
      });
      await createProject({
        userId: other.id,
        channelId: otherChannel,
        title: "C",
        maxVideosPerMonth: null,
      });

      const ownerProjects = await listProjects(owner.id);
      const otherProjects = await listProjects(other.id);

      expect(ownerProjects.map((p) => p.title).sort()).toEqual(["A", "B"]);
      expect(otherProjects.map((p) => p.title)).toEqual(["C"]);
    });

    it("refuses to transition another user's project", async () => {
      const { createProject, transition, getProject } = await import(
        "@/lib/projects/service"
      );
      const owner = await createUser({ email: "owner3@vidxir.test" });
      const other = await createUser({ email: "other3@vidxir.test" });
      const channelId = await createChannel(owner.id);
      const project = await createProject({
        userId: owner.id,
        channelId,
        title: "Not yours",
        maxVideosPerMonth: null,
      });

      await expect(
        transition(other.id, project.id, "SCRIPT_GENERATING"),
      ).rejects.toMatchObject({ code: "forbidden" });

      // And the state genuinely did not move.
      const after = await getProject(owner.id, project.id);
      expect(after.status).toBe("IDEA");
    });

    it("does not let another user move progress on a project", async () => {
      const { createProject, setProgress, getProject } = await import(
        "@/lib/projects/service"
      );
      const owner = await createUser({ email: "owner4@vidxir.test" });
      const other = await createUser({ email: "other4@vidxir.test" });
      const channelId = await createChannel(owner.id);
      const project = await createProject({
        userId: owner.id,
        channelId,
        title: "Progress",
        maxVideosPerMonth: null,
      });

      // `setProgress` is a blind UPDATE, so it cannot throw — the predicate has
      // to be what protects the row. Assert on the row, not on the return value.
      await setProgress(other.id, project.id, 90);
      const after = await getProject(owner.id, project.id);
      expect(after.progress).toBe(0);
    });
  });

  describe("channels", () => {
    it("only lists the caller's channels", async () => {
      const { listChannelSummaries } = await import("@/lib/dashboard/stage");
      const owner = await createUser({ email: "chan-owner@vidxir.test" });
      const other = await createUser({ email: "chan-other@vidxir.test" });
      await createChannel(owner.id, { title: "Owner Channel" });
      await createChannel(other.id, { title: "Other Channel" });

      const mine = await listChannelSummaries(owner.id);
      expect(mine.map((c) => c.title)).toEqual(["Owner Channel"]);
    });

    it("never returns OAuth tokens in a channel summary (§6)", async () => {
      const { listChannelSummaries } = await import("@/lib/dashboard/stage");
      const user = await createUser({ email: "tokens@vidxir.test" });
      await createChannel(user.id);

      const [summary] = await listChannelSummaries(user.id);
      expect(summary).toBeDefined();

      // Serialised, because the constraint is about what reaches the browser.
      const serialised = JSON.stringify(summary);
      expect(serialised).not.toContain("access-token");
      expect(serialised).not.toContain("refresh-token");
      expect(serialised).not.toMatch(/accessToken|refreshToken|v1\./);
    });

    it("refuses to read another user's channel settings", async () => {
      const { getChannelConfig, initialiseChannelConfig } = await import(
        "@/lib/settings/service"
      );
      const owner = await createUser({ email: "set-owner@vidxir.test" });
      const other = await createUser({ email: "set-other@vidxir.test" });
      const channelId = await createChannel(owner.id);
      await initialiseChannelConfig(owner.id, channelId);

      await expect(getChannelConfig(owner.id, channelId)).resolves.toMatchObject({
        channelId,
      });

      // The other tenant must not be handed a config for a channel they do not
      // own — and must not silently have one created for them either.
      await expect(getChannelConfig(other.id, channelId)).rejects.toThrow();
    });

    it("keeps per-channel settings separate (§27)", async () => {
      const { getChannelConfig, initialiseChannelConfig, updateChannelSettings } =
        await import("@/lib/settings/service");
      const user = await createUser({ email: "multi@vidxir.test" });
      await setTier(user.id, "scale");

      const first = await createChannel(user.id, {
        youtubeChannelId: "UCaaaaaaaaaaaaaaaaaaaaa1",
        title: "Channel One",
      });
      const second = await createChannel(user.id, {
        youtubeChannelId: "UCaaaaaaaaaaaaaaaaaaaaa2",
        title: "Channel Two",
      });
      await initialiseChannelConfig(user.id, first);
      await initialiseChannelConfig(user.id, second);

      await updateChannelSettings(user.id, first, { niche: "Woodworking" });

      const one = await getChannelConfig(user.id, first);
      const two = await getChannelConfig(user.id, second);

      expect(one.settings.niche).toBe("Woodworking");
      // §27: "Don't assume shared settings."
      expect(two.settings.niche).not.toBe("Woodworking");
    });
  });

  describe("onboarding", () => {
    it("keeps each user's answers to themselves", async () => {
      const { getProfile, saveStep } = await import("@/lib/onboarding/service");
      const first = await createUser({ email: "ob1@vidxir.test" });
      const second = await createUser({ email: "ob2@vidxir.test" });

      await saveStep(first.id, { niche: "Vintage synths" });

      expect((await getProfile(first.id)).niche).toBe("Vintage synths");
      expect((await getProfile(second.id)).niche).toBeNull();
    });

    it("refuses to complete while required answers are missing", async () => {
      const { complete, saveStep } = await import("@/lib/onboarding/service");
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const user = await createUser({ email: "ob3@vidxir.test" });

      await expect(complete(user.id)).rejects.toMatchObject({
        code: "validation_failed",
      });

      // And `onboarded_at` must still be null — otherwise the dashboard would
      // open on a user with no niche to research for.
      const [before] = await db
        .select({ onboardedAt: users.onboardedAt })
        .from(users)
        .where(eq(users.id, user.id));
      expect(before?.onboardedAt).toBeNull();

      await saveStep(user.id, {
        niche: "Retro consoles",
        contentStyle: "documentary",
        voicePreference: "warm-male",
      });
      await complete(user.id);

      const [after] = await db
        .select({ onboardedAt: users.onboardedAt })
        .from(users)
        .where(eq(users.id, user.id));
      expect(after?.onboardedAt).toBeInstanceOf(Date);
    });
  });
});

suite("plan enforcement (integration)", () => {
  useDatabase();
  beforeEach(resetDatabase);

  describe("channel limit", () => {
    it("refuses a second channel on Starter and allows it on Studio", async () => {
      const { assertCanConnectChannel } = await import("@/lib/plans/enforce");
      const { currentTier } = await import("@/lib/api/guard");

      const user = await createUser({ email: "limit@vidxir.test" });
      await createChannel(user.id, { youtubeChannelId: "UCbbbbbbbbbbbbbbbbbbbbb1" });

      // The tier comes from the database, never from the caller (§24).
      await expect(
        assertCanConnectChannel(user.id, await currentTier(user.id)),
      ).rejects.toMatchObject({ code: "plan_limit_reached" });

      await setTier(user.id, "studio");
      await expect(
        assertCanConnectChannel(user.id, await currentTier(user.id)),
      ).resolves.toBeUndefined();
    });

    it("does not count a disconnected channel against the limit", async () => {
      const { assertCanConnectChannel } = await import("@/lib/plans/enforce");
      const { db } = await import("@/lib/db");
      const { channels } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const user = await createUser({ email: "disc@vidxir.test" });
      const channelId = await createChannel(user.id);

      await expect(
        assertCanConnectChannel(user.id, "starter"),
      ).rejects.toMatchObject({ code: "plan_limit_reached" });

      await db
        .update(channels)
        .set({ disconnectedAt: new Date() })
        .where(eq(channels.id, channelId));

      // A user who removed a channel has their slot back.
      await expect(
        assertCanConnectChannel(user.id, "starter"),
      ).resolves.toBeUndefined();
    });

    it("does not let one user's channels consume another's allowance", async () => {
      const { assertCanConnectChannel } = await import("@/lib/plans/enforce");
      const busy = await createUser({ email: "busy@vidxir.test" });
      const fresh = await createUser({ email: "fresh@vidxir.test" });
      await createChannel(busy.id);

      await expect(
        assertCanConnectChannel(fresh.id, "starter"),
      ).resolves.toBeUndefined();
    });
  });

  describe("monthly video limit", () => {
    it("stops the fifth video on Starter and counts starts, not publishes", async () => {
      const { assertCanStartVideo } = await import("@/lib/plans/enforce");
      const { createProject } = await import("@/lib/projects/service");

      const user = await createUser({ email: "quota@vidxir.test" });
      const channelId = await createChannel(user.id);

      // Starter includes four videos a month.
      for (let i = 0; i < 4; i += 1) {
        await assertCanStartVideo(user.id, "starter");
        await createProject({
          userId: user.id,
          channelId,
          title: `Video ${i + 1}`,
          maxVideosPerMonth: 4,
        });
      }

      await expect(
        assertCanStartVideo(user.id, "starter"),
      ).rejects.toMatchObject({ code: "plan_limit_reached" });

      // Unlimited on Studio, from the same counter.
      await setTier(user.id, "studio");
      await expect(
        assertCanStartVideo(user.id, "studio"),
      ).resolves.toBeUndefined();
    });

    it("reports usage from the database, not from a counter the UI keeps", async () => {
      const { entitlementsFor } = await import("@/lib/plans/enforce");
      const { createProject, currentPeriod } = await import(
        "@/lib/projects/service"
      );

      const user = await createUser({ email: "usage@vidxir.test" });
      const channelId = await createChannel(user.id);
      await createProject({
        userId: user.id,
        channelId,
        title: "One",
        maxVideosPerMonth: null,
      });
      await createProject({
        userId: user.id,
        channelId,
        title: "Two",
        maxVideosPerMonth: null,
      });

      const entitlements = await entitlementsFor(user.id, "starter");
      expect(entitlements.usage.videosStartedThisMonth).toBe(2);
      expect(entitlements.usage.channelsConnected).toBe(1);
      expect(entitlements.usage.period).toBe(currentPeriod());
      expect(entitlements.maxVideosPerMonth).toBe(4);
    });
  });

  describe("features", () => {
    it("refuses a paid feature on Starter regardless of what the caller asks for", async () => {
      const { requireFeature, hasFeature } = await import("@/lib/plans/enforce");
      const { currentTier } = await import("@/lib/api/guard");

      const user = await createUser({ email: "feature@vidxir.test" });
      const tier = await currentTier(user.id);
      expect(tier).toBe("starter");

      expect(hasFeature(tier, "autoPublish")).toBe(false);
      expect(() => requireFeature(tier, "autoPublish")).toThrow(
        /Starter/,
      );

      // Only a real subscription row changes the answer.
      await setTier(user.id, "studio");
      const upgraded = await currentTier(user.id);
      expect(hasFeature(upgraded, "autoPublish")).toBe(true);
      expect(() => requireFeature(upgraded, "autoPublish")).not.toThrow();
    });

    it("keeps cross-channel analytics and priority rendering on Scale only", async () => {
      const { hasFeature } = await import("@/lib/plans/enforce");
      const { currentTier } = await import("@/lib/api/guard");
      const user = await createUser({ email: "scale@vidxir.test" });

      await setTier(user.id, "studio");
      expect(hasFeature(await currentTier(user.id), "crossChannelAnalytics")).toBe(
        false,
      );

      await setTier(user.id, "scale");
      expect(hasFeature(await currentTier(user.id), "crossChannelAnalytics")).toBe(
        true,
      );
      expect(hasFeature(await currentTier(user.id), "priorityRenderQueue")).toBe(
        true,
      );
    });

    it("falls back to Starter when a subscription is inactive", async () => {
      const { db } = await import("@/lib/db");
      const { subscriptions } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const { currentTier } = await import("@/lib/api/guard");

      const user = await createUser({ email: "lapsed@vidxir.test" });
      await setTier(user.id, "scale");
      expect(await currentTier(user.id)).toBe("scale");

      // A failed payment must remove access, not leave it granted (§24).
      await db
        .update(subscriptions)
        .set({ status: "canceled" })
        .where(eq(subscriptions.userId, user.id));

      expect(await currentTier(user.id)).toBe("starter");
    });
  });
});
