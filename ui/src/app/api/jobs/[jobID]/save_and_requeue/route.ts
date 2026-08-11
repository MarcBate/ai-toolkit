import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import { getTrainingFolder } from '@/server/settings';

const prisma = new PrismaClient();

/**
 * A checkpoint already exists for the job's current step — either nothing has
 * trained yet (step 0) or a periodic save already landed on this exact step,
 * so an on-demand save would just write an identical duplicate.
 */
async function checkpointAlreadyExists(jobName: string, step: number): Promise<boolean> {
  if (!step || step <= 0) return true;
  const trainingFolder = await getTrainingFolder();
  const filename = `${jobName}_${String(step).padStart(5, '0')}.safetensors`;
  return fs.existsSync(path.join(trainingFolder, jobName, filename));
}

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({ where: { id: jobID } });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Stop the queue so it won't advance to the next job after Python exits
  if (job.gpu_ids) {
    const queue = await prisma.queue.findUnique({ where: { gpu_ids: job.gpu_ids } });
    if (queue) {
      await prisma.queue.update({ where: { id: queue.id }, data: { is_running: false } });
    }
  }

  const alreadySaved = await checkpointAlreadyExists(job.name, job.step);

  if (!alreadySaved) {
    // As in save_and_pause: no `stop`, or the watcher SIGINTs the step before the
    // checkpoint is written. return_to_queue is itself cooperative (only maybe_stop()
    // reads it, the watcher does not), so it is safe to set here — but it must not
    // fire before the save, which the stop_after_save gate in maybe_stop() ensures.
    await prisma.job.update({
      where: { id: jobID },
      data: {
        save_now: true,
        stop_after_save: true,
        return_to_queue: true,
        info: 'Saving snapshot and returning to queue...',
      },
    });
  } else {
    // Already have a checkpoint for this exact step — nothing new to save.
    await prisma.job.update({
      where: { id: jobID },
      data: {
        return_to_queue: true,
        info: 'Returning to queue...',
      },
    });
  }

  return NextResponse.json(job);
}
