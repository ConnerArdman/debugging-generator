// Framework-detection signal for this fixture corpus. It is never installed, built
// or run, so it imports nothing, and it stays `.mjs` to remain outside the corpus's
// TypeScript program.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
