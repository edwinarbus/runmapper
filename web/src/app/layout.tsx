import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Condensed athletic display face, self-hosted (Bebas Neue, SIL Open Font License).
const display = localFont({
  src: "./fonts/BebasNeue-Regular.woff2",
  variable: "--font-display",
  display: "swap",
  weight: "400",
});

export const metadata: Metadata = {
  title: "drawmy.run",
  description: "Type a word or upload a logo, pick a spot, and get a running route whose GPS trace draws it.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://drawmy.run"),
  openGraph: {
    title: "drawmy.run",
    description: "Draw words and logos with your run. Pick a place, get a GPX.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#17171b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
