import type { NextConfig } from "next";

const config: NextConfig = {
  // Signatures are sent as PNG images inside server actions.
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  poweredByHeader: false,
  // The staff area is now the admin portal. Old bookmarks keep working; a teacher who lands on an
  // admin page is sent on to the teacher portal.
  async redirects() {
    return [
      { source: "/staff", destination: "/admin", permanent: true },
      { source: "/staff/:path*", destination: "/admin/:path*", permanent: true },
    ];
  },
};
export default config;
