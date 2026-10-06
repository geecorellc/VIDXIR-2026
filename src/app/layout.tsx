import type { Metadata, Viewport } from "next";
import { GlobalStyle } from "@/components/ui/GlobalStyle";
import { color } from "@/lib/design/tokens";

export const metadata: Metadata = {
  title: "Vidxir AI — One studio. Every stage of the video.",
  description:
    "Vidxir AI researches trends, writes original scripts, produces the video and publishes to YouTube on your schedule.",
  applicationName: "Vidxir AI",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: color.bg,
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <GlobalStyle />
      </head>
      <body className="vidxir-root">{children}</body>
    </html>
  );
}
