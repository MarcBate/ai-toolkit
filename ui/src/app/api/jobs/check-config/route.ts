import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import OpenAI from 'openai';
import sqlite3 from 'sqlite3';
import { getTrainingFolder } from '@/server/settings';
import { buildCheckConfigSystemPrompt } from '@/lib/checkConfigPrompt';
import {
  getModelFamily,
  collectSampleMedia,
  collectDatasetImages,
  type MediaItem,
} from '@/lib/checkConfigMedia';

const execAsync = promisify(exec);

async function collectSystemStats(): Promise<Record<string, unknown>> {
  const stats: Record<string, unknown> = {
    system_ram: {
      total_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_mb: Math.round(os.freemem() / 1024 / 1024),
      used_mb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
    },
  };

  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,power.draw,power.limit,temperature.gpu --format=csv,noheader,nounits',
      { timeout: 8000 },
    );
    stats.gpus = stdout.trim().split('\n').map(line => {
      const [index, name, memTotal, memUsed, memFree, gpuUtil, memUtil, powerDraw, powerLimit, temp] =
        line.split(', ').map(s => s.trim());
      return {
        index: parseInt(index),
        name,
        memory_total_mb: parseInt(memTotal),
        memory_used_mb: parseInt(memUsed),
        memory_free_mb: parseInt(memFree),
        gpu_utilization_pct: parseInt(gpuUtil),
        memory_utilization_pct: parseInt(memUtil),
        power_draw_w: parseFloat(powerDraw),
        power_limit_w: parseFloat(powerLimit),
        temperature_c: parseInt(temp),
      };
    });
  } catch {
    // nvidia-smi unavailable — omit GPU stats
  }

  return stats;
}

export const runtime = 'nodejs';

const prisma = new PrismaClient();

function openDb(filename: string) {
  const db = new sqlite3.Database(filename);
  db.configure('busyTimeout', 10_000);
  return db;
}

function all<T = any>(db: sqlite3.Database, sql: string, params: any[] = []) {
  return new Promise<T[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

function closeDb(db: sqlite3.Database) {
  return new Promise<void>((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function POST(request: NextRequest) {
  const baseURL = process.env.CHECK_CONFIG_API_BASE_URL;
  if (!baseURL) {
    return NextResponse.json(
      { error: 'CHECK_CONFIG_API_BASE_URL environment variable is not set' },
      { status: 503 },
    );
  }

  let body: { jobId?: string; includeImages?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { jobId, includeImages = false } = body;
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Collect loss curve if the job has run before
  let lossPoints: { step: number; value: number }[] = [];
  if (job.step > 0) {
    try {
      const trainingFolder = await getTrainingFolder();
      const logPath = path.join(trainingFolder, job.name, 'loss_log.db');
      if (fs.existsSync(logPath)) {
        const db = openDb(logPath);
        try {
          const rows = await all<{ step: number; value: number | null }>(
            db,
            `SELECT m.step, m.value_real AS value
             FROM metrics m
             WHERE m.key = 'loss'
             ORDER BY m.step DESC
             LIMIT 200`,
          );
          lossPoints = rows
            .filter((r) => r.value != null)
            .map((r) => ({ step: r.step, value: r.value! }))
            .reverse();
        } finally {
          await closeDb(db);
        }
      }
    } catch {
      // Loss data is optional — continue without it
    }
  }

  // Build user message with context
  const jobConfig = JSON.parse(job.job_config);
  let datasetStats: Record<string, unknown> = {};
  try {
    datasetStats = JSON.parse((job as any).dataset_stats || '{}');
  } catch {
    // ignore
  }

  const processType: string = jobConfig?.config?.process?.[0]?.type ?? '';
  const modelFamily = getModelFamily(processType);

  // Collect visual media only when explicitly requested
  let sampleMedia: MediaItem[] = [];
  let datasetMedia: MediaItem[] = [];
  let ffmpegUnavailable = false;

  if (includeImages) {
    try {
      const trainingFolder = await getTrainingFolder();
      const sampleResult = await collectSampleMedia(trainingFolder, job.name, modelFamily);
      sampleMedia = sampleResult.items;
      ffmpegUnavailable = sampleResult.ffmpegUnavailable ?? false;

      const datasetPaths: string[] = (jobConfig?.config?.process?.[0]?.datasets ?? [])
        .map((d: any) => d?.folder_path)
        .filter(Boolean);
      datasetMedia = await collectDatasetImages(datasetPaths, modelFamily);
    } catch {
      // media collection is best-effort; proceed without images
    }
  }

  const hasImages = sampleMedia.length > 0 || datasetMedia.length > 0;

  const systemStats = await collectSystemStats();

  const textContext = JSON.stringify(
    {
      model_family: modelFamily,
      job_config: jobConfig,
      dataset_stats: Object.keys(datasetStats).length > 0 ? datasetStats : null,
      current_step: job.step,
      total_steps: job.total_steps,
      loss_curve_last_200_steps: lossPoints.length > 0 ? lossPoints : null,
      system_stats: systemStats,
      visual_analysis_requested: includeImages,
      visual_analysis_available: hasImages,
      ...(ffmpegUnavailable && { note: 'ffmpeg unavailable — video frame extraction skipped; config-only analysis for video model' }),
      ...(!hasImages && includeImages && modelFamily !== 'audio' && { note: 'No sample images found in the samples folder — config-only analysis' }),
    },
    null,
    2,
  );

  // Build content: text + optional image parts
  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string }; label?: string };

  const userContent: ContentPart[] = [{ type: 'text', text: textContext }];

  if (sampleMedia.length > 0) {
    userContent.push({ type: 'text', text: 'Recent sample outputs from this training run:' });
    for (const img of sampleMedia) {
      userContent.push({ type: 'image_url', image_url: { url: img.dataUrl }, label: img.label });
    }
  }

  if (datasetMedia.length > 0) {
    userContent.push({ type: 'text', text: 'Sample images from the training dataset:' });
    for (const img of datasetMedia) {
      userContent.push({ type: 'image_url', image_url: { url: img.dataUrl }, label: img.label });
    }
  }

  const apiKey = process.env.CHECK_CONFIG_API_KEY || 'no-key';
  const model = process.env.CHECK_CONFIG_MODEL || 'claude-sonnet-4-6';

  const client = new OpenAI({ baseURL, apiKey });

  let raw = '';
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: buildCheckConfigSystemPrompt(modelFamily, hasImages) },
        { role: 'user', content: hasImages ? userContent : textContext },
      ],
      max_tokens: 4096,
    });
    raw = response.choices[0]?.message?.content || '';
  } catch (err: any) {
    return NextResponse.json(
      { error: `LLM API call failed: ${err?.message || String(err)}` },
      { status: 502 },
    );
  }

  // Strip markdown code fences if model wrapped the JSON
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let findings: unknown[];
  try {
    const parsed = JSON.parse(stripped);
    findings = Array.isArray(parsed) ? parsed : (parsed?.findings ?? []);
  } catch {
    return NextResponse.json(
      { error: 'Failed to parse AI response', raw },
      { status: 500 },
    );
  }

  return NextResponse.json({ findings });
}

export async function GET() {
  const enabled = !!process.env.CHECK_CONFIG_API_BASE_URL;
  return NextResponse.json({ enabled });
}
