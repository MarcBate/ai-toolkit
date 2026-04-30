import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Set both flags but do NOT send SIGINT/kill.
  // The Python process checks should_save() then should_stop() at the end of each
  // training step (in end_step_hook), so it will save first, then stop cleanly.
  // Sending a signal here would interrupt the process mid-step before it reaches
  // the checkpoint where should_save() is checked.
  await prisma.job.update({
    where: { id: jobID },
    data: {
      save: true,
      stop: true,
      info: 'Saving snapshot and pausing...',
    },
  });

  return NextResponse.json(job);
}
