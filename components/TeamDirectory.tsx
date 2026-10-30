'use client';

import { useState } from 'react';
import { filterTeamAddresses, ROBINHOOD_EXPLORER, TEAM_GROUPS, type TeamAddress, type TeamGroup } from '@/lib/teamWallets';

const evidenceLabels = {
  role: 'On-chain role verified',
  transfer: 'Transfer link - ownership unconfirmed',
  integration: 'Shared infrastructure',
};

function AddressCard({ entry }: { entry: TeamAddress }) {
  return (
    <article id={entry.address} className="min-w-0 rounded-2xl border border-slate-700/70 bg-slate-900/70 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-slate-800 px-2 py-1 text-xs capitalize text-slate-300">{entry.kind}</span>
        <span className={`rounded-md px-2 py-1 text-xs ${entry.evidence === 'role' ? 'bg-emerald-400/10 text-emerald-200' : entry.evidence === 'transfer' ? 'bg-amber-300/10 text-amber-200' : 'bg-slate-700/50 text-slate-300'}`}>
          {evidenceLabels[entry.evidence]}
        </span>
      </div>
      <h3 className="mt-3 text-base font-semibold text-white">{entry.name}</h3>
      <a href={`${ROBINHOOD_EXPLORER}/address/${entry.address}`} target="_blank" rel="noopener noreferrer" className="mt-2 block break-all font-mono text-xs leading-6 text-cyan-200 underline decoration-cyan-300/30 underline-offset-4 hover:text-cyan-100 focus-visible:outline-2 focus-visible:outline-cyan-300" aria-label={`${entry.name} on Robinhood explorer: ${entry.address}`}>
        {entry.address}
      </a>
      <p className="mt-3 text-sm leading-6 text-slate-300">{entry.description}</p>
      {entry.relatedAddress && (
        <p className="mt-3 text-xs leading-5 text-slate-400">
          Related address:{' '}
          <a className="break-all font-mono text-slate-300 underline underline-offset-4 hover:text-white" href={`${ROBINHOOD_EXPLORER}/address/${entry.relatedAddress}`} target="_blank" rel="noopener noreferrer">{entry.relatedAddress}</a>
        </p>
      )}
      <ul aria-label={`Evidence for ${entry.name}`} className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-700/70 pt-3 text-xs">
        {entry.sources.map((item) => (
          <li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer" className="text-cyan-200 underline underline-offset-4 hover:text-white">{item.label} <span aria-hidden="true">↗</span></a></li>
        ))}
      </ul>
    </article>
  );
}

export default function TeamDirectory() {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<TeamGroup | 'all'>('all');
  const [expanded, setExpanded] = useState<TeamGroup[]>(['operational']);
  const entries = filterTeamAddresses(query, group);
  const searching = query.trim().length > 0;

  return (
    <section aria-label="Address directory">
      <div className="mb-6 grid gap-4 rounded-2xl border border-slate-700/60 bg-slate-900/70 p-5 sm:grid-cols-[1fr_auto]">
        <div>
          <label htmlFor="team-search" className="mb-2 block text-sm font-medium text-slate-200">Search addresses and roles</label>
          <input id="team-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Address, migration, vault, allocation…" className="w-full rounded-xl border border-slate-600 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-300" />
        </div>
        <div>
          <label htmlFor="team-group" className="mb-2 block text-sm font-medium text-slate-200">Category</label>
          <select id="team-group" value={group} onChange={(event) => setGroup(event.target.value as TeamGroup | 'all')} className="w-full rounded-xl border border-slate-600 bg-slate-950 px-4 py-3 text-sm text-white focus:border-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-300">
            <option value="all">All categories</option>
            {TEAM_GROUPS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
        <p role="status" aria-live="polite" className="text-xs text-slate-400 sm:col-span-2">{entries.length} matching {entries.length === 1 ? 'address' : 'addresses'}. Each address appears once; the pool ID is listed separately.</p>
      </div>

      <div className="space-y-6">
        {TEAM_GROUPS.map((category) => {
          const matches = entries.filter((entry) => entry.group === category.id);
          if (matches.length === 0) return null;
          const forcedOpen = searching || group !== 'all';
          const isExpanded = forcedOpen || expanded.includes(category.id);
          return (
            <section key={category.id} aria-labelledby={`heading-${category.id}`} className="rounded-2xl border border-slate-700/60 bg-slate-950/25">
              <h2 id={`heading-${category.id}`}>
                <button type="button" aria-expanded={isExpanded} aria-controls={`entries-${category.id}`} disabled={forcedOpen} onClick={() => setExpanded((previous) => previous.includes(category.id) ? previous.filter((id) => id !== category.id) : [...previous, category.id])} className="flex w-full items-center justify-between gap-3 rounded-2xl p-5 text-left text-lg font-semibold text-white enabled:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-cyan-300">
                  <span>{category.title} <span className="ml-2 rounded-lg bg-slate-800 px-2 py-1 text-sm text-slate-300">{matches.length}</span></span>
                  <span aria-hidden="true" className="text-slate-400">{isExpanded ? '−' : '+'}</span>
                </button>
              </h2>
              <p className="px-5 pb-5 text-sm leading-6 text-slate-400">{category.description}</p>
              <div id={`entries-${category.id}`} hidden={!isExpanded}>
                {isExpanded && <div className="grid gap-4 p-4 pt-0 md:grid-cols-2">{matches.map((entry) => <AddressCard key={entry.address} entry={entry} />)}</div>}
              </div>
            </section>
          );
        })}
        {entries.length === 0 && <p className="rounded-2xl border border-slate-700 p-8 text-center text-slate-300">No matching addresses. Try a shorter search or choose all categories.</p>}
      </div>
    </section>
  );
}
