import type { NextConfig } from "next";

// backend origin for the /api proxy; docker-compose sets BACKEND_ORIGIN=http://backend:8000,
// local runs default to localhost:8000 (same as scripts/backend.sh)
const backend = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // app is a client-side interview UI over an API proxy; static prerender adds no value
  cacheComponents: false,
  partialPrefetching: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
