/**
 * Static-export config: `next build` emits a self-contained SPA into `out/`, which the API
 * serves at WEB_ROOT — same single-container model as the old static panel, no separate Next
 * server. Everything talks to the existing REST API at /api, so no SSR/API routes are needed.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  // Required for static export (no image optimization server). We don't ship remote images.
  images: { unoptimized: true },
  // The public demo (app/demo) answers the panel from the walkthrough stage's records
  // (test/walk-stage.mjs), which name the permissions and actions from their own packages.
  experimental: { externalDir: true },
};

export default nextConfig;
