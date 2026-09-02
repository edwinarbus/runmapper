import type { NextConfig } from "next";

// The app talks to the engine on same-origin /api paths.
// - In production on Vercel those paths are served by the Python function in
//   api/index.py; the rewrite points every /api/* request at it.
// - In development the engine runs on its own (uvicorn, port 8000) and the
//   rewrite proxies to it, so `npm run dev` needs no NEXT_PUBLIC_API_URL.
const nextConfig: NextConfig = {
  async rewrites() {
    return process.env.NODE_ENV === "development"
      ? [{ source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" }]
      : [{ source: "/api/:path*", destination: "/api/" }];
  },
};

export default nextConfig;
