import type { Metadata, Viewport } from "next";
import { GlobalStyle } from "@/components/ui/GlobalStyle";
import { ThemeScript } from "@/components/ui/ThemeScript";

export const metadata: Metadata = {
  title: "Vidxir AI — One studio. Every stage of the video.",
  description:
    "Vidxir AI researches trends, writes original scripts, produces the video and publishes to YouTube on your schedule.",
  applicationName: "Vidxir AI",
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
    <html lang="en">
      <head>
        {/* Before GlobalStyle: the class must be set before the first paint. */}
        <ThemeScript />
        <GlobalStyle />
      </head>
      <body className="vidxir-root">{children}</body>
    </html>
  );
}
