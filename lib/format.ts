// BIP-177: the base unit is "bitcoin", written as an integer with the ₿ symbol.
// What used to be called 1,000 sats is ₿1,000.
export function formatBitcoin(amount: number | bigint): string {
  return `₿${amount.toLocaleString('en-US')}`;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
