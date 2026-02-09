# Blockchain Dashboard

A production-ready dashboard that tracks IXS token burns and TVL across Ethereum, Polygon, and Base. Data is gathered via on-chain reads (Alchemy JSON-RPC eth_call), and pool TVL is computed from Uniswap V2-style pair reserves. The system intentionally does not use external fallback prices — unknown prices are derived from on-chain price-source pools only, and if a price cannot be derived the UI/API surface shows $0 to surface the issue.

**Status:** Working prototype with multi-chain support, IXS price derived from on-chain pools, server-side caching, and a table-based UI for burn stats and TVL.

**Repository:** [blockchain-dashboard](README.md)

**Quick Links**
- **App entry:** [app/page.tsx](app/page.tsx)
- **API: pools:** [app/api/pools/route.ts](app/api/pools/route.ts)
- **API: burn stats:** [app/api/burnStats/route.ts](app/api/burnStats/route.ts)
- **Key components:** [components/BurnStats.tsx](components/BurnStats.tsx), [components/TransactionList.tsx](components/TransactionList.tsx)
- **Blockchain helpers:** [lib/blockchainService.ts](lib/blockchainService.ts), [lib/web3Service.ts](lib/web3Service.ts)

---

**Table of contents**
- Project overview
- Architecture and design decisions
- Tech stack
- Prerequisites
- Environment variables
- Run locally
- API reference
- Pool configuration and price sourcing rules
- How to add a new chain or pool
- Debugging and validation
- Deployment notes
- Known limitations and safety
- Contributing / Next steps

---

Project overview
- Purpose: Provide a secure, auditable dashboard that shows IXS token burns and the USD TVL of selected pools across supported networks.
- Data sources: On-chain reads via Alchemy JSON-RPC (eth_call). No external price fallbacks are used in production; prices are derived from on-chain pools where possible.

Architecture and design decisions
- Server-side APIs (Next.js app routes) perform on-chain eth_call reads for ERC‑20 tokens and Uniswap V2-style pairs (token0/token1/decimals/getReserves).
- Price derivation: If a pool contains a token with a known USD price (a designated price-source pool such as IXS‑USDC), the unknown token's USD price is derived from reserve ratios. Derived prices are propagated to dependent pools processed later.
- Pools are processed sequentially; price-source pools MUST be listed before pools that depend on them.
- Caching: API responses use short server-side caching (s-maxage=3600) to reduce RPC usage.

Tech stack
- Next.js (app directory) + TypeScript
- Tailwind CSS for styling
- Ethers/JSON-RPC style on-chain calls implemented in lib/ (simple eth_call payloads)
- Simple server-side HTTP caching via response headers

Prerequisites
- Node.js 18+ and npm
- An Alchemy account with API key configured for the networks you plan to query

Environment variables
Create a `.env.local` file in the project root with at least the following variables set:

- `ALCHEMY_API_KEY` — Your Alchemy API key used to form network RPC endpoints.
- `NEXT_PUBLIC_POLYGON_TOKEN_ADDRESS` — (project-specific) token address for Polygon if used by UI components.
- `NEXT_PUBLIC_BASE_TOKEN_ADDRESS` — (project-specific) token address for Base if used by UI components.

Note: The server code constructs provider endpoints for networks (Ethereum, Polygon, Base) using the above Alchemy key. Do not commit `.env.local` to source control.

Run locally
1. Install dependencies

```bash
npm ci
```

2. Start dev server

```bash
npm run dev
```

3. Build (for production test)

```bash
npm run build
npm start
```

4. Verify API endpoints (examples)

PowerShell (example used during development):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/pools -UseBasicParsing | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://localhost:3000/api/burnStats -UseBasicParsing | ConvertTo-Json -Depth 5
```

curl examples:

```bash
curl http://localhost:3000/api/pools
curl http://localhost:3000/api/burnStats
```

API reference
- `GET /api/pools` — Returns computed pools with USD `value` fields. Pools are valued by reading on-chain pair reserves and applying on-chain-derived prices when available. If a pool's USD price cannot be derived, `value` will be `0`.
- `GET /api/burnStats` — Returns aggregated burn stats for IXS burn addresses (server-calculated from on-chain data and configured burn addresses).

Pool configuration and price sourcing rules
- Pools are configured in `app/api/pools/route.ts` as a constant list (often named `POOLS`). Each pool entry should include at minimum:
  - `name`: human-friendly name (e.g., `IXS-USDC`).
  - `network`: chain identifier (e.g., `ethereum`, `polygon`, `base`).
  - `address`: pair contract address.
  - `type`: optional label for UI grouping (e.g., `RWA`, `Crypto`).

- Price sourcing rules:
  - Choose at least one on-chain price-source pool per chain that links a token to a USD-stable token (e.g., USDC, USDT) or another known USD peg.
  - Ensure price-source pools are placed earlier in the `POOLS` array so their derived USD prices propagate to dependent pools processed later.
  - The system will not call external price services in production. If no price-source exists for a chain, the dependent pools will show USD `0`.

How to add a new chain or pool
1. Add the pool object to the `POOLS` list in [app/api/pools/route.ts](app/api/pools/route.ts). Place price-source pools first.
2. Ensure the Alchemy RPC endpoint for the new chain is supported by your `ALCHEMY_API_KEY` and that the chain key/name is handled by the provider selection logic in `lib/web3Service.ts` or `lib/blockchainService.ts`.
3. If the chain has no on-chain USD price source, add a pool that pairs the project token with a stable token (USDC/USDT) to act as the price source.
4. Restart the server and test `GET /api/pools`.

Debugging and validation
- The project previously had temporary debug helpers used during development. In production code there should be no debug-only endpoints enabled publicly.
- To inspect why a pool returns `0`:
  1. Confirm the pool contract address is correct and the network is supported.
 2. Confirm the pool was processed after its price-source pool (ordering in `POOLS`).
 3. Check server logs for RPC errors (timeouts, malformed responses). Typical issues include rate-limits or incorrect RPC endpoints.
 4. If needed, temporarily enable/add logging inside `app/api/pools/route.ts` to return token0/token1, decimals, and raw reserves for troubleshooting — revert the logging after debugging.

Deployment notes
- Build as a standard Next.js app. When deploying to platforms that support Next.js (Vercel, Netlify with Next, AWS, etc.), ensure env vars are configured and that the platform allows the serverless functions to make outbound requests to Alchemy.
- Rate-limits: Monitor RPC usage on Alchemy. Consider adding request batching, more aggressive caching, or an intermediate caching layer (Redis) for production.

Known limitations and safety
- No external/fallback price sources: This is intentional to avoid stale or rate-limited third-party prices. The trade-off is manual configuration of on-chain price-source pools per chain.
- The API shows `$0` for values when a price cannot be derived — this is a signal that manual operator action is required.
- For heavy production traffic, add persistent caching and quota protection to avoid exceeding Alchemy rate limits.

Contributing / Next steps
- Add runtime validation that warns (or fails) when pools exist for a chain but no price-source pool is configured.
- Add a small `README` section under `app/api/pools/route.ts` describing the expected `POOLS` entry shape and recommended ordering.
- Add end-to-end tests that spin up a local dev server and validate API responses against mocked RPC data.

If you want, I can also:
- Add the runtime check that warns when no price source is configured for a chain.
- Add a sample `POOLS` example block directly into `app/api/pools/route.ts` with comments.

---

File locations to review
- [app/api/pools/route.ts](app/api/pools/route.ts)
- [app/api/burnStats/route.ts](app/api/burnStats/route.ts)
- [components/BurnStats.tsx](components/BurnStats.tsx)
- [lib/blockchainService.ts](lib/blockchainService.ts)

Contact
- If you want me to add the runtime validation or a POOLS schema example, tell me which behavior you prefer and I will update the code and tests.


A modern, real-time blockchain transaction monitoring and analytics platform built with Next.js, TypeScript, and Tailwind CSS.

## Features

- **Real-time Transaction Display**: Monitor blockchain transactions as they occur
- **Advanced Analytics**: View transaction trends with interactive charts
- **Transaction Filtering**: Filter transactions by status (success/failed/pending)
- **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- **Dark Mode Support**: Built-in dark/light theme switching
- **Statistics Dashboard**: Quick overview of key metrics including success rates and gas prices
- **Type-Safe**: Full TypeScript support for robust development

## Technology Stack

- **Framework**: [Next.js 16+](https://nextjs.org) with App Router
- **Language**: TypeScript
- **Styling**: [Tailwind CSS](https://tailwindcss.com)
- **Charts**: [Recharts](https://recharts.org)
- **Blockchain**: [Ethers.js](https://docs.ethers.org) for blockchain interaction
- **State Management**: [Zustand](https://github.com/pmndrs/zustand)
- **HTTP Client**: [Axios](https://axios-http.com)

## Project Structure

```
blockchain-dashboard/
├── app/
│   ├── page.tsx              # Main dashboard page
│   ├── layout.tsx            # Root layout
│   └── globals.css           # Global styles
├── components/
│   ├── Dashboard.tsx         # Main dashboard container
│   ├── TransactionList.tsx   # Transaction table
│   ├── TransactionChart.tsx  # Chart visualization
│   ├── StatCards.tsx         # Statistics cards
│   └── Filter.tsx            # Filter controls
├── lib/
│   ├── blockchainService.ts  # Blockchain API integration
│   ├── store.ts              # Zustand state management
│   └── utils.ts              # Utility functions
├── types/
│   └── index.ts              # TypeScript type definitions
└── public/                   # Static assets
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

1. Navigate to the project directory:
```bash
cd blockchain-dashboard
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:

Create a `.env.local` file in the project root:
```env
NEXT_PUBLIC_BLOCKCHAIN_API=https://api.etherscan.io/api
NEXT_PUBLIC_ETHERSCAN_API_KEY=your_etherscan_api_key_here
```

Get your Etherscan API key from [https://etherscan.io/apis](https://etherscan.io/apis)

### Running the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

### Building for Production

```bash
npm run build
npm start
```

## Key Components

### TransactionList
Displays blockchain transactions in an organized table format with:
- Transaction hash (truncated)
- Sender and recipient addresses
- Transaction value in ETH
- Status indicator (success/failed/pending)

### TransactionChart
Interactive line chart showing:
- Transaction values over time
- Gas price trends
- Hover tooltips for detailed information

### StatCards
Summary statistics including:
- Total transaction count
- Success rate percentage
- Average gas price
- Total value transferred

### Filter
Controls for filtering transactions:
- Status-based filtering (All, Success, Failed, Pending)
- Expandable for additional filter options

## API Integration

The dashboard uses the Etherscan API to fetch real blockchain data. Key functions:

- `fetchLatestTransactions()`: Retrieves the latest transactions
- `getBlockchainStats()`: Calculates aggregate statistics
- Automatic refresh every 30 seconds

## Type Definitions

```typescript
interface Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  blockNumber: number;
  timestamp: number;
  status: 'pending' | 'success' | 'failed';
}

interface BlockchainStats {
  totalTransactions: number;
  averageGasPrice: string;
  totalValue: string;
  successRate: number;
}
```

## Development Guidelines

- Use TypeScript for type safety
- Follow React hooks patterns for state management
- Keep components modular and reusable
- Maintain semantic HTML structure
- Implement proper error handling
- Test responsive design across devices

## Troubleshooting

### No transactions displaying
- Verify Etherscan API key is correct
- Check environment variables are loaded
- Ensure network connectivity

### Build errors
- Run `npm install` to ensure all dependencies are installed
- Clear `.next` folder and rebuild: `rm -rf .next && npm run build`

## Future Enhancements

- [ ] Multiple blockchain network support (Polygon, Arbitrum, etc.)
- [ ] Advanced filtering and search
- [ ] Transaction details modal
- [ ] User wallet tracking
- [ ] Export transaction data to CSV
- [ ] WebSocket integration for real-time updates
- [ ] Gas price predictions

## License

This project is open source and available under the MIT License.

## Support

For issues or questions, please open an issue in the repository.

---

**Recent changes / developer notes**

- Fix: `components/BurnStats.tsx`
  - Reworked how centered numeric values and their suffixes are positioned to avoid overlap on small screens.
  - Replaced fragile pixel-based math with an inline `relative` wrapper and an absolutely-positioned suffix anchored to the right of the number. This prevents the percentage / `IXS` suffix from overlapping the centered numbers on mobile.
  - Also reduced several chain/logo image sizes (`w-8 h-8` -> `w-6 h-6`) for tighter layout.

- Fix: `components/ThemeProvider.tsx`
  - Added a lightweight `ThemeContext` and exported `useTheme()` to maintain compatibility with `components/ThemeToggle.tsx`.
  - The app remains dark-only; `toggleTheme()` is a no-op to preserve the public API without enabling a light theme.

- Fix: `public/images/banner.svg` and `app/page.tsx`
  - Introduced a refined SVG banner matching the dashboard neon/cyan aesthetic, and wired it into the main page. The banner was iteratively refined (semicircle outline removed, plaque removed, neon title retained) to match the look-and-feel.

- Build: Resolved a TypeScript compile error caused by `ThemeToggle` importing a missing `useTheme` export; local `npm run build` now succeeds.

How to verify locally

- Start dev server: `npm run dev` and visit the dashboard on a mobile viewport (Chrome devtools device toolbar) to confirm the `Total Tokens Burned` and `Max Supply` cards no longer overlap.
- Run production build test: `npm run build` — verify the build completes without TypeScript errors.
- API sanity checks: `curl http://localhost:3000/api/burnStats` and `curl http://localhost:3000/api/pools`.

Files touched (recent commits)

- `components/BurnStats.tsx` — layout, mobile fixes, logo sizes
- `components/ThemeProvider.tsx` — ThemeContext + `useTheme`
- `components/ThemeToggle.tsx` — unchanged but now works with `useTheme`
- `public/images/banner.svg` — refined neon title banner
- `app/page.tsx` — uses `banner.svg` (accessible hidden H1 retained)

If you'd like, I can open a short PR with the above changes and a small visual regression checklist (screenshots for desktop / mobile) for review.

