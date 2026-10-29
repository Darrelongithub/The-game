/** @type {import('next').NextConfig} */
const nextConfig = {
  // The exported static site is SERVED BY the game server (single origin: no
  // CORS, no localhost calls, works behind any proxy / tunnel). Spec §10.
  output: "export",
  images: { unoptimized: true },
  // Next 15 blocks cross-origin dev requests from unknown hosts. The Arena
  // preview proxy and LAN phones both need in — this is a dev-only allowlist.
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "*.e2b.app",
    "*.arena.ai",
    "*.local",
  ],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
