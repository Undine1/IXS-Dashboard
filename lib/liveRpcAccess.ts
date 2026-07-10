import { timingSafeEqual } from 'crypto';

export const LIVE_RPC_TOKEN_HEADER = 'x-ixs-live-rpc-token';

// Live RPC reads bypass both the committed snapshot and the CDN. Keep that
// operational escape hatch private so an arbitrary visitor cannot turn a
// cheap dashboard request into an uncached RPC fan-out.
export function isLiveRpcRequestAuthorized(request: Request): boolean {
  const expected = String(process.env.RPC_LIVE_READ_TOKEN || '').trim();
  const supplied = String(request.headers.get(LIVE_RPC_TOKEN_HEADER) || '').trim();

  if (!expected || !supplied) return false;

  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
