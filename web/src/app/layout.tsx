import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "runmapper",
  description: "Type a word or upload a logo, pick a spot, and get a running route whose GPS trace draws it.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://runmapper.run"),
  openGraph: {
    title: "runmapper",
    description: "Draw words and logos with your run. Pick a place, get a GPX.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FC5200",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-white text-zinc-900">{children}</body>
    </html>
  );
}
