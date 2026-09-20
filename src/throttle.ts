// Slows down repeated wrong passwords, by account and by the address the
// attempts come from.
//
// The address bucket is deliberately loose. Many Nigerian phones share one
// address through their network's gateway, so a tight limit would shut out
// a whole street because of one forgetful person. It only bites after a run
// of failures no ordinary person makes, and it never locks anyone out: the
// worst it does is make them wait a minute.
//
// Kept in memory. A restart clears it, which is fine: the account bucket is
// the one that protects a single password, and it is small and fast.

type Bucket = { count: number; until: number; touched: number };

const buckets = new Map<string, Bucket>();

const ACCOUNT_FREE_TRIES = 0;
const ADDRESS_FREE_TRIES = 20;
const MAX_WAIT_MS = 60_000;
const FORGET_AFTER_MS = 30 * 60_000;

function waitFor(count: number, freeTries: number): number {
  if (count <= freeTries) return 0;
  return Math.min(MAX_WAIT_MS, 1_000 * 2 ** Math.min(count - freeTries, 6));
}

function prune(now: number): void {
  for (const [key, b] of buckets) if (b.touched + FORGET_AFTER_MS < now) buckets.delete(key);
}

// How long this account, or this address, must wait before another try.
export function loginWait(account: string, address: string, now = Date.now()): number {
  prune(now);
  const a = buckets.get(`account:${account}`);
  const b = address ? buckets.get(`address:${address}`) : undefined;
  return Math.max(a && a.until > now ? a.until - now : 0, b && b.until > now ? b.until - now : 0);
}

export function recordLoginFailure(account: string, address: string, now = Date.now()): void {
  prune(now);
  const bump = (key: string, freeTries: number): void => {
    const b = buckets.get(key) ?? { count: 0, until: 0, touched: now };
    b.count += 1;
    b.touched = now;
    b.until = now + waitFor(b.count, freeTries);
    buckets.set(key, b);
  };
  bump(`account:${account}`, ACCOUNT_FREE_TRIES);
  if (address) bump(`address:${address}`, ADDRESS_FREE_TRIES);
}

// A right password clears that account. The address keeps its count, so one
// machine working through a list of accounts still slows down.
export function clearLoginFailures(account: string): void {
  buckets.delete(`account:${account}`);
}

export function resetLoginThrottle(): void {
  buckets.clear();
}

export function throttleSize(): number {
  return buckets.size;
}
