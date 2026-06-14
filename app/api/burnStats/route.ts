import { NextResponse } from 'next/server';
import { hasAnyRpcConfigured } from '@/lib/rpc';
import { getBurnStatsBody } from '@/lib/burnStatsService';

export async function GET(req: Request) {
  try {
    if (!hasAnyRpcConfigured()) {
      console.error('[burnStats API] RPC API keys are not configured');
      return NextResponse.json({ error: 'Service misconfiguration' }, { status: 500 });
    }

    const url = new URL(req.url);
    const forceFresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('fresh') === 'true';

    const { payload, healthy } = await getBurnStatsBody({ forceFresh });

    // fresh responses must not stick in the CDN — otherwise the second
    // ?fresh=1 within an hour would get the cached "fresh" response. Degraded
    // payloads (any null balance) get a short TTL so the next visitor retries
    // soon instead of pinning an outage for an hour.
    const cacheControl = forceFresh
      ? 'no-store'
      : healthy
        ? 'public, s-maxage=3600, stale-while-revalidate=7200'
        : 'public, s-maxage=60';

    return NextResponse.json(payload, {
      status: 200,
      headers: { 'Cache-Control': cacheControl },
    });
  } catch (error) {
    console.error('[burnStats API] Unexpected error:', error);
    return NextResponse.json({ error: 'Failed to fetch burn statistics' }, { status: 500 });
  }
}
