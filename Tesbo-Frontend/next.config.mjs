import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Repo root has a lockfile but no `next`; pin Turbopack root so `next` resolves.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
