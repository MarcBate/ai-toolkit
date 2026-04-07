import { useMemo } from 'react';
import useJobsList from '@/hooks/useJobsList';
import Link from 'next/link';
import UniversalTable, { TableColumn } from '@/components/UniversalTable';
import { GpuInfo, JobConfig } from '@/types';
import JobActionBar from './JobActionBar';
import { Job, Queue } from '@prisma/client';
import useQueueList from '@/hooks/useQueueList';
import classNames from 'classnames';
import { startQueue, stopQueue } from '@/utils/queue';
import { CgSpinner } from 'react-icons/cg';
import useGPUInfo from '@/hooks/useGPUInfo';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { reorderJob } from '@/utils/jobs';

interface JobsTableProps {
  autoStartQueue?: boolean;
  onlyActive?: boolean;
  filter?: string;
}

export default function JobsTable({ onlyActive = false, filter = '' }: JobsTableProps) {
  const { jobs, status, refreshJobs } = useJobsList(onlyActive, 5000);
  const { queues, status: queueStatus, refreshQueues } = useQueueList();
  const { gpuList, isGPUInfoLoaded } = useGPUInfo();

  const isAnyJobRunning = jobs.some(j => j.status === 'running');

  const refresh = () => {
    refreshJobs();
    refreshQueues();
  };

  const filteredJobs = useMemo(() => {
    if (!filter) return jobs;

    const escapeRegExp = (string: string) => {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };

    const matchesTerm = (job: Job, term: string) => {
      term = term.trim();
      if (!term) return true;

      const jobConfig: JobConfig = JSON.parse(job.job_config);
      const modelName = jobConfig.config.process[0].model.name_or_path || '';
      const searchableText = `${job.name} ${modelName}`.toLowerCase();

      // Check if term is quoted
      if (term.startsWith('"') && term.endsWith('"')) {
        const exactTerm = term.slice(1, -1);
        if (!exactTerm) return true;
        const regex = new RegExp(`(^|[^a-zA-Z0-9_])${escapeRegExp(exactTerm)}([^a-zA-Z0-9_]|$)`, 'i');
        return regex.test(searchableText);
      }

      // Default partial match
      return searchableText.includes(term.toLowerCase());
    };

    const splitByOperator = (input: string, operator: 'and' | 'or') => {
      const regex = new RegExp(`\\s+${operator}\\s+`, 'gi');
      const parts: string[] = [];
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(input)) !== null) {
        const part = input.slice(lastIndex, match.index).trim();
        const quoteCount = (part.match(/"/g) || []).length;
        if (quoteCount % 2 === 0) {
          parts.push(part);
          lastIndex = regex.lastIndex;
        }
      }
      parts.push(input.slice(lastIndex).trim());
      return parts.filter(p => p !== '');
    };

    const orParts = splitByOperator(filter, 'or');
    if (orParts.length > 1) {
      return jobs.filter(job => {
        return orParts.some(part => {
          const andParts = splitByOperator(part, 'and');
          if (andParts.length > 1) {
            return andParts.every(subPart => matchesTerm(job, subPart));
          }
          return matchesTerm(job, part);
        });
      });
    }

    const andParts = splitByOperator(filter, 'and');
    if (andParts.length > 1) {
      return jobs.filter(job => {
        return andParts.every(part => matchesTerm(job, part));
      });
    }

    return jobs.filter(job => matchesTerm(job, filter));
  }, [jobs, filter]);

  const handleReorder = async (jobID: string, direction: 'up' | 'down') => {
    try {
      await reorderJob(jobID, direction);
      refresh();
    } catch (e) {
      console.error('Failed to reorder job:', e);
    }
  };

  const columns: TableColumn[] = [
    {
      title: 'Name',
      key: 'name',
      render: row => (
        <div className="flex items-center">
          {row.status === 'queued' && (
            <div className="flex flex-col mr-3 text-gray-500">
              <button
                onClick={() => handleReorder(row.id, 'up')}
                className="hover:text-white transition-colors"
                title="Move Up"
              >
                <ChevronUp size={16} />
              </button>
              <button
                onClick={() => handleReorder(row.id, 'down')}
                className="hover:text-white transition-colors"
                title="Move Down"
              >
                <ChevronDown size={16} />
              </button>
            </div>
          )}
          <Link href={`/jobs/${row.id}`} className="font-medium whitespace-nowrap">
            {['running', 'stopping'].includes(row.status) ? (
              <CgSpinner className="inline animate-spin mr-2 text-blue-400" />
            ) : null}
            {row.name}
          </Link>
        </div>
      ),
    },
    {
      title: 'Steps',
      key: 'steps',
      render: row => {
        const jobConfig: JobConfig = JSON.parse(row.job_config);
        const totalSteps = jobConfig.config.process[0].train.steps;

        return (
          <div>
            <div className="text-xs text-gray-400">
              {row.step} / {totalSteps}
            </div>
            <div className="bg-gray-700 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full"
                style={{ width: `${(row.step / totalSteps) * 100}%` }}
              ></div>
            </div>
          </div>
        );
      },
    },
    {
      title: 'GPU',
      key: 'gpu_ids',
    },
    {
      title: 'Status',
      key: 'status',
      render: row => {
        let statusClass = 'text-gray-400';
        if (row.status === 'completed') statusClass = 'text-green-400';
        if (row.status === 'failed') statusClass = 'text-red-400';
        if (row.status === 'running') statusClass = 'text-blue-400';

        return <span className={statusClass}>{row.status}</span>;
      },
    },
    {
      title: 'Info',
      key: 'info',
      className: 'truncate max-w-xs',
    },
    {
      title: 'Actions',
      key: 'actions',
      className: 'text-right',
      render: row => {
        return (
          <JobActionBar
            job={row}
            onRefresh={refreshJobs}
            autoStartQueue={false}
            isAnyJobRunning={isAnyJobRunning}
          />
        );
      },
    },
  ];

  const jobsDict = useMemo(() => {
    if (!isGPUInfoLoaded) return {};
    if (filteredJobs.length === 0) return {};
    let jd: { [key: string]: { name: string; jobs: Job[] } } = {};
    gpuList.forEach(gpu => {
      jd[`${gpu.index}`] = { name: `${gpu.name}`, jobs: [] };
    });
    jd['Idle'] = { name: 'Idle', jobs: [] };
    filteredJobs.forEach(job => {
      const gpu = gpuList.find(gpu => job.gpu_ids?.split(',').includes(gpu.index.toString())) as GpuInfo;
      const key = `${gpu?.index || '0'}`;
      if (['queued', 'running', 'stopping'].includes(job.status) && key in jd) {
        jd[key].jobs.push(job);
      } else {
        jd['Idle'].jobs.push(job);
      }
    });
    // sort the queued/running jobs by queue position
    Object.keys(jd).forEach(key => {
      if (key === 'Idle') {
        jd[key].jobs.sort((a, b) => {
          // sort by updated_at, newest first
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });
      } else {
        jd[key].jobs.sort((a, b) => {
          if (a.queue_position === null) return 1;
          if (b.queue_position === null) return -1;
          return a.queue_position - b.queue_position;
        });
      }
    });
    return jd;
  }, [filteredJobs, queues, isGPUInfoLoaded]);

  let isLoading = status === 'loading' || queueStatus === 'loading' || !isGPUInfoLoaded;

  // if job dict is populated, we are always loaded
  if (Object.keys(jobsDict).length > 0) isLoading = false;

  return (
    <div>
      {Object.keys(jobsDict)
        .sort()
        .filter(key => key !== 'Idle')
        .map(gpuKey => {
          const queue = queues.find(q => `${q.gpu_ids}` === gpuKey) as Queue;
          return (
            <div key={gpuKey} className="mb-6">
              <div
                className={classNames(
                  'text-md flex px-4 py-1 rounded-t-lg',
                  { 'bg-green-600 dark:bg-green-900': queue?.is_running },
                  { 'bg-red-600 dark:bg-red-900': !queue?.is_running },
                )}
              >
                <div className="flex items-center space-x-2 flex-1 py-2">
                  <h2 className="font-semibold text-white">{jobsDict[gpuKey].name}</h2>
                  <span className="px-2 py-0.5 bg-gray-700 rounded-full text-xs text-gray-300"># {queue?.gpu_ids}</span>
                </div>
                <div className="text-sm text-gray-300 italic flex items-center">
                  {queue?.is_running ? (
                    <>
                      <span className="text-green-100 dark:text-green-400 mr-2">Queue Running</span>
                      <button
                        onClick={async () => {
                          await stopQueue(queue.gpu_ids as string);
                          refresh();
                        }}
                        className="ml-4 text-xs text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded"
                      >
                        STOP
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-red-100 dark:text-red-400 mr-2">Queue Stopped</span>
                      <button
                        onClick={async () => {
                          await startQueue(gpuKey);
                          refresh();
                        }}
                        className="ml-4 text-xs text-white bg-green-600 hover:bg-green-700 px-2 py-1 rounded"
                      >
                        START
                      </button>
                    </>
                  )}
                </div>
              </div>
              <UniversalTable
                columns={columns}
                rows={jobsDict[gpuKey].jobs}
                isLoading={isLoading}
                onRefresh={refresh}
                theadClassName={
                  queue?.is_running
                    ? 'bg-green-700 dark:bg-green-950 text-white dark:text-gray-400'
                    : 'bg-red-700 dark:bg-red-950 text-white dark:text-gray-400'
                }
              />
            </div>
          );
        })}
      {!onlyActive && Object.keys(jobsDict).includes('Idle') && (
        <div className="mb-6 opacity-50">
          <div className="text-md flex px-4 py-1 rounded-t-lg bg-slate-600">
            <div className="flex items-center space-x-2 flex-1 py-2">
              <h2 className="font-semibold text-gray-100">Idle</h2>
            </div>
          </div>
          <UniversalTable columns={columns} rows={jobsDict['Idle'].jobs} isLoading={isLoading} onRefresh={refresh} />
        </div>
      )}
    </div>
  );
}
