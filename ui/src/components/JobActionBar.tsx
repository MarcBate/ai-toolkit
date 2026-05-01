import Link from 'next/link';
import { Eye, Trash2, Pen, Play, Pause, Cog, X, Save, Image } from 'lucide-react';
import { Button } from '@headlessui/react';
import { openConfirm } from '@/components/ConfirmModal';
import { openSaveSnapshotModal } from '@/components/SaveSnapshotModal';
import { Job } from '@prisma/client';
import {
  startJob,
  stopJob,
  saveAndPauseJob,
  deleteJob,
  getAvaliableJobActions,
  markJobAsStopped,
  saveJob,
  sampleJob,
} from '@/utils/jobs';
import { startQueue } from '@/utils/queue';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { openCaptionDatasetModal } from '@/components/CaptionDatasetModal';
import { useState } from 'react';

interface JobActionBarProps {
  job: Job;
  onRefresh?: () => void;
  afterDelete?: () => void;
  hideView?: boolean;
  className?: string;
  autoStartQueue?: boolean;
  isAnyJobRunning?: boolean;
  hasSamples?: boolean;
}

export default function JobActionBar({
  job,
  onRefresh,
  afterDelete,
  className,
  hideView,
  autoStartQueue = false,
  isAnyJobRunning = false,
  hasSamples = false,
}: JobActionBarProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const { canStart, canStop, canDelete, canEdit, canEditSample, canRemoveFromQueue, canSave, canSample, isBusy } = getAvaliableJobActions(
    job,
    isAnyJobRunning,
    hasSamples,
  );

  if (!afterDelete) afterDelete = onRefresh;

  const handleAction = async (action: () => Promise<void>) => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      await action();
    } catch (e) {
      console.error('Error performing job action:', e);
    } finally {
      setIsProcessing(false);
      if (onRefresh) onRefresh();
    }
  };

  const disabled = isProcessing || isBusy;

  return (
    <div className={`${className}`}>
      {canStart && (
        <Button
          onClick={() => handleAction(() => startJob(job.id))}
          disabled={disabled}
          className={`ml-2 opacity-100 disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Start Job"
        >
          <Play />
        </Button>
      )}
      {canRemoveFromQueue && (
        <Button
          onClick={() => handleAction(() => markJobAsStopped(job.id))}
          disabled={disabled}
          className={`ml-2 opacity-100 disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Remove from Queue"
        >
          <X />
        </Button>
      )}
      {canSave && (
        <Button
          onClick={() => {
            if (disabled) return;
            openSaveSnapshotModal({
              job,
              onRefresh,
            });
          }}
          disabled={disabled}
          className={`ml-2 opacity-100 disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Save Snapshot"
        >
          <Save />
        </Button>
      )}
      {canSample && (
        <Button
          onClick={() => handleAction(() => sampleJob(job.id))}
          disabled={disabled}
          className={`ml-2 opacity-100 disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Generate Samples Now"
        >
          <Image />
        </Button>
      )}
      {canStop && (
        <Button
          onClick={() => {
            if (!canStop) return;
            openConfirm({
              title: 'Stop Job',
              message: `Are you sure you want to stop the job "${job.name}"? This will save a snapshot (if progress has been made) and stop. You CAN resume later.`,
              type: 'info',
              confirmText: 'Stop',
              onConfirm: async () => {
                await handleAction(() => saveAndPauseJob(job.id));
              },
            });
          }}
          disabled={isProcessing} // Allow stop even if busy (isBusy is true when stopping)
          className={`ml-2 opacity-100 disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Stop Job"
        >
          <Pause />
        </Button>
      )}
      {!hideView && (
        <Link href={`/jobs/${job.id}`} className="ml-2 text-gray-200 hover:text-gray-100 inline-block" title="View Job Details">
          <Eye />
        </Link>
      )}
      {job.job_type === 'caption' && canEdit && (
        <div
          className="ml-2 hover:text-gray-100 inline-block cursor-pointer"
          onClick={() =>
            openCaptionDatasetModal(
              job.job_ref || '',
              () => {
                if (onRefresh) onRefresh();
              },
              { jobId: job.id },
            )
          }
        >
          <Pen />
        </div>
      )}
      {job.job_type === 'train' && canEdit && (
        <Link href={`/jobs/new?id=${job.id}`} className="ml-2 hover:text-gray-100 inline-block" title="Edit Job Config">
          <Pen />
        </Link>
      )}
      {job.job_type === 'train' && canEditSample && !canEdit && (
        <Link href={`/jobs/new?id=${job.id}&sampleOnly=true`} className="ml-2 hover:text-gray-100 inline-block" title="Edit Sample Prompts">
          <Pen />
        </Link>
      )}
      <Button
        onClick={() => {
          let message = `Are you sure you want to delete the job "${job.name}"? This will also permanently remove it from your disk.`;
          if (job.status === 'running') {
            message += ' WARNING: The job is currently running. You should stop it first if you can.';
          }
          openConfirm({
            title: 'Delete Job',
            message: message,
            type: 'warning',
            confirmText: 'Delete',
            onConfirm: async () => {
              await handleAction(async () => {
                if (job.status === 'running') {
                  await stopJob(job.id);
                }
                await deleteJob(job.id);
                if (afterDelete) afterDelete();
              });
            },
          });
        }}
        disabled={disabled}
        className={`ml-2 opacity-100 disabled:opacity-30 disabled:cursor-not-allowed`}
        title="Delete Job"
      >
        <Trash2 />
      </Button>
      <div className="border-r border-1 border-gray-700 ml-2 inline"></div>
      <Menu>
        <MenuButton className={'ml-2'} title="More Actions">
          <Cog />
        </MenuButton>
        <MenuItems anchor="bottom" className="bg-gray-900 border border-gray-700 rounded shadow-lg w-48 px-2 py-2 mt-4">
          {job.job_type === 'train' && (
            <MenuItem>
              <Link
                href={`/jobs/new?cloneId=${job.id}`}
                className="cursor-pointer px-4 py-1 hover:bg-gray-800 rounded block"
              >
                Clone Job
              </Link>
            </MenuItem>
          )}
          <MenuItem>
            <div
              className="cursor-pointer px-4 py-1 hover:bg-gray-800 rounded"
              onClick={() => {
                let message = `Are you sure you want to mark this job as stopped? This will set the job status to 'stopped' if the status is hung. Only do this if you are 100% sure the job is stopped. This will NOT stop the job.`;
                openConfirm({
                  title: 'Mark Job as Stopped',
                  message: message,
                  type: 'warning',
                  confirmText: 'Mark as Stopped',
                  onConfirm: async () => {
                    await handleAction(() => markJobAsStopped(job.id));
                  },
                });
              }}
            >
              Mark as Stopped
            </div>
          </MenuItem>
        </MenuItems>
      </Menu>
    </div>
  );
}
