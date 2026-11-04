/**
 * Public demo "I've paid — check" for the operator's MAINNET shielded wallet.
 * Asks the watch-only mainnet zkool watcher (operator's UIVK, incoming-only, cannot spend) whether a
 * shielded note carrying this checkout's memo ("ZEB <checkout id>") has arrived, and how many
 * confirmations it has. Uses a READ-ONLY account-scoped token held server-side (never sent to the
 * browser) and returns only the match for this memo — never the wallet's history.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Note { pool: number; value: number | string; scope: number; memo?: string | null }
interface Tx { txid: string; height: number | null; notes: Note[] }

function zat(v: number | string): bigint {
  const s = typeof v === "number" ? v.toFixed(8) : v;
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const memo = (u.searchParams.get("memo") ?? "").trim();
  const expect = u.searchParams.get("zat") ?? "0";
  if (!/^ZEB [a-z0-9_]{4,40}$/i.test(memo) || !/^\d{1,15}$/.test(expect)) return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  const url = process.env.ZKOOL_MAINNET_URL;
  const token = process.env.ZKOOL_MAINNET_VIEW_TOKEN;
  const account = Number(process.env.ZKOOL_MAINNET_ACCOUNT ?? "1");
  if (!url || !token) return Response.json({ ok: false, error: "mainnet watcher not configured" }, { status: 503 });
  const gql = async <T,>(query: string): Promise<T> => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(45_000), cache: "no-store" });
    const j = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (j.errors?.length) throw new Error(j.errors[0]!.message.slice(0, 120));
    return j.data as T;
  };
  try {
    await gql(`mutation { synchronizeAccount(idAccount: ${account}, fast: false) }`).catch(() => undefined);
    const [tip, txs, mem] = await Promise.all([
      gql<{ currentHeight: number }>(`{ currentHeight }`),
      gql<{ transactionsByAccount: Tx[] }>(`{ transactionsByAccount(idAccount: ${account}) { txid height notes { pool value scope memo } } }`),
      gql<{ unconfirmedByAccount: Tx[] }>(`{ unconfirmedByAccount(idAccount: ${account}) { txid notes { pool value scope memo } } }`).catch(() => ({ unconfirmedByAccount: [] as Tx[] })),
    ]);
    const all = [...(txs.transactionsByAccount ?? []), ...(mem.unconfirmedByAccount ?? []).map((t) => ({ ...t, height: null }))];
    let best: { txid: string; height: number | null; valueZat: bigint } | null = null;
    for (const t of all) {
      for (const n of t.notes ?? []) {
        if (n.scope !== 0 || n.pool === 0 || (n.memo ?? "").trim() !== memo) continue;
        const v = zat(n.value);
        if (!best || (t.height && !best.height)) best = { txid: t.txid, height: t.height && t.height > 0 ? t.height : null, valueZat: v };
      }
    }
    if (!best) return Response.json({ ok: true, zecReceived: false, zecConfirmed: false, confirmations: 0, tip: tip.currentHeight }, { headers: { "cache-control": "no-store" } });
    const confirmations = best.height ? tip.currentHeight - best.height + 1 : 0;
    const enough = best.valueZat >= BigInt(expect);
    return Response.json(
      { ok: true, zecReceived: true, zecConfirmed: confirmations >= 1 && enough, underpaid: !enough, confirmations, receivedZatoshis: best.valueZat.toString(), txid: best.txid, explorer: `https://mainnet.zcashexplorer.app/transactions/${best.txid}`, tip: tip.currentHeight },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ ok: false, error: `watcher unavailable: ${(e as Error).message}` }, { status: 502 });
  }
}
