import { ETHEREUM_IXS, ETHEREUM_IXS_POOL } from '../../lib/ethereumPoolsConfig';
import { abiWords, robinhoodResults, aggregateResponse } from './robinhood';

export function ethereumResults(timestamp = Math.floor(Date.now() / 1000)) {
  const results = robinhoodResults(timestamp);
  results[0].returnData = abiWords(2n * 10n ** 18n, 500n * 10n ** 18n, 0, 0, 0, 0, 10n * 2n ** 96n, 0, 1, 1, 0, 0, 0, 0);
  results[3].returnData = abiWords(1);
  return [...results,
    { success: true, returnData: abiWords(100n * 10n ** 18n, 3n * 10n ** 18n, timestamp) },
    { success: true, returnData: abiWords(BigInt(ETHEREUM_IXS.token)) },
    { success: true, returnData: abiWords(BigInt(ETHEREUM_IXS.weth)) },
  ];
}

export const ethereumAggregateResponse = () => aggregateResponse(ethereumResults());
export const ethereumPoolFixture = () => ({
  ...ETHEREUM_IXS_POOL, value: 26_000,
  underlyingPools: [
    { address: ETHEREUM_IXS.v2Pair, protocol: 'uniswap-v2' as const, value: 12_000 },
    { address: ETHEREUM_IXS.poolId, protocol: 'uniswap-v4' as const, value: 14_000 },
  ],
});
