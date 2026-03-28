'use client';

import { useState } from 'react';
import JobsTable from '@/components/JobsTable';
import { TopBar, MainContent } from '@/components/layout';
import Link from 'next/link';

export default function Dashboard() {
  const [filter, setFilter] = useState('');

  return (
    <>
      <TopBar>
        <div>
          <h1 className="text-lg">Training Queue</h1>
        </div>
        <div className="flex-1 max-w-xl mx-4">
          <input
            type="text"
            className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-1 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
            placeholder="Filter by name or model (supports AND, OR)..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
        <div>
          <Link href="/jobs/new" className="text-gray-200 bg-slate-600 px-3 py-1 rounded-md">
            New Training Job
          </Link>
        </div>
      </TopBar>
      <MainContent>
        <JobsTable filter={filter} />
      </MainContent>
    </>
  );
}
