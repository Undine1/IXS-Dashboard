import { NextResponse } from 'next/server';
import { isLiveRpcRequestAuthorized } from '@/lib/liveRpcAccess';
import { getVaultTvl } from '@/lib/vaultTvlService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const forceFresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('fresh') === 'true';

    if (forceFresh && !isLiveRpcRequestAuthorized(req)) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const { payload, healthy } = await getVaultTvl({ forceFresh });
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
    console.error('[vault TVL API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch vault TVL' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
