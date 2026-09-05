/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard holds NO database credentials and NO policy logic. It calls
  // the API over HTTP (ADR-0002), which is what keeps the trust boundary a
  // network hop rather than a code convention.
  env: {},
};

export default nextConfig;
