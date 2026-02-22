const fetch = globalThis.fetch || require('node-fetch');
const url = process.env.ALCHEMY_POLYGON || process.env.POLYGON_RPC;
if (!url) {
  console.error('No RPC URL found in ALCHEMY_POLYGON or POLYGON_RPC');
  process.exit(1);
}
const RANGE = parseInt(process.env.RANGE || '1', 10);
(async ()=>{
  try {
    console.log('Using RPC:', url, 'RANGE:', RANGE);
    // eth_blockNumber
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    });
    const bn = await res.json();
    console.log('eth_blockNumber ->', JSON.stringify(bn));

    const blockHex = bn.result;
    const blockNum = BigInt(blockHex);
    const from = blockNum - BigInt(RANGE);
    const to = blockNum - 1n;
    const fromHex = '0x' + from.toString(16);
    const toHex = '0x' + to.toString(16);
    const topicTransfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const poolAddr = '0x000000000000000000000000d093a031df30f186976a1e2936b16d95ca7919d6';

    console.log(`Probing getLogs from ${fromHex} to ${toHex} (blocks=${RANGE})`);

    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{
          address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
          fromBlock: fromHex,
          toBlock: toHex,
          topics: [topicTransfer, poolAddr]
        }]
      })
    });
    const logs = await res.json();
    console.log('eth_getLogs ->', JSON.stringify(logs));
  } catch (err) {
    console.error('Probe error', err);
    process.exit(2);
  }
})();
