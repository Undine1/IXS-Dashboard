# Blockchain Dashboard

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

