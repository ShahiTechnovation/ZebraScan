/**
 * Service registry. Demo mode → local demo adapters.
 * Connected mode → live adapters backed by the Zeb Scan API, ONLY when NEXT_PUBLIC_API_BASE_URL is
 * configured. Without it, connected mode returns `null` and the UI shows a clear "not connected"
 * state with every money action disabled. There is deliberately NO fallback from connected to demo.
 */
import { getOperationMode } from "@/config/mode";
import type { ZebServices } from "./adapters";
import { demoServices } from "./demo/services";
import { liveServices } from "./live/services";

const liveConfigured = !!process.env.NEXT_PUBLIC_API_BASE_URL;

export function getServices(): ZebServices | null {
  if (getOperationMode() === "demo") return demoServices;
  return liveConfigured ? liveServices : null;
}
