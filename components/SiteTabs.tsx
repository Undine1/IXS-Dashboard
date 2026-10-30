import Link from 'next/link';

export default function SiteTabs({ active }: { active: 'statistics' | 'team' }) {
  return (
    <nav aria-label="Dashboard sections" className="mb-8 flex flex-wrap gap-2 rounded-2xl border border-slate-700/60 bg-slate-900/70 p-2">
      {[
        { id: 'statistics', href: '/', label: 'Statistics' },
        { id: 'team', href: '/team', label: 'Team wallets and contracts' },
      ].map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          prefetch={false}
          aria-current={active === tab.id ? 'page' : undefined}
          className={`rounded-xl px-4 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${active === tab.id ? 'bg-cyan-300/15 text-cyan-200 ring-1 ring-inset ring-cyan-300/30' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
