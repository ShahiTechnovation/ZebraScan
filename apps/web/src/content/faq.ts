export interface FaqItem {
  q: string;
  a: string;
  group: "Paying" | "Merchants" | "Privacy & safety" | "Settlement";
}

export const FAQ: FaqItem[] = [
  {
    group: "Paying",
    q: "Do merchants need the app?",
    a: "Not for Scan & Pay. You scan an ordinary supported UPI QR and the receiver is paid in INR through a payout provider — they don't need a Zeb Scan account. Merchants only sign up if they want their own ZEC checkout: the QR Terminal, a Counter QR or Payment Links.",
  },
  {
    group: "Paying",
    q: "Who receives INR?",
    a: "With Scan & Pay, the UPI ID encoded in the QR (or the one you typed) is the intended receiver. A P2P liquidity provider sends the INR to that UPI ID after your ZEC is verified. With merchant checkouts, the merchant receives an INR-denominated platform credit and withdraws it to their registered UPI-linked account later.",
  },
  {
    group: "Privacy & safety",
    q: "How does shielded ZEC work?",
    a: "A shielded Zcash transaction hides the sender, receiver and amount from public chain observers. Zeb Scan's receiving wallet can still see payments sent to its own addresses — that's how deposits are verified. Shielded payments are not the same as anonymity: payout providers and banks still see the fiat side of the transfer.",
  },
  {
    group: "Settlement",
    q: "Does a received ZEC transaction mean the UPI payment is complete?",
    a: "No. A verified ZEC deposit only starts the payout. The INR transfer is complete only when the payout provider confirms it. Until then you'll see stages such as Order queued, LP matching, USDC escrow and INR processing.",
  },
  {
    group: "Merchants",
    q: "What is the merchant balance?",
    a: "It's an INR-denominated platform balance that represents what Zeb Scan owes the merchant for verified ZEC payments. It is not a bank deposit and it is not money in your bank account. You withdraw it to your registered UPI-linked account through a payout provider.",
  },
  {
    group: "Merchants",
    q: "Why is there a cooldown?",
    a: "New credits are locked for a period before they can be withdrawn. This gives time for payment exceptions, disputes and treasury rebalancing. In this demo the example policy is 15 days; a live service would publish its actual policy.",
  },
  {
    group: "Settlement",
    q: "What happens if a payout fails?",
    a: "The payment moves to a recovery state. For Scan & Pay, the payout can be retried with another provider or the ZEC refunded. For merchant withdrawals, the reserved amount is restored to the available balance through an explicit recovery step — it is never double-debited.",
  },
  {
    group: "Paying",
    q: "Can I get a refund?",
    a: "Underpaid, overpaid and late payments are held for recovery rather than discarded, and can be refunded to a ZEC address you provide. Refunds for completed purchases are between you and the merchant. In this demo, refunds are simulated.",
  },
  {
    group: "Privacy & safety",
    q: "What about KYC?",
    a: "A live service would have to follow the identity and payment-service rules that apply to it and to its payout providers. This demo does not collect identity documents, and it does not claim any regulatory licence or exemption.",
  },
  {
    group: "Settlement",
    q: "Is it guaranteed instant?",
    a: "No. ZEC needs confirmations, and INR payouts depend on a liquidity provider and the banking network. Most steps are quick, but timing is not guaranteed.",
  },
  {
    group: "Paying",
    q: "Which UPI QR codes are supported?",
    a: "Standard upi://pay QR codes that include a receiver UPI ID. Some merchant dynamic or signed QR codes may not be supported. Zeb Scan never opens or follows links inside a QR — it only reads the payment fields and shows them to you to confirm.",
  },
  {
    group: "Privacy & safety",
    q: "Is this live?",
    a: "No. This build is a demonstration. Payments, quotes, deposits and payouts are simulated and labelled as such. Do not send real ZEC to anything shown here.",
  },
];
