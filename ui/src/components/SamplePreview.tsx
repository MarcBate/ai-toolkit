'use client';

import { useEffect, useRef, useState } from 'react';
import { Job } from '@prisma/client';
import { apiClient } from '@/utils/api';

interface PreviewState {
  available: boolean;
  path?: string;
  version?: number;
  sample?: number | null;
  of?: number | null;
  step?: number | null;
  total?: number | null;
}

interface Props {
  job: Job;
  /** Rendered under the clip — e.g. the skip / return-to-training buttons. */
  actions?: React.ReactNode;
}

/**
 * Live preview of the clip currently being denoised.
 *
 * The trainer decodes the sampler's running x0 estimate through a tiny VAE and
 * replaces preview.mp4 in the job folder each denoise step. This polls the
 * sidecar and re-mounts the player whenever the file changes.
 *
 * Deliberately renders nothing when no preview is available, which is most of a
 * run: a stale clip left on screen reads as the finished sample, and this is a
 * low-quality approximation that should never be mistaken for one.
 */
export default function SamplePreview({ job, actions }: Props) {
  const [preview, setPreview] = useState<PreviewState>({ available: false });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;

    const poll = async () => {
      try {
        const res = await apiClient.get(`/api/jobs/${job.id}/preview`);
        if (!cancelled.current) setPreview(res.data);
      } catch {
        // a failed poll is not worth surfacing; the next one will tell us
        if (!cancelled.current) setPreview({ available: false });
      }
    };

    poll();
    // only poll while the job could be sampling at all
    const interval = job.status === 'running' ? 2000 : 10000;
    const handle = setInterval(poll, interval);
    return () => {
      cancelled.current = true;
      clearInterval(handle);
    };
  }, [job.id, job.status]);

  if (!preview.available || !preview.path) return null;

  const src = `/api/img/${encodeURIComponent(preview.path)}?v=${preview.version}`;
  const hasProgress = preview.step != null && preview.total != null;

  return (
    <div className="mb-4 rounded-lg border border-gray-700 bg-gray-900/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-sm font-medium text-gray-200">Live preview</span>
          {preview.sample != null && preview.of != null && (
            <span className="text-xs text-gray-400">
              prompt {preview.sample + 1} of {preview.of}
            </span>
          )}
        </div>
        {hasProgress && (
          <span className="text-xs text-gray-400">
            step {preview.step} / {preview.total}
          </span>
        )}
      </div>

      <video
        // key on the version so the browser reloads the replaced file rather
        // than holding the first frame it cached
        key={preview.version}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="w-full max-h-72 object-contain rounded bg-black"
      />

      {hasProgress && (
        <div className="mt-2 h-1 w-full rounded bg-gray-700 overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-500"
            style={{ width: `${Math.min(100, (preview.step! / preview.total!) * 100)}%` }}
          />
        </div>
      )}

      <p className="mt-2 text-xs text-gray-500">
        Approximate — decoded with a tiny VAE to show progress, not final quality.
      </p>

      {actions && <div className="mt-2 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
