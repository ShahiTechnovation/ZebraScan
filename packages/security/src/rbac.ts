/**
 * Role-based access. Merchant realm and operator realm are separate: an operator role is never
 * granted through a merchant membership, and operator sessions require MFA (enforced in API).
 */
export const MERCHANT_ROLES = ["owner", "finance", "viewer", "support"] as const;
export type MerchantRole = (typeof MERCHANT_ROLES)[number];

export const OPERATOR_ROLES = ["operator", "risk_reviewer", "treasury_approver", "auditor"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export type MerchantPermission =
  | "merchant.read"
  | "merchant.update"
  | "terminal.create"
  | "links.read"
  | "links.write"
  | "balance.read"
  | "withdrawal.request"
  | "withdrawal.cancel"
  | "payout_destination.manage"
  | "support.read"
  | "support.write"
  | "members.manage";

const MATRIX: Record<MerchantRole, readonly MerchantPermission[]> = {
  owner: [
    "merchant.read",
    "merchant.update",
    "terminal.create",
    "links.read",
    "links.write",
    "balance.read",
    "withdrawal.request",
    "withdrawal.cancel",
    "payout_destination.manage",
    "support.read",
    "support.write",
    "members.manage",
  ],
  // finance may request withdrawals only with step-up auth (enforced at the route).
  finance: ["merchant.read", "terminal.create", "links.read", "balance.read", "withdrawal.request", "withdrawal.cancel", "support.read", "support.write"],
  viewer: ["merchant.read", "links.read", "balance.read", "support.read"],
  support: ["merchant.read", "support.read", "support.write"],
};

export function merchantCan(role: MerchantRole, perm: MerchantPermission): boolean {
  return MATRIX[role].includes(perm);
}

export type OperatorPermission = "ops.read" | "ops.pause" | "ops.retry" | "ops.decide" | "ops.approve_treasury" | "ops.audit";
const OPS: Record<OperatorRole, readonly OperatorPermission[]> = {
  operator: ["ops.read", "ops.pause", "ops.retry"],
  risk_reviewer: ["ops.read", "ops.decide"],
  treasury_approver: ["ops.read", "ops.approve_treasury", "ops.decide"],
  auditor: ["ops.read", "ops.audit"],
};
export function operatorCan(role: OperatorRole, perm: OperatorPermission): boolean {
  return OPS[role].includes(perm);
}
