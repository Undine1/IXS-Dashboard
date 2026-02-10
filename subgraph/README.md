# IXS USDC Subgraph

This folder contains a minimal The Graph subgraph to index USDC `Transfer` events involving the IXS pool contract `0xd093a031df30f186976a1e2936b16d95ca7919d6` on Polygon.

Quick commands (from `subgraph/`):

```bash
# install graph-cli globally if you haven't already
npm install -g @graphprotocol/graph-cli

# generate types from ABIs and schema
npm run codegen

# build the subgraph locally
npm run build

# authenticate (hosted service) and deploy (set env vars GRAPH_API_KEY, GITHUB_USER, SUBGRAPH_NAME)
npm run deploy:auth
npm run deploy
```

GraphQL example (once deployed):

```graphql
query {
  pool(id: "0xd093a031df30f186976a1e2936b16d95ca7919d6") {
    id
    lifetimeVolume
    lastUpdated
  }
}
```

Notes:
- Initial historical indexing may take time. The Hosted Service provides UI for monitoring.
- The mapping increments `Pool.lifetimeVolume` (USDC decimals = 6) on every Transfer where the pool is `from` or `to`.
