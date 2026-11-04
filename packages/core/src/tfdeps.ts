/** Build the TinyFish rail dependencies from config (server/worker only). */
import { createTinyFishPort, validateP2PWebConfig } from "@zeb/providers";
import type { CoreContext } from "./context";
import { SimulatedTinyFishPort } from "./tfsim";
import type { TfDeps } from "./tfpayouts";

export async function buildTfDeps(ctx: CoreContext, opts: { simulated?: boolean } = {}): Promise<TfDeps> {
  const tf = ctx.cfg.tinyfish;
  if (ctx.env === "demo" && (opts.simulated ?? !tf.apiKey)) {
    const web = validateP2PWebConfig(tf.startUrl ?? "https://app.p2p.me/", tf.extraOrigins, tf.profileId);
    return { web, port: new SimulatedTinyFishPort(ctx.db, ctx.env, { decryptVpa: (id, ct) => ctx.envelope.open(ct, `payout_commands:${id}:vpa`) }) };
  }
  const web = tf.startUrl ? validateP2PWebConfig(tf.startUrl, tf.extraOrigins, tf.profileId) : null;
  const port = tf.apiKey ? await createTinyFishPort(tf.apiKey) : null;
  return { port, web };
}
