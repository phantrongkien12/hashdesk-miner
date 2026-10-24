/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    // Next.js 16.4 stops the build to offer an interactive upgrade agent when
    // the installed version has a security advisory. On a headless VPS that
    // leaves .next half-written and `next start` fails with "Could not find a
    // production build". Builds must be non-interactive.
    agentUpgrade: false,
  },
}

export default nextConfig
