import { describe, expect, it } from "vitest";
import { signMedia, verifyMedia } from "../../src/lib/cloudflare/media-token";

describe("Private R2 media capabilities", () => {
  const secret = "a".repeat(64);
  it("authenticates the key, expiry, method, and content type", () => {
    const grant = { key: "u/user/upload/logo.png", method: "PUT" as const, expires: Date.now() + 60000, contentType: "image/png" };
    const token = signMedia(grant, secret);
    expect(verifyMedia(token, secret)).toEqual(grant);
    expect(verifyMedia(token, "b".repeat(64))).toBeNull();
    const altered = Buffer.from(JSON.stringify({ ...grant, key: "u/another-user/upload/logo.png" })).toString("base64url");
    expect(verifyMedia(`${altered}.${token.split(".")[1]}`, secret)).toBeNull();
  });
  it("rejects expired grants and malformed tokens", () => {
    expect(verifyMedia(signMedia({ key: "u/user/video/test.mp4", method: "GET", expires: Date.now() - 1 }, secret), secret)).toBeNull();
    expect(verifyMedia("invalid", secret)).toBeNull();
  });
});
