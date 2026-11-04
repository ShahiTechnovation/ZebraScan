/**
 * DEMO ONLY: a simulated TinyFish port that behaves like an authenticated P2P.me account whose
 * orders complete. Every observation is fabricated for the DEMO environment and the core refuses
 * a simulated port anywhere else (`railReady`). It exists so the full payout state machine,
 * approval flow and ledger can be exercised without real money.
 */
import { maybeOne, type Db } from "@zeb/db";
import { DomainError, type Environment } from "@zeb/domain";
import { formatInrPaise, formatUsdcMicros, type TfQueueParams, type TfRun, type TinyFishPort } from "@zeb/providers";

interface SimRun {
  run: TfRun;
  readyAt: number;
}

export class SimulatedTinyFishPort implements TinyFishPort {
  readonly kind = "simulated" as const;
  private runs = new Map<string, SimRun>();
  private n = 0;
  constructor(
    private db: Db,
    env: Environment,
    private opts: { latencyMs?: number; origin?: string; decryptVpa?: (payoutId: string, ct: string) => Promise<string> } = {},
  ) {
    if (env !== "demo") throw new DomainError("SYSTEM_CONFIG", "SimulatedTinyFishPort is only permitted in DEMO");
  }

  async queue(p: TfQueueParams) {
    const id = `sim_run_${++this.n}_${Date.now().toString(36)}`;
    const origin = this.opts.origin ?? new URL(p.url).origin;
    const ref = /payout-?([a-z]{2,5}_[0-9a-z]+)|payout: (pay_[0-9a-z]+)|Reference (pay_[0-9a-z]+)/.exec(p.goal);
    const payoutId = ref?.[1] ?? ref?.[2] ?? ref?.[3] ?? /pay_[0-9a-z]{20,}/.exec(p.goal)?.[0] ?? null;
    let result: Record<string, unknown>;
    if (/read-only capability check/.test(p.goal)) {
      result = { account_authenticated: true, login_page_shown: false, account_identifier: "demo-operator", pay_ui_available: true, sell_ui_available: true, visible_usdc_balance: "25000.00", visible_limits: "", wallet_signature_required: false, blocker: "", observed_url: `${origin}/` };
    } else {
      const cmd = payoutId ? await maybeOne<{ id: string; recipient_vpa_ct: string; requested_inr_paise: string; max_usdc_debit_micros: string }>(this.db, `SELECT id, recipient_vpa_ct, requested_inr_paise, max_usdc_debit_micros FROM payout_commands WHERE id=$1`, [payoutId]) : null;
      const vpa = cmd && this.opts.decryptVpa ? await this.opts.decryptVpa(cmd.id, cmd.recipient_vpa_ct) : "unknown@unknown";
      const inr = cmd ? `INR ${formatInrPaise(BigInt(cmd.requested_inr_paise))}` : "";
      const usdc = cmd ? `${formatUsdcMicros((BigInt(cmd.max_usdc_debit_micros) * 98n) / 100n)} USDC` : "";
      if (/read-only order reconciliation/.test(p.goal)) {
        result = { order_found: true, provider_order_id: `SIM-${cmd?.id.slice(-8) ?? "x"}`, provider_order_status: "COMPLETED", visible_recipient: vpa, visible_inr: inr, visible_usdc: usdc, provider_reference: "", observed_url: `${origin}/orders`, blocker: "" };
      } else {
        result = { action: "submitted", submitted: true, final_url: `${origin}/orders`, provider_order_id: `SIM-${cmd?.id.slice(-8) ?? "x"}`, visible_recipient: vpa, visible_inr: inr, visible_usdc: usdc, provider_order_status: "PLACED", blocking_issue: "", evidence_summary: "DEMO simulated order" };
      }
    }
    const now = new Date().toISOString();
    this.runs.set(id, { run: { run_id: id, status: "COMPLETED", goal: p.goal, created_at: now, started_at: now, finished_at: now, num_of_steps: 1, result, error: null }, readyAt: Date.now() + (this.opts.latencyMs ?? 0) });
    return { run_id: id, error: null };
  }

  async get(runId: string): Promise<TfRun> {
    const r = this.runs.get(runId);
    if (!r) throw new DomainError("NOT_FOUND", "simulated run not found");
    if (Date.now() < r.readyAt) return { ...r.run, status: "RUNNING", result: null };
    return r.run;
  }

  async listByGoal(goalContains: string): Promise<TfRun[]> {
    return [...this.runs.values()].filter((r) => r.run.goal?.includes(goalContains)).map((r) => r.run);
  }
}
