import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { GlobalStyle } from "@/components/ui/GlobalStyle";
import { ThemeScript } from "@/components/ui/ThemeScript";
import "../../public/livechat.css";

export const metadata: Metadata = {
  title: "Vidxir AI — One studio. Every stage of the video.",
  description:
    "Vidxir AI researches trends, writes original scripts, produces the video and publishes to YouTube on your schedule.",
  applicationName: "Vidxir AI",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32", type: "image/x-icon" },
    ],
    apple: {
      url: "/apple-touch-icon.png",
      sizes: "180x180",
      type: "image/png",
    },
  },
  robots: { index: true, follow: true },
};

/**
 * `themeColor` is read by the browser chrome before any stylesheet applies, so
 * it cannot be a `var()` — these are the two literal `--vx-bg` values, declared
 * per colour scheme so the address bar matches whichever theme is active.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0A0C" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /**
     * `suppressHydrationWarning` is required, not cosmetic.
     *
     * `ThemeScript` adds `vx-dark` to this element before React hydrates, so a
     * dark-theme user's DOM reads `class="vx-dark"` where the server sent no
     * class at all. React reports that as a hydration mismatch — correctly, in
     * the sense that the attributes genuinely differ.
     *
     * The alternative fixes are both worse. Rendering the class on the server
     * is impossible: the choice lives in localStorage, which a server component
     * cannot read. Setting it from an effect instead would run after hydration
     * and flash white at a dark-theme user on every navigation, which is the
     * whole reason the pre-paint script exists.
     *
     * So the mismatch is intentional and this is React's documented escape
     * hatch for it. Two constraints come with it: it covers only this element's
     * own attributes, not any descendant's, and React makes no guarantee about
     * reconciling attribute differences — which is why nothing renders a
     * `className` here. The script owns this attribute outright.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before GlobalStyle: the class must be set before the first paint. */}
        <ThemeScript />
        <GlobalStyle />
      </head>
      <body className="vidxir-root">
        {children}
        <Script
          id="vidxir-livechat"
          src="/livechat.js"
          strategy="afterInteractive"
        />
        <noscript>
          <div className="livechat-fallback">
            <a
              href="https://www.livechat.com/chat-with/19969473/"
              rel="nofollow"
            >
              Chat with us
            </a>
            {", powered by "}
            <a
              href="https://www.livechat.com/?welcome"
              rel="noopener nofollow"
              target="_blank"
            >
              LiveChat
            </a>
          </div>
        </noscript>
      </body>
    </html>
  );
}
