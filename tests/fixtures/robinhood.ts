import { ROBINHOOD } from '../../lib/robinhoodConfig';

export const abiWords = (...values: (number | bigint)[]) =>
  `0x${values.map((value) => BigInt(value).toString(16).padStart(64, '0')).join('')}`;

export function robinhoodResults(timestamp = Math.floor(Date.now() / 1000)) {
  // 100 IXS per ETH; deliberately unbalanced liquidity to catch the invalid
  // v2 shortcut of doubling one reserve for concentrated liquidity.
  return [
    abiWords(2n * 10n ** 18n, 500n * 10n ** 18n, 0, 0, 0, 0, 10n * 2n ** 96n, 0, 1, 1,
      BigInt(ROBINHOOD.hook), 0x880, 0, 1),
    abiWords(100, 2000n * 10n ** 8n, timestamp - 10, timestamp - 10, 100),
    abiWords(8), abiWords(ROBINHOOD.chainId), abiWords(timestamp),
  ].map((returnData) => ({ success: true, returnData }));
}

export function robinhoodVolumePayload(value: unknown = 250) {
  return { pairs: [{ chainId: 'robinhood', dexId: 'uniswap', pairAddress: ROBINHOOD.poolId,
    baseToken: { address: ROBINHOOD.token }, quoteToken: { address: `0x${'0'.repeat(40)}` },
    volume: { h24: value } }] };
}

export function robinhoodAggregateResponse() {
  const tuples = robinhoodResults().map(({ returnData }) =>
    `${abiWords(1, 64, (returnData.length - 2) / 2).slice(2)}${returnData.slice(2)}`);
  let offset = tuples.length * 32;
  const offsets = tuples.map((tuple) => { const current = offset; offset += tuple.length / 2; return current; });
  return `${abiWords(32, tuples.length, ...offsets)}${tuples.join('')}`;
}
