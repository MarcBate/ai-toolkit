'use client';

import { Job } from '@prisma/client';
import { useState, useEffect, useCallback } from 'react';
import { MdExpandMore, MdExpandLess } from 'react-icons/md';

interface Session {
  start_time: number;
  end_time: number | null;
  start_step: number | null;
  startup_seconds: number | null;
  sampling_seconds: number | null;
  training_seconds: number | null;
  total_seconds: number | null;
  in_progress: boolean;
  estimated?: boolean;
}

interface SessionsData {
  sessions: Session[];
  total_seconds: number;
  startup_total: number;
  sampling_total: number;
  training_total: number;
  grand_total: number;
}

const DASH = '–';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatEndDateTime(startUnix: number, endUnix: number): string {
  const start = new Date(startUnix * 1000);
  const end = new Date(endUnix * 1000);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) {
    return end.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return formatDateTime(endUnix);
}

function durationCell(seconds: number | null): string {
  return seconds !== null ? formatDuration(seconds) : DASH;
}

const gridCols = '1.6fr 1fr 0.7fr 0.9fr 0.9fr 1fr 1fr';

interface Props {
  job: Job;
}

export default function JobTrainingSessions({ job }: Props) {
  const [data, setData] = useState<SessionsData | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${job.id}/sessions`);
      if (!res.ok) return;
      const json: SessionsData = await res.json();
      setData(json);
    } catch {
      // silently ignore — sessions are informational
    }
  }, [job.id]);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10_000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  if (!data || data.sessions.length === 0) return null;

  // Hide sessions with no steps unless it's the one currently in progress.
  const visibleSessions = data.sessions
    .filter(s => s.training_seconds !== null || s.in_progress)
    .sort((a, b) => a.start_time - b.start_time);

  if (visibleSessions.length === 0) return null;

  const anyEstimated = visibleSessions.some(s => s.estimated);

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2 text-gray-400 hover:text-gray-300 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="h-1.5 w-1.5 rounded-full bg-purple-500/70 shrink-0" />
          <span className="text-gray-400">Training time</span>
          <span className="text-gray-600">
            {formatDuration(data.grand_total)} total
            <span className="ml-2">
              ({visibleSessions.length} {visibleSessions.length === 1 ? 'session' : 'sessions'})
            </span>
          </span>
        </div>
        {expanded ? (
          <MdExpandLess className="text-gray-600 shrink-0" />
        ) : (
          <MdExpandMore className="text-gray-600 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pt-1 pb-2">
          {anyEstimated && (
            <p className="text-xs text-yellow-700/60 pb-1">
              ~ estimated from step timestamps — model load time not included
            </p>
          )}
          <div className="max-h-80 overflow-y-auto overflow-x-auto">
            <div className="min-w-[560px]">
              <div
                className="grid gap-x-2 text-xs text-gray-500 pb-1 border-b border-gray-800"
                style={{ gridTemplateColumns: gridCols }}
              >
                <div>Start</div>
                <div>End</div>
                <div className="text-right">Step</div>
                <div className="text-right">Startup</div>
                <div className="text-right">Sampling</div>
                <div className="text-right">Training</div>
                <div className="text-right">Total</div>
              </div>

              <div
                className="grid gap-x-2 py-1 text-xs font-medium text-gray-300 border-b border-gray-700"
                style={{ gridTemplateColumns: gridCols }}
              >
                <div>Subtotals</div>
                <div />
                <div />
                <div className="text-right font-mono">{formatDuration(data.startup_total)}</div>
                <div className="text-right font-mono">{formatDuration(data.sampling_total)}</div>
                <div className="text-right font-mono">{formatDuration(data.training_total)}</div>
                <div className="text-right font-mono text-purple-400">
                  {formatDuration(data.grand_total)}
                </div>
              </div>

              <div className="space-y-0.5 pt-1">
                {visibleSessions.map((session, i) => (
                  <div
                    key={i}
                    className="grid gap-x-2 py-1 text-xs text-gray-500"
                    style={{ gridTemplateColumns: gridCols }}
                  >
                    <div>{formatDateTime(session.start_time)}</div>
                    <div className={session.in_progress ? 'text-gray-700' : ''}>
                      {session.in_progress
                        ? 'in progress'
                        : session.end_time !== null
                          ? formatEndDateTime(session.start_time, session.end_time)
                          : DASH}
                    </div>
                    <div className="text-right">{session.start_step || DASH}</div>
                    <div className="text-right font-mono">{durationCell(session.startup_seconds)}</div>
                    <div className="text-right font-mono">{durationCell(session.sampling_seconds)}</div>
                    <div
                      className={`text-right font-mono ${session.estimated ? 'text-yellow-700/70' : ''}`}
                    >
                      {session.training_seconds !== null
                        ? `${session.estimated ? '~' : ''}${formatDuration(session.training_seconds)}`
                        : DASH}
                    </div>
                    <div className="text-right font-mono text-gray-400">
                      {durationCell(session.total_seconds)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
