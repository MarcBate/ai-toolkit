'use client';

import { useEffect, useRef, useState } from 'react';
import { Job } from '@prisma/client';
import { apiClient } from '@/utils/api';

type UseJobsListProps = {
  onlyActive?: boolean;
  reloadInterval?: number | null;
  job_type?: string | null;
  // how soon the next poll fires after a manual refresh (e.g. after clicking Stop),
  // so status changes show up quickly instead of waiting out the full reloadInterval
  fastFollowupInterval?: number;
};

export default function useJobsList({
  onlyActive = false,
  reloadInterval = null,
  job_type = null,
  fastFollowupInterval = 1000,
}: UseJobsListProps = {}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchJobs = () => {
    setStatus('loading');
    apiClient
      .get('/api/jobs', { params: job_type ? { job_type } : undefined })
      .then(res => res.data)
      .then(data => {
        console.log('Jobs:', data);
        if (data.error) {
          console.log('Error fetching jobs:', data.error);
          setStatus('error');
        } else {
          if (onlyActive) {
            data.jobs = data.jobs.filter((job: Job) => ['running', 'queued', 'stopping'].includes(job.status));
          }
          setJobs(data.jobs);
          setStatus('success');
        }
      })
      .catch(error => {
        console.error('Error fetching jobs:', error);
        setStatus('error');
      });
  };

  const scheduleNext = (delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!reloadInterval) return;
    timerRef.current = setTimeout(() => {
      fetchJobs();
      scheduleNext(reloadInterval);
    }, delay);
  };

  useEffect(() => {
    fetchJobs();
    scheduleNext(reloadInterval || 0);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // manual refresh (e.g. after stopping a job) also fast-tracks the next poll
  // to fastFollowupInterval instead of leaving it up to reloadInterval away
  const refreshJobs = () => {
    fetchJobs();
    scheduleNext(fastFollowupInterval);
  };

  return { jobs, setJobs, status, refreshJobs };
}
