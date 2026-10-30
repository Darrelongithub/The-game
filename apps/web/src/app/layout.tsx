// app/layout.tsx — UI foundation, verbatim from reference/ui-system.md §0
// with ui-system-FIXES #6 (font fallback: both fonts are VENDORED into
// public/fonts so the build never needs the network — spec §13 "offline by
// default, zero internet after npm install"; a missing display font degrades
// to the Inter/system-ui chain instead of crashing the build).
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AmbientBackground } from "@/components/AmbientBackground";
import "./globals.css";

// Clash Display free from fontshare.com — variable woff2, committed to the repo.
const clashDisplay = localFont({
  src: "../../public/fonts/ClashDisplay-Variable.woff2",
  variable: "--font-display",
  display: "swap",
  weight: "200 700",
  fallback: ["Inter", "system-ui", "sans-serif"],
  adjustFontFallback: false,
});

// Inter: the paste uses next/font/google, which fetches at BUILD time and
// therefore breaks the "offline game night" promise. Same font, self-hosted
// (Inter Variable, latin subset) — identical rendering, zero network.
const inter = localFont({
  src: "../../public/fonts/Inter-Variable.woff2",
  variable: "--font-body",
  display: "swap",
  weight: "100 900",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "The Reveal Game",
  description:
    "18+ private party game. Escalating prompts, then the night reveals itself.",
  applicationName: "The Reveal Game",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // keep 100dvh honest on iOS: no layout shift when the address bar collapses
  viewportFit: "cover",
  themeColor: "#100019",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${clashDisplay.variable} ${inter.variable}`}>
      <body className="bg-base text-white antialiased overflow-x-hidden relative isolate">
        <AmbientBackground />
        {children}
      </body>
    </html>
  );
}
