import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cue — the agentic music supervisor",
  description:
    "Cue scores film, TV and advertising scenes with music that is culturally right, not just plausible. Every pick is ranked by the Qloo Taste Graph.",
  applicationName: "Cue",
  authors: [{ name: "Cue" }],
  openGraph: {
    title: "Cue — the agentic music supervisor",
    description:
      "Scene brief in, culturally grounded cue sheet out. Powered by the Qloo Taste Graph.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#07070b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 text-haze-100 antialiased">
        {children}
      </body>
    </html>
  );
}
