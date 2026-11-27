// Response headers for every page and API route. Set in next.config.ts.
//
// The pages are static, so the policy cannot carry a per-request nonce and
// scripts and styles keep 'unsafe-inline' (Next's own bootstrap is inline).
// What it does stop: scripts, frames, fonts and plugins from other origins,
// the app being framed by another site, forms posting elsewhere, and plain
// http or ws connections. Connections stay open to any https host, because
// the mint is configurable and a Lightning address can live anywhere.

export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "font-src 'self'",
    `connect-src 'self' https:${dev ? ' ws: http://localhost:*' : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function securityHeaders(dev: boolean): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(dev) },
    // For browsers that predate frame-ancestors.
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // No address of this app, with or without a path, goes to the mint, the price
    // hosts or a Lightning address host.
    { key: 'Referrer-Policy', value: 'no-referrer' },
    // Nothing here uses these. Passkeys (publickey-credentials-*) keep their default: this origin only.
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
    },
  ];
}
