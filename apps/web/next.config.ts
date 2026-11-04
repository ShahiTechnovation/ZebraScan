import type { NextConfig } from "next";

const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Separate build output for the connected-mode E2E build (keeps the demo build intact).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  eslint: { ignoreDuringBuilds: true },
  // Workspace package compiled from TypeScript source.
  transpilePackages: ["@zeb/contracts"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
          ...(apiOrigin ? [{ key: "Content-Security-Policy", value: `default-src 'self'; connect-src 'self' ${apiOrigin}; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
