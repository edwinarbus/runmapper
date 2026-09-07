import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Condensed athletic display face, self-hosted (Bebas Neue, SIL Open Font License).
const display = localFont({
  src: "./fonts/BebasNeue-Regular.woff2",
  variable: "--font-display",
  display: "swap",
  weight: "400",
});

// Where the site lives, for absolute links in the share cards: the configured
// address, else the Vercel production address, else the domain.
const site = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://drawmy.run");

export const metadata: Metadata = {
  title: "drawmy.run",
  description: "Create GPS art based on your words, scribbles, or images. Follow the route during your workout and show off your creations on Strava.",
  metadataBase: new URL(site),
  openGraph: {
    title: "drawmy.run",
    description: "Create GPS art based on your words, scribbles, or images. Follow the route during your workout and show off your creations on Strava.",
    type: "website",
    siteName: "drawmy.run",
    // The card with a real run drawing itself in: Slack and Messages play it;
    // everything else shows its first frame, which is the finished card. The
    // still comes second for anything that wants one.
    images: [
      { url: "/og.gif", width: 1200, height: 630, type: "image/gif", alt: "drawmy.run: DRAWMY.RUN drawn on the streets of a town by a 6.21 mile run" },
      { url: "/og.png", width: 1200, height: 630, type: "image/png", alt: "drawmy.run: DRAWMY.RUN drawn on the streets of a town by a 6.21 mile run" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "drawmy.run",
    description: "Create GPS art based on your words, scribbles, or images. Follow the route during your workout and show off your creations on Strava.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",        // out to the edges of a phone; the map's controls mind the safe area
  themeColor: "#0b0b0d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
