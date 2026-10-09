/** Escape content before inserting it into the shared email HTML. */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Minimal dark-themed shell matching the Vidxir AI palette. */
export function renderEmailTemplate(
  heading: string,
  body: string,
  cta?: { label: string; url: string },
) {
  return `<!doctype html>
<html><body style="margin:0;background:#0B0A0C;font-family:Inter,system-ui,sans-serif;color:#F5F3F1;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#141216;border:1px solid #241F22;border-radius:12px;padding:28px">
    <div style="font-family:Oswald,Arial Narrow,sans-serif;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;color:#E8332B;margin-bottom:18px">Vidxir AI</div>
    <h1 style="font-family:Oswald,Arial Narrow,sans-serif;text-transform:uppercase;font-size:22px;margin:0 0 14px">${escapeHtml(heading)}</h1>
    <div style="font-size:14px;line-height:1.6;color:#B5AEB1">${body}</div>
    ${
      cta
        ? `<a href="${escapeHtml(cta.url)}" style="display:inline-block;margin-top:22px;background:#E8332B;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(cta.label)}</a>
    <p style="font-size:12px;color:#6E666A;margin-top:20px;word-break:break-all">Or paste this link into your browser:<br>${escapeHtml(cta.url)}</p>`
        : ""
    }
  </div>
</body></html>`;
}
