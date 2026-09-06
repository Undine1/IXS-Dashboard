export function poolLogFixture(log: { transactionHash: string; logIndex: string; data: string }, filter: {
  fromBlock: string; address: string; topics: Array<string | null>;
}) {
  const pairTopic = filter.topics[1] || filter.topics[2];
  return {
    ...log,
    data: `0x${log.data.slice(2).padStart(64, '0')}`,
    blockNumber: filter.fromBlock,
    blockHash: `0x${BigInt(filter.fromBlock).toString(16).padStart(64, '0')}`,
    address: filter.address,
    topics: [filter.topics[0], pairTopic, pairTopic],
    removed: false,
  };
}
