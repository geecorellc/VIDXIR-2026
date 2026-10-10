import { describe, expect, it } from "vitest";
import { supportTicketAcknowledgement } from "./support-ticket";

describe("support ticket acknowledgement", () => {
  it("includes a bold title, response timeframe, follow-up instructions and team signoff", () => {
    const mail = supportTicketAcknowledgement({
      name: "Alex",
      subject: "Second request",
      message: "Please help with my video.",
    });
    expect(mail.html).toContain(
      '<strong style="color:#F5F3F1">Second request</strong>',
    );
    for (const content of [
      "one to three working days",
      "Thank you for using Vidxir AI",
      "replying to this email",
      "same support thread",
      "Please help with my video.",
    ]) {
      expect(mail.text).toContain(content);
      expect(mail.html).toContain(content);
    }
    expect(mail.text).toMatch(/Regards,\nThe Vidxir AI Team$/);
    expect(mail.html).toContain("Regards,<br>The Vidxir AI Team");
  });
  it("escapes user content while keeping only the intended title formatting", () => {
    const mail = supportTicketAcknowledgement({
      name: "<img>",
      subject: "<script>title</script>",
      message: "<b>Message</b>\nNext line",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img>");
    expect(mail.html).toContain("&lt;b&gt;Message&lt;/b&gt;<br>Next line");
    expect(mail.html).toContain('<meta charset="utf-8">');
  });
});
