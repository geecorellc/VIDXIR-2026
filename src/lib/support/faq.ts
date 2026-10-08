export const SUPPORT_FAQ = [
  {
    category: "Getting started",
    question: "How do I connect my YouTube channel?",
    answer:
      "Open Channels in your studio and choose Connect channel. Sign in with the Google account that owns your channel and grant the requested permissions. Vidxir never asks for your YouTube password.",
    href: "/dashboard/channels",
    link: "Open Channels",
  },
  {
    category: "Getting started",
    question: "I finished setup. Why am I seeing onboarding again?",
    answer:
      "Completed setup is saved to your account. Open the dashboard to start a fresh page. If setup or the dashboard still fails, open a support request and include any error reference shown on screen.",
    href: "/dashboard",
    link: "Open dashboard",
  },
  {
    category: "Creating videos",
    question: "How do I start a video?",
    answer:
      "Start with a description, a YouTube link, or a research idea. Your project moves through scripting, video production, thumbnails, and publishing. Follow the project status in your dashboard; some stages require your approval.",
    href: "/dashboard",
    link: "Open studio",
  },
  {
    category: "Creating videos",
    question: "Why is a generation or publishing step unavailable?",
    answer:
      "A feature may need a connected channel, an available provider, sufficient credits, or access through your plan. Check the message on that page for what is missing. If a project fails, include its title and the error message in your support request.",
  },
  {
    category: "Credits and billing",
    question: "Where can I see my credits and plan?",
    answer:
      "Billing shows your current plan and available credits. Monthly allowances and non-expiring purchased credits are tracked separately. Feature and project limits depend on your plan.",
    href: "/dashboard/billing",
    link: "Open Billing",
  },
  {
    category: "Credits and billing",
    question: "How do I manage my subscription?",
    answer:
      "Use the billing controls in your studio to manage your subscription. If a billing action is unavailable or a charge looks incorrect, contact support with the date and account email. Never include your card details or passwords in a ticket.",
    href: "/dashboard/billing",
    link: "Open Billing",
  },
  {
    category: "Publishing",
    question: "Does Vidxir publish every generated video automatically?",
    answer:
      "Publishing depends on your selected automation level and channel settings. Manual and assisted flows include approval steps. Review your channel's publishing settings, video visibility, and schedule before enabling automation.",
    href: "/dashboard/channels",
    link: "Review channels",
  },
  {
    category: "Publishing",
    question: "Why does analytics show a dash instead of a number?",
    answer:
      "A dash means a metric has not been collected or is unavailable through the connected channel's permissions. Revenue can require additional YouTube access. Vidxir does not display missing data as zero.",
  },
  {
    category: "Account and support",
    question: "How can I recover my password?",
    answer:
      "Use Forgot password on the login page with your account email. Follow the link in the reset email. Changing your password signs out existing sessions.",
    href: "/forgot-password",
    link: "Reset password",
  },
  {
    category: "Account and support",
    question: "How do I follow up on a support ticket?",
    answer:
      "Signed-in customers can see their conversations on the Support page. Replies are also emailed to your account address. Reply to that email from the same address to continue the conversation. Guests receive updates by email.",
  },
] as const;
