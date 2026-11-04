/** Product builds only use the authenticated backend. Misconfiguration fails closed. */
import type { ZebServices } from './adapters';
import { liveServices } from './live/services';
export function getServices(): ZebServices | null {
  if (process.env.NEXT_PUBLIC_ZEB_MODE !== 'connected') return null;
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) return null;
  try { const u = new URL(base); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) return null; } catch { return null; }
  return liveServices;
}
