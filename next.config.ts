import type { NextConfig } from "next";

const config: NextConfig = {
  // Signatures are sent as PNG images inside server actions, and excuse documents (4 MB max) too.
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  poweredByHeader: false,
  // The staff area is now the admin portal. Old bookmarks keep working; a teacher who lands on an
  // admin page is sent on to the teacher portal.
  async redirects() {
    return [
      { source: "/staff", destination: "/admin", permanent: true },
      { source: "/staff/:path*", destination: "/admin/:path*", permanent: true },
      // Old pages that are now part of the roster.
      { source: "/teacher/today", destination: "/teacher?view=day", permanent: false },
      { source: "/teacher/students", destination: "/teacher", permanent: false },
      { source: "/teacher/sheets/:path*", destination: "/teacher", permanent: false },
      { source: "/admin/sheets/:id/:month", destination: "/admin/students/:id?month=:month", permanent: false },
      { source: "/admin/sheets", destination: "/admin/students", permanent: false },
    ];
  },
};
export default config;
