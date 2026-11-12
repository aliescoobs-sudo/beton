import type net from 'node:net';
export function createRelay(options: {
  targetPort: number;
  isAllowedSource: (address: string) => boolean;
  maxConnections?: number;
  maxPerSource?: number;
  idleMs?: number;
  targetHost?: string;
}): {
  server: net.Server;
  stats: { accepted: number; refusedSource: number; refusedLimit: number };
  openCount: () => number;
};
