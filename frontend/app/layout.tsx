import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import Providers from "../components/Providers";
import { THEME_INIT_SCRIPT } from "../lib/theme";

export const metadata: Metadata = {
  title: "TensorSwarm",
  description: "Peer-to-peer GPU cluster: live GPU telemetry, notebooks and jobs on Tailscale",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#091815" },
    { media: "(prefers-color-scheme: light)", color: "#F4F8F5" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is rewritten before paint by THEME_INIT_SCRIPT; the attribute differs from
    // the server render on purpose, hence suppressHydrationWarning.
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans text-fg antialiased">
        <div className="app-backdrop" aria-hidden="true" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
