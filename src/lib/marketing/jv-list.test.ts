import { describe, expect, it, vi } from "vitest";
import { allowedJvOrigin, JV_SEGMENT_NAME, subscribeJv } from "./jv-list";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const segments = () =>
  json({
    data: [
      { id: "shared-jv", name: JV_SEGMENT_NAME },
      { id: "other", name: "Other" },
    ],
  });
const fields = { name: "Jordan Miller", email: "jordan@example.com" };
describe("JV lead capture", () => {
  it("creates a contact in the existing segment without creating segments", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(segments())
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ id: "contact" }));
    await subscribeJv("test-key", fields, request);
    expect(
      request.mock.calls.map(([url, options]) => [url, options?.method]),
    ).toEqual([
      ["https://api.resend.com/segments?limit=100", "GET"],
      ["https://api.resend.com/contacts/jordan%40example.com", "GET"],
      ["https://api.resend.com/contacts", "POST"],
    ]);
    expect(JSON.parse(request.mock.calls[2]![1]!.body as string)).toMatchObject({
      segments: [{ id: "shared-jv" }],
      first_name: "Jordan",
      last_name: "Miller",
    });
  });
  it("adds existing contacts without changing their unsubscribe preference or name", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(segments())
      .mockResolvedValueOnce(json({ unsubscribed: true }))
      .mockResolvedValueOnce(json({ id: "shared-jv" }));
    await subscribeJv("test-key", fields, request);
    expect(request.mock.calls[2]![0]).toBe(
      "https://api.resend.com/contacts/jordan%40example.com/segments/shared-jv",
    );
    expect(request.mock.calls[2]![1]?.body).toBeUndefined();
    expect(
      request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
  });
  it("fails when the shared segment is missing instead of creating one", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [] }));
    await expect(subscribeJv("test-key", fields, request)).rejects.toThrow(
      "existing JV segment",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not treat a provider authentication failure as an existing contact", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(segments())
      .mockResolvedValueOnce(json({}, 401));
    await expect(subscribeJv("test-key", fields, request)).rejects.toThrow(
      "look up the contact",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reports a failed segment attachment", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(segments())
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({}, 500));
    await expect(subscribeJv("test-key", fields, request)).rejects.toThrow(
      "add the contact",
    );
  });
  it("handles a concurrent duplicate contact creation", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(segments())
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({}));
    await subscribeJv("test-key", fields, request);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("only allows the JV site, its previews, and the local preview", () => {
    for (const origin of [
      "https://vidxir.com",
      "https://www.vidxir.com",
      "https://jv.vidxir.com",
      "https://vidxir-jv.pages.dev",
      "https://abc123.vidxir-jv.pages.dev",
      "http://localhost:3002",
    ])
      expect(allowedJvOrigin(origin)).toBe(true);
    for (const origin of [
      "https://vidxir.com.evil.com",
      "http://vidxir.com",
      "https://evil.com",
      "https://vidxir-jv.pages.dev.evil.com",
      "https://other.pages.dev",
      "null",
      "http://jv.vidxir.com",
      "http://localhost:3002/path",
    ])
      expect(allowedJvOrigin(origin)).toBe(false);
  });
});
