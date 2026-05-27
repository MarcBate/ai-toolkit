'use client';

import { useState } from 'react';
import GpuMonitor from '@/components/GPUMonitor';
import JobsTable from '@/components/JobsTable';
import { TopBar, MainContent } from '@/components/layout';
import Link from 'next/link';

export default function Dashboard() {
  const [filter, setFilter] = useState('');

  return (
    <>
      <TopBar>
        <div>
          <h1 className="text-base sm:text-lg">Dashboard</h1>
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
        <div className="flex-shrink-0"></div>
      </TopBar>
      <MainContent>
        <GpuMonitor />
        <div className="w-full mt-4">
          <div className="flex justify-between items-center mb-2">
            <h1 className="text-md">Queues</h1>
            <div className="text-xs text-gray-500">
              <Link href="/jobs">View All</Link>
            </div>
          </div>
          <JobsTable onlyActive filter={filter} />
        </div>
      </MainContent>
    </>
  );
}
