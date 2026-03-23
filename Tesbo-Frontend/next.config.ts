import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack module resolution scoped to the frontend app.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
