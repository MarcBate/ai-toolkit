import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import { getTrainingFolder } from '@/server/settings';

const prisma = new PrismaClient();

export interface CheckpointEntry {
  step: number;
  filename: string;
  hasOptimizer: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

const STEP_RE = /_(\d{9})\.safetensors$/;

export async function GET(_req: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status === 'running') return NextResponse.json({ error: 'Job is running' }, { status: 400 });

  const trainingFolder = await getTrainingFolder();
  const jobFolder = path.join(trainingFolder, job.name);

  if (!fs.existsSync(jobFolder)) {
    return NextResponse.json({ checkpoints: [], currentStep: job.step });
  }

  let files: string[];
  try {
    files = fs.readdirSync(jobFolder);
  } catch {
    return NextResponse.json({ checkpoints: [], currentStep: job.step });
  }

  // Collect one entry per step (prefer the primary file — named exactly {job.name}_{step}.safetensors)
  const stepMap = new Map<number, CheckpointEntry>();
  for (const f of files) {
    const m = f.match(STEP_RE);
    if (!m) continue;
    const step = parseInt(m[1], 10);
    const filePath = path.join(jobFolder, f);
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }

    const existing = stepMap.get(step);
    const isPrimary = f === `${job.name}_${m[1]}.safetensors`;
    if (!existing || isPrimary) {
      stepMap.set(step, {
        step,
        filename: f,
        hasOptimizer: false, // filled below
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  // Check for optimizer archives
  for (const [step, entry] of stepMap) {
    const archive = `optimizer_${String(step).padStart(9, '0')}.pt`;
    entry.hasOptimizer = fs.existsSync(path.join(jobFolder, archive));
  }

  const checkpoints = Array.from(stepMap.values()).sort((a, b) => b.step - a.step);
  return NextResponse.json({ checkpoints, currentStep: job.step });
}
