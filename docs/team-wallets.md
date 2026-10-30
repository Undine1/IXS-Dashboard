# Robinhood address directory

The `/team` page is a static, reviewed directory. It has no RPC or indexing job and does not contribute to TVL, balances, holder rankings or fee calculations. `lib/teamWallets.ts` holds the curated roles and evidence links; `data/team_robinhood_allocations.json` preserves the 30 second-hop allocation transfers.

## Review scope and evidence

Reviewed at Robinhood Chain block **101622845**, **2026-10-30 09:27:42 UTC**, chain ID **4663**. Public sources were the [official migration site](https://robinhood.ixs.finance/), verified source/constructor arguments and indexed logs on [Robinhood Blockscout](https://robinhoodchain.blockscout.com), and pinned `eth_call` / `eth_getCode` reads from `https://rpc.mainnet.chain.robinhood.com`.

The review followed token and migration creation, their initial and current owners, the genesis distribution, the three allocation distributors' direct recipients, migration/liquidity funding, and the Arrakis vault/module/hook relationships. The pool ID is a bytes32 identifier, never an address or an additional token balance.

`data/team_robinhood_roles.json` stores the raw owner/pending-owner and vault owner/depositor/module/manager calls. Every read used block tag `0x60ea43d`. The verified source and constructor links on each card supplement these pinned reads; explorer read-contract views may show a later state. Address kinds were checked with explorer metadata and pinned code reads for the allocation recipients and operational wallets.

The allocation transfer records were retrieved with Blockscout's indexed logs API for the native token, filtering Transfer topic0 and the sender topic1 through the review block. Each distributor had ten outgoing transfers; the genesis wallet had ten. These results were below the endpoint result limit. The recorded amount is a historical transfer, not a current holding. Thirty recipients received 10 × 30M, 10 × 20M and 10 × 20M IXS. These sums describe separate paths, not a new dashboard aggregate.

## Attribution limits

- A verified role means an observed contract role, constructor parameter or deployment sender. It does not identify the natural person behind the wallet.
- Transfer evidence establishes a funding/allocation relationship, not common control. Do not label recipients as employees, team-owned reserves or vesting contracts from amounts alone.
- The funding wallet's operational transfers are verified, but its private owner and formal treasury designation are not.
- Arrakis manager, hook, factory and ownership NFT, Uniswap PoolManager, and bridged legacy IXS are shared infrastructure. Do not count them as team-owned assets.
- This is not an exhaustive list of private wallets. Arbitrary later counterparties, router activity, shared factories and the third-party vault deployment caller are not enough to infer IXS ownership.
- Roles, proxy implementations and balances may change. Keep the review date visible; do not present this snapshot as live ownership.

## Updating

Choose a single review block, reuse cached/indexed evidence, and batch public reads. Verify source contracts and current role getters before changing labels. Retain transaction evidence for additions, check address uniqueness across categories, and keep infrastructure and transfer-only links distinguishable. Update the snapshot timestamp, role evidence and tests together. No credentials or browser-triggered RPC calls are needed.
