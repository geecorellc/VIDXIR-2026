/** Reuse Lyrixa's existing JV segment; never create a segment here. */
export const JV_SEGMENT_NAME = "Lyrixsa – JV Launch Updates";

export function allowedJvOrigin(origin: string): boolean {
  if (
    [
      "https://app.vidxir.com",
      "https://jv.vidxir.com",
      "https://vidxir-jv.pages.dev",
    ].includes(origin)
  )
    return true;
  try {
    const url = new URL(origin);
    return (
      ((url.protocol === "https:" &&
        /^[a-z0-9-]+\.vidxir-jv\.pages\.dev$/.test(url.hostname) &&
        !url.port) ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname) &&
          url.port === "3002")) &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

export async function subscribeJv(
  apiKey: string,
  fields: { name: string; email: string },
  request: typeof fetch = fetch,
): Promise<void> {
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const response = await request(`https://api.resend.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 429 || attempt >= 2) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000;
      if (delay > 2000) return response;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };
  const segments = await call("/segments?limit=100");
  if (!segments.ok) throw new Error("Could not look up the JV segment.");
  const list = (await segments.json()) as {
    data: { id: string; name: string }[];
  };
  const segment = list.data.find((item) => item.name === JV_SEGMENT_NAME);
  if (!segment) throw new Error("The existing JV segment was not found.");

  const emailPath = `/contacts/${encodeURIComponent(fields.email)}`;
  const existing = await call(emailPath);
  if (!existing.ok && existing.status !== 404)
    throw new Error("Could not look up the contact.");
  if (existing.status === 404) {
    const [first_name, ...rest] = fields.name.split(/\s+/);
    const created = await call("/contacts", "POST", {
      email: fields.email,
      first_name,
      last_name: rest.join(" "),
      unsubscribed: false,
      segments: [{ id: segment.id }],
    });
    if (created.ok) return;
    // Another simultaneous signup may have created the same contact.
    if (created.status !== 409) throw new Error("Could not save the contact.");
  }
  // Preserve existing names, other segment memberships and unsubscribe preferences.
  const attached = await call(
    `${emailPath}/segments/${encodeURIComponent(segment.id)}`,
    "POST",
  );
  if (!attached.ok)
    throw new Error("Could not add the contact to the JV segment.");
}
