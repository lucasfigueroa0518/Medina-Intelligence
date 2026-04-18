/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // API requests go directly to the Worker from the browser using
  // NEXT_PUBLIC_API_URL from frontend/.env.local — no Next.js rewrite needed.
};

export default nextConfig;
