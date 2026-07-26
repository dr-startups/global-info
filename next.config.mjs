/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep Playwright out of the Next server webpack graph (instrumentation / API routes).
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
