import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function POST(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;
  const { direction } = await request.json();

  if (!['up', 'down'].includes(direction)) {
    return NextResponse.json({ error: 'Invalid direction' }, { status: 400 });
  }

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job || job.queue_position === null) {
    return NextResponse.json({ error: 'Job not in queue' }, { status: 404 });
  }

  // Find all jobs in the same GPU queue, sorted by position
  const queueJobs = await prisma.job.findMany({
    where: {
      gpu_ids: job.gpu_ids,
      status: 'queued',
    },
    orderBy: {
      queue_position: 'asc',
    },
  });

  const currentIndex = queueJobs.findIndex(j => j.id === job.id);
  if (currentIndex === -1) {
    return NextResponse.json({ error: 'Job not found in active queue' }, { status: 404 });
  }

  let swapIndex = -1;
  if (direction === 'up' && currentIndex > 0) {
    swapIndex = currentIndex - 1;
  } else if (direction === 'down' && currentIndex < queueJobs.length - 1) {
    swapIndex = currentIndex + 1;
  }

  if (swapIndex !== -1) {
    const neighbor = queueJobs[swapIndex];
    
    // Swap positions
    const tempPos = job.queue_position;
    
    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: { queue_position: neighbor.queue_position },
      }),
      prisma.job.update({
        where: { id: neighbor.id },
        data: { queue_position: tempPos },
      }),
    ]);
    
    console.log(`Job ${job.id} moved ${direction}`);
  }

  return NextResponse.json({ success: true });
}
