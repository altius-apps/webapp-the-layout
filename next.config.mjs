/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // iOS Universal Links: the extensionless AASA file must be served as JSON.
    return [
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ];
  },
  async redirects() {
    // Fantasy V2 hub + nav rework (2026-09-07): the game-picker hub collapsed
    // into a single Sleeper-style front door at /fantasy, and every in-league
    // route moved to the canonical /fantasy/l/:id scheme. Not permanent — the
    // old paths may get reused if URL structure shifts again during rollout.
    return [
      // Public League team routes (removed 2026-09-12) land on the hub.
      { source: '/fantasy/team', destination: '/fantasy', permanent: false },
      { source: '/fantasy/team/:id', destination: '/fantasy', permanent: false },
      { source: '/fantasy/my-team', destination: '/fantasy', permanent: false },
      { source: '/fantasy/ufa', destination: '/fantasy', permanent: false },
      { source: '/fantasy/ufa/team', destination: '/fantasy', permanent: false },
      { source: '/fantasy/ufa/team/:id', destination: '/fantasy', permanent: false },
      { source: '/fantasy/leagues', destination: '/fantasy', permanent: false },
      { source: '/fantasy/ufa/l/:id', destination: '/fantasy/l/:id', permanent: false },
      { source: '/fantasy/ufa/l/:id/:rest*', destination: '/fantasy/l/:id/:rest*', permanent: false },
      { source: '/fantasy/contests/:id', destination: '/fantasy/l/:id', permanent: false },
      { source: '/fantasy/contests/:id/:rest*', destination: '/fantasy/l/:id/:rest*', permanent: false },
      { source: '/fantasy/usau-club-nationals', destination: '/fantasy', permanent: false },
      { source: '/fantasy/wfdf-wucc', destination: '/fantasy', permanent: false },
      { source: '/fantasy/eucs', destination: '/fantasy', permanent: false },
    ];
  },
};

export default nextConfig;
