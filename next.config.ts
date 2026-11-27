import type { NextConfig } from 'next';
import { securityHeaders } from './lib/security-headers';

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'development') },
    ];
  },
};

export default config;
