/**
 * Service registry. Demo mode -> local demo adapters.
 * Connected mode -> live adapters backed by the Zeb Scan API, ONLY when NEXT_PUBLIC_API_BASE_URL is
 * configured. Without it, connected mode returns `null` and the UI shows a clear "not connected"
 * state with every money action disabled. There is deliberately NO fallback from connected to demo.
 */
import { getOperationMode } from "@/config/mode";
import type { ZebServices } from "./adapters";
import { demoServices } from "./demo/services";
import { liveServices } from "./live/services";

export function getServices(): ZebServices | null {
  if (getOperationMode() === "demo") return demoServices;
  if (process.env.NEXT_PUBLIC_ZEB_MODE !== "connected") return null;
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return null;
  } catch {
    return null;
  }
  return liveServices;
}
