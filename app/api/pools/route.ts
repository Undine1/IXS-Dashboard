import { NextResponse } from 'next/server';
import { isLiveRpcRequestAuthorized } from '@/lib/liveRpcAccess';
import { getPoolsBody } from '@/lib/poolsService';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const debugMode = url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true';
    const forceFresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('fresh') === 'true';

    if ((debugMode || forceFresh) && !isLiveRpcRequestAuthorized(req)) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const { body, healthy } = await getPoolsBody({ debug: debugMode, forceFresh });

    // fresh/debug responses must not stick in the CDN — otherwise the second
    // ?fresh=1 within an hour would get the cached "fresh" response. Degraded
    // payloads (any pool unvalued) get a short TTL so the next visitor retries
    // soon instead of pinning an outage for an hour.
    const cacheControl = debugMode || forceFresh
      ? 'no-store'
      : healthy
        ? 'public, s-maxage=3600, stale-while-revalidate=7200'
        : 'public, s-maxage=60';

    return NextResponse.json(body, {
      status: 200,
      headers: { 'Cache-Control': cacheControl },
    });
  } catch (error) {
    console.error('[pools API] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
