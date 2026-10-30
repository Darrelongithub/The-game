/** @type {import('next').NextConfig} */
const nextConfig = {
  // The exported static site is SERVED BY the game server (single origin: no
  // CORS, no localhost calls, works behind any proxy / tunnel). Spec §10.
  // Static export is required for production; dev needs Next's server mode
  // so its same-origin Socket.IO rewrite is actually active.
  ...(process.env.NODE_ENV === "development" ? {} : { output: "export" }),
  images: { unoptimized: true },
  // Socket.IO's polling endpoint includes a trailing slash. In development,
  // proxy it server-side so phones and preview browsers always use the same
  // origin instead of trying to reach localhost on the device itself.
  skipTrailingSlashRedirect: true,
  ...(process.env.NODE_ENV === "development" ? {
    async rewrites() {
      const backend = (process.env.DEV_GAME_SERVER_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
      // Next drops the trailing slash for an empty wildcard. Keep a segment
      // after /socket.io/ so the backend's Engine.IO path matcher sees it.
      return [{ source: "/socket.io/:path*", destination: `${backend}/socket.io/proxy/:path*` }];
    },
  } : {}),
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
