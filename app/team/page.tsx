import type { Metadata } from 'next';
import Image from 'next/image';
import SiteTabs from '@/components/SiteTabs';
import TeamDirectory from '@/components/TeamDirectory';
import { ROBINHOOD_EXPLORER, ROBINHOOD_IXS_POOL, TEAM_ADDRESSES, TEAM_REVIEW } from '@/lib/teamWallets';

export const metadata: Metadata = {
  title: 'Team wallets and contracts | IXS Statistics',
  description: 'Evidence-backed directory of IXS operational addresses, allocation links and connected contracts on Robinhood Chain.',
};

export default function TeamPage() {
  return (
    <main className="ixs-dashboard-shell min-h-screen bg-[#0B1120] p-4 md:p-8">
      <div className="ixs-dashboard-container mx-auto max-w-7xl">
        <header className="ixs-dashboard-hero mb-8 rounded-3xl border border-slate-700/60 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 p-6 md:p-8">
          <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-200">
            <Image src="/images/chains/robinhood.jpg" alt="" width={24} height={24} className="rounded-full" />
            Robinhood Chain
          </div>
          <h1 className="text-3xl font-semibold leading-tight text-white md:text-4xl">Team wallets and contracts</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 md:text-base">A public map of IXS deployment, migration and liquidity operations, with the on-chain evidence behind each connection.</p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400">
            <span>{TEAM_ADDRESSES.length} unique addresses</span>
            <span>Reviewed <time dateTime={TEAM_REVIEW.asOf}>30 Oct 2026, 09:27 UTC</time></span>
            <a href={`${ROBINHOOD_EXPLORER}/block/${TEAM_REVIEW.block}`} target="_blank" rel="noopener noreferrer" className="text-cyan-200 underline underline-offset-4">Block {TEAM_REVIEW.block.toLocaleString('en-US')}</a>
          </div>
        </header>

        <SiteTabs active="team" />

        <aside className="mb-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/5 p-5 text-sm leading-6 text-slate-300">
          <p><strong className="text-white">Roles are verified as of the review block.</strong> Wallet identities are not inferred from transfers. Allocation recipients and shared protocol contracts are grouped separately so a connection is not mistaken for team ownership.</p>
          <p className="mt-2 text-slate-400">This is a reviewed snapshot of the deployment, ownership, liquidity and initial allocation paths. It is not an exhaustive list of private wallets. Historical transfers are not current balances and are not added to dashboard totals.</p>
        </aside>

        <TeamDirectory />

        <section aria-labelledby="pool-heading" className="mt-6 rounded-2xl border border-slate-700/60 bg-slate-900/70 p-5 md:p-6">
          <h2 id="pool-heading" className="text-lg font-semibold text-white">IXS/native ETH pool reference</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">This Uniswap v4 pool ID identifies the pool inside the shared PoolManager. It is not a wallet or contract address and is excluded from the address count.</p>
          <p className="mt-3 break-all font-mono text-xs leading-6 text-cyan-200">{ROBINHOOD_IXS_POOL.id}</p>
          <a href={ROBINHOOD_IXS_POOL.source.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm text-cyan-200 underline underline-offset-4">View pool initialization ↗</a>
        </section>
      </div>
    </main>
  );
}
