import allocationRecipients from '../data/team_robinhood_allocations.json';

// A reviewed directory, not a live balance feed. See docs/team-wallets.md.
export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com';
export const TEAM_REVIEW = { block: 101622845, asOf: '2026-10-30T09:27:42Z', chainId: 4663 } as const;
export type TeamGroup = 'operational' | 'allocation' | 'infrastructure';
export interface TeamAddress {
  address: string;
  name: string;
  kind: 'wallet' | 'contract';
  group: TeamGroup;
  evidence: 'role' | 'transfer' | 'integration';
  description: string;
  sources: { label: string; url: string }[];
  relatedAddress?: string;
}

export const TEAM_GROUPS: { id: TeamGroup; title: string; description: string }[] = [
  { id: 'operational', title: 'IXS operations', description: 'Contracts and wallets with an observed role in token deployment, migration or liquidity management.' },
  { id: 'allocation', title: 'Allocation wallets', description: 'Genesis distributors and their direct recipients. Transfers establish a link, but do not establish team ownership, an employee allocation or a vesting lock.' },
  { id: 'infrastructure', title: 'Connected protocol infrastructure', description: 'Shared Arrakis, Uniswap and bridge contracts used by IXS. These are not identified as IXS team-owned contracts.' },
];

const token = '0xdcd7face6a1d0bdd0665ea1b0842fc9ce797862b';
const migration = '0x358201f49bb186771d79299802fea636ea1b2a27';
const genesis = '0x3305758cecb4df22cd010f3efdac16ba301ef822';
const vault = '0x23a65cdee846b83cee2bdc2debfea17f8c444370';
const moduleAddress = '0xcf1274cb411798fe925246eb987bd16c3af068b8';
const source = (address: string, label = 'Verified contract') => ({ label, url: `${ROBINHOOD_EXPLORER}/address/${address}?tab=contract` });
const transaction = (hash: string, label = 'Transfer evidence') => ({ label, url: `${ROBINHOOD_EXPLORER}/tx/${hash}` });
const tokenDeployment = transaction('0x7d4d62934e3d5abb46061e1d1b94b0b4e97f66859a91109b0be6c692715ad177', 'Token deployment');
const migrationDeployment = transaction('0x596000a806ce0d051e8300a775de2138aad80882e5ce299492bab19f470ddaf7', 'Migration deployment');
const poolInitialization = transaction('0x680f8b1ed5caf86e9e4fd491d31c7453037ff437a6b8486ed930f43390b31dce', 'Pool initialization');

export const ROBINHOOD_IXS_POOL = {
  id: '0x252827c9712732983d1d720e87ff5f2d875fae840ff128c0331cce0baa6a4bf8',
  manager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  hook: '0xa4e6f5500e88691fdcb289aa0e99067481434880',
  module: moduleAddress,
  source: poolInitialization,
} as const;

const distributors = [
  { address: '0x0bedf89ae9a370782e3e163c3b4b0f318a723cd6', name: '300M allocation distributor', amount: '300 million', childAmount: '30 million', tx: '0x72f320502e4c12db72881dd3e0249244634eacf4c4d2e4a6fa79b0bd192e944a' },
  { address: '0xa3f97a80394ea4b8380646e7d92b3dee37d8533e', name: '200M allocation distributor A', amount: '200 million', childAmount: '20 million', tx: '0xebcfd2ca1bada618bf4a75007694d288c146947008f1f9a5d4a9ede7a9e0dc48' },
  { address: '0x6999d1807698b019aa67629bebdf4c986280d6c1', name: '200M allocation distributor B', amount: '200 million', childAmount: '20 million', tx: '0xb0679771ba1639b8e5b4c882be967c2140f816b82fc0a34da20193597214cf27' },
];

export const TEAM_ADDRESSES: TeamAddress[] = [
  {
    address: token, name: 'IXS token', kind: 'contract', group: 'operational', evidence: 'role',
    description: 'Verified IxsToken contract. Its constructor minted the initial 2.5 billion IXS to the genesis allocation wallet. The owner can pause transfers; the contract has no further mint function.',
    sources: [source(token), tokenDeployment, { label: 'Official migration site', url: 'https://robinhood.ixs.finance/' }],
  },
  {
    address: migration, name: 'Migration contract', kind: 'contract', group: 'operational', evidence: 'role',
    description: 'Verified IxsMigration contract for the bridged legacy token and the new Robinhood IXS token. It pays migrations from a prefunded reserve.',
    sources: [source(migration), migrationDeployment],
  },
  {
    address: '0x26c70c2fc15e70c4dea21fafbdf014e8a8069979', name: 'Token pause admin', kind: 'wallet', group: 'operational', evidence: 'role', relatedAddress: token,
    description: 'Initial owner in the token constructor and the owner() returned at the review block. Controls pause/unpause and ownership transfer. No pending owner was set.',
    sources: [source(token, 'Token ownership / source'), tokenDeployment],
  },
  {
    address: '0x6b27cf95414bd327395c87f302e85d6361799208', name: 'Migration admin', kind: 'wallet', group: 'operational', evidence: 'role', relatedAddress: migration,
    description: 'Initial and observed owner() of the migration contract. Can pause migrations and withdraw unused new-token reserves. No pending owner was set.',
    sources: [source(migration, 'Migration ownership / source'), migrationDeployment],
  },
  {
    address: genesis, name: 'Genesis allocation wallet', kind: 'wallet', group: 'operational', evidence: 'role', relatedAddress: token,
    description: 'Named genesis recipient in the token constructor. Received the initial supply and distributed it to migration, allocation and operational addresses.',
    sources: [source(token, 'Genesis constructor argument'), tokenDeployment],
  },
  {
    address: '0xa24daf66c85d7ef7f5712f107eefcf21b8d974a7', name: 'Token and migration deployer', kind: 'wallet', group: 'operational', evidence: 'role',
    description: 'Sender of both contract-creation transactions. Deployment alone does not grant this wallet the owner role in either contract.',
    sources: [tokenDeployment, migrationDeployment],
  },
  {
    address: '0x5a6900ece8a27dd1bb0c4c58597998d1ab1b472d', name: 'Migration and liquidity funding wallet', kind: 'wallet', group: 'operational', evidence: 'transfer', relatedAddress: genesis,
    description: 'Received 1,599,598,900 IXS from genesis, then funded the migration contract and liquidity vault owner. Its funding role is observed; its private owner and formal treasury designation are unconfirmed.',
    sources: [transaction('0x0cae6abbc474ba125e53147e5f625d03e9150ec06ace65d9fa1f6e98e001a5d5', 'Genesis funding'), transaction('0x5d6186d6b86c77875bd064d48a0cffd18de7eb0269fcf1272e50377dad4d9d09', 'Migration funding'), transaction('0xd16becc579614e200ade8d775e69fc9596199dfe9ee9557bb975785839906e84', 'Liquidity funding')],
  },
  {
    address: '0x857ff825254755a6fbe22125029a6754e8c9cedd', name: 'Liquidity vault owner and depositor', kind: 'wallet', group: 'operational', evidence: 'role', relatedAddress: vault,
    description: 'Returned by the vault owner() and the sole address in depositors() at the review block. Also funded the IXS liquidity module.',
    sources: [source(vault, 'Vault ownership / depositors'), transaction('0xe2b5a8bd658ac67924dc1724f4f77ac1930bc981fb9be76b57572ebef8fe67b1', 'Module funding')],
  },
  {
    address: vault, name: 'IXS liquidity vault', kind: 'contract', group: 'operational', evidence: 'role', relatedAddress: moduleAddress,
    description: 'ArrakisMetaVaultPrivate for the IXS liquidity position. Ownership is represented by the Arrakis private-vault NFT; its module() points to the IXS liquidity module.',
    sources: [source(vault), transaction('0x68ce208a9707508d188b12df25bfe6e716bd9551e3afdb1e8b628e721eeb2158', 'Vault creation')],
  },
  {
    address: moduleAddress, name: 'IXS liquidity module', kind: 'contract', group: 'operational', evidence: 'role', relatedAddress: vault,
    description: 'Arrakis module linked by the vault and pool hook. Holds the pool liquidity positions. A beacon proxy using the verified UniV4StandardModuleV2Private implementation at review time.',
    sources: [source(moduleAddress, 'Module proxy'), source('0x2b0747ec0a369146debb3b42e46b511f106ad36a', 'Module implementation'), source(vault, 'Vault module reference')],
  },
  ...distributors.map((distributor): TeamAddress => ({
    address: distributor.address, name: distributor.name, kind: 'wallet', group: 'allocation', evidence: 'transfer', relatedAddress: genesis,
    description: `Received ${distributor.amount} IXS from genesis and sent ${distributor.childAmount} IXS to each of ten recipients. Allocation purpose and wallet ownership are unconfirmed.`,
    sources: [transaction(distributor.tx, 'Genesis allocation')],
  })),
  ...allocationRecipients.map((recipient, index): TeamAddress => ({
    address: recipient.address, name: `${recipient.amount === '30000000' ? '30M' : '20M'} allocation recipient ${index + 1}`, kind: 'wallet', group: 'allocation', evidence: 'transfer', relatedAddress: recipient.parent,
    description: `Received ${recipient.amount === '30000000' ? '30 million' : '20 million'} IXS from ${distributors.find((item) => item.address === recipient.parent)?.name ?? 'an allocation distributor'}. Historical transfer amount, not a current balance. Team ownership is unconfirmed.`,
    sources: [transaction(recipient.tx, 'Allocation transfer')],
  })),
  {
    address: '0x2e6e879648293e939aa68ba4c6c129a1be733bda', name: 'Arrakis manager', kind: 'contract', group: 'infrastructure', evidence: 'integration', relatedAddress: vault,
    description: 'Manager returned by the IXS vault. Shared Arrakis management infrastructure, not identified as an IXS treasury or team wallet.',
    sources: [source(vault, 'Vault manager reference'), source('0x2e6e879648293e939aa68ba4c6c129a1be733bda')],
  },
  {
    address: ROBINHOOD_IXS_POOL.hook, name: 'Arrakis private pool hook', kind: 'contract', group: 'infrastructure', evidence: 'integration', relatedAddress: moduleAddress,
    description: 'Verified ArrakisPrivateHook used by the IXS/native ETH pool. Associates the pool with its liquidity module. Shared Arrakis infrastructure.',
    sources: [source(ROBINHOOD_IXS_POOL.hook), poolInitialization],
  },
  {
    address: ROBINHOOD_IXS_POOL.manager, name: 'Uniswap v4 PoolManager', kind: 'contract', group: 'infrastructure', evidence: 'integration',
    description: 'Shared Uniswap singleton that contains the IXS/native ETH pool alongside other pools. Its aggregate token balance is not an IXS team balance.',
    sources: [poolInitialization, source(ROBINHOOD_IXS_POOL.manager)],
  },
  {
    address: '0x91d5d2c999c35ce061fd4967e6764cdd9cf1b3e1', name: 'Bridged legacy IXS token', kind: 'contract', group: 'infrastructure', evidence: 'integration', relatedAddress: migration,
    description: 'Legacy IXS accepted by the migration contract. Uses the bridge StandardArbERC20 implementation behind a beacon proxy; separate from the new native token.',
    sources: [source(migration, 'Migration token arguments'), source('0x91d5d2c999c35ce061fd4967e6764cdd9cf1b3e1', 'Bridge token proxy')],
  },
  {
    address: '0x820fb8127a689327c863de8433278d6181123982', name: 'Arrakis vault factory', kind: 'contract', group: 'infrastructure', evidence: 'integration', relatedAddress: vault,
    description: 'Factory called to create the IXS private liquidity vault. Shared Arrakis deployment infrastructure.',
    sources: [transaction('0x68ce208a9707508d188b12df25bfe6e716bd9551e3afdb1e8b628e721eeb2158', 'Vault creation'), source(ROBINHOOD_IXS_POOL.hook, 'Hook factory reference')],
  },
  {
    address: '0x44a801e7e2e073bd8bce4bccf653239fa156b762', name: 'Arrakis private-vault ownership NFT', kind: 'contract', group: 'infrastructure', evidence: 'integration', relatedAddress: vault,
    description: 'NFT contract named in the IXS vault constructor. The vault derives its owner from the holder of the NFT keyed to its address. Shared Arrakis infrastructure.',
    sources: [source(vault, 'Vault constructor / owner implementation')],
  },
];

export function filterTeamAddresses(query: string, group: TeamGroup | 'all'): TeamAddress[] {
  const search = query.trim().toLowerCase();
  return TEAM_ADDRESSES.filter((entry) => (group === 'all' || entry.group === group)
    && (!search || `${entry.address} ${entry.name} ${entry.description} ${entry.relatedAddress ?? ''}`.toLowerCase().includes(search)));
}
