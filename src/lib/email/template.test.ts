import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "./template";
import { renderMail } from "../admin/mail";

describe("shared outgoing email styling", () => {
  it("uses the account email shell for support and campaign messages", () => {
    const html = renderMail("Support reply", "Hi Alex,\n\nWe’re here to help.");
    expect(html).toBe(renderEmailTemplate("Support reply", "Hi Alex,<br><br>We’re here to help."));
    expect(html).toContain("max-width:520px");
    expect(html).toContain("border:1px solid #241F22");
  });
  it("escapes plain message content and headings without losing line breaks", () => {
    const html = renderMail('<img src=x onerror="alert(1)">', "<script>alert(1)</script>\r\nA & B");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;<br>A &amp; B");
  });
  it("keeps optional action buttons and escapes link attributes and labels", () => {
    const html = renderEmailTemplate("Verify", "Confirm your account.", { label: "Confirm & continue", url: 'https://app.vidxir.com/verify?token=a&next="test"' });
    expect(html).toContain("Confirm &amp; continue");
    expect(html).toContain('href="https://app.vidxir.com/verify?token=a&amp;next=&quot;test&quot;"');
    expect(html).toContain("Or paste this link into your browser:");
    expect(renderMail("Support", "Message")).not.toContain("<a ");
  });
});
