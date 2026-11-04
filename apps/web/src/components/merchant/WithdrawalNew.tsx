"use client";
import { useZeb } from '@/providers/ZebProvider';
import { MerchantPageHeader } from '@/components/layout/AppShell';
import { Callout } from '@/components/ui/Blocks';
import { ButtonLink } from '@/components/ui/Button';
export function WithdrawalNew() {
 const {live}=useZeb();
 return <><MerchantPageHeader title="Withdrawals" description="Real withdrawals require verified reserves and an authorized payout provider." />
 <Callout tone="warning" title="Withdrawals unavailable">{live?.config?.environment === 'testnet' ? 'Testnet TAZ has no redeemable INR value. Your testnet receipts remain available in Activity.' : 'Independent reserve and settlement verification is not available. No withdrawal can be submitted.'}</Callout>
 <ButtonLink href="/app/transactions" variant="secondary" className="mt-4">View activity</ButtonLink></>;
}
