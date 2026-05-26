/* eslint-disable */
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDatasetsRoot, getTrainingFolder, getDataRoot } from '@/server/settings';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PNG: read the 'parameters' tEXt chunk (A1111 / CivitAI format)
// ---------------------------------------------------------------------------
function readPngParameters(buf: Buffer): string | null {
  if (buf.length < 8) return null;
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.slice(0, 8).equals(pngSig)) return null;

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    if (offset + 12 + length > buf.length) break;
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (type === 'tEXt' && length > 0) {
      const data = buf.slice(offset + 8, offset + 8 + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1 && data.slice(0, nullIdx).toString('latin1') === 'parameters') {
        return data.slice(nullIdx + 1).toString('latin1');
      }
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MP4 primary: ffprobe — reads the 'parameters' (or 'comment') tag written
// by ffmpeg with -movflags use_metadata_tags (same as ComfyUI VHS approach)
// ---------------------------------------------------------------------------
async function readMp4ViaFfprobe(filepath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filepath,
    ], { timeout: 10000 });
    const info = JSON.parse(stdout);
    const tags: Record<string, string> | undefined = info?.format?.tags;
    if (!tags) return null;
    // Prefer our custom 'parameters' tag; fall back to 'comment'
    return tags['parameters'] ?? tags['comment'] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MP4 fallback: binary parse for the mutagen ©cmt iTunes tag
// (used by older files written before the ffmpeg approach was adopted)
// ---------------------------------------------------------------------------
const CBOX = Buffer.from([0xa9, 0x63, 0x6d, 0x74]); // ©cmt

function findBox(
  buf: Buffer,
  start: number,
  end: number,
  name: Buffer | string,
): { start: number; end: number } | null {
  const target = typeof name === 'string' ? Buffer.from(name, 'ascii') : name;
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    if (size < 8 || offset + size > end) break;
    if (buf.slice(offset + 4, offset + 8).equals(target)) {
      return { start: offset + 8, end: offset + size };
    }
    offset += size;
  }
  return null;
}

function readMp4CommentBinary(buf: Buffer): string | null {
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) return null;
  const udta = findBox(buf, moov.start, moov.end, 'udta');
  if (!udta) return null;
  const meta = findBox(buf, udta.start, udta.end, 'meta');
  if (!meta) return null;
  // meta is a FullBox: skip 4-byte version+flags before children
  const ilst = findBox(buf, meta.start + 4, meta.end, 'ilst');
  if (!ilst) return null;
  const cmt = findBox(buf, ilst.start, ilst.end, CBOX);
  if (!cmt) return null;
  const data = findBox(buf, cmt.start, cmt.end, 'data');
  if (!data || data.end - data.start <= 8) return null;
  // data box: 4-byte type indicator + 4-byte locale = 8 bytes, then UTF-8 text
  return buf.slice(data.start + 8, data.end).toString('utf-8');
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 499 });
  }

  const { imgPath } = body;
  if (!imgPath) return new NextResponse('Missing imgPath', { status: 400 });

  const [datasetRoot, trainingRoot, dataRoot] = await Promise.all([
    getDatasetsRoot(),
    getTrainingFolder(),
    getDataRoot(),
  ]);

  const resolved = path.resolve(imgPath as string);
  const isAllowed = [datasetRoot, trainingRoot, dataRoot].some(
    root => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!isAllowed) return new NextResponse('Access denied', { status: 403 });

  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) return new NextResponse('Not found', { status: 404 });

  const ext = path.extname(resolved).toLowerCase();
  let parameters: string | null = null;

  if (ext === '.png') {
    // PNG: fast binary parse — no subprocess needed
    const MAX_BYTES = 2 * 1024 * 1024; // metadata is always in the first few KB
    const readSize = Math.min(stat.size, MAX_BYTES);
    const buf = Buffer.alloc(readSize);
    const fd = await fs.promises.open(resolved, 'r');
    try {
      await fd.read(buf, 0, readSize, 0);
    } finally {
      await fd.close();
    }
    parameters = readPngParameters(buf);
  } else if (ext === '.mp4' || ext === '.m4v' || ext === '.webm') {
    // MP4: try ffprobe first (reads ffmpeg FFMETADATA1 tags), then binary fallback
    parameters = await readMp4ViaFfprobe(resolved);
    if (!parameters) {
      // Binary fallback for older files that used mutagen ©cmt
      const MAX_BYTES = 50 * 1024 * 1024;
      const readSize = Math.min(stat.size, MAX_BYTES);
      const buf = Buffer.alloc(readSize);
      const fd = await fs.promises.open(resolved, 'r');
      try {
        await fd.read(buf, 0, readSize, 0);
      } finally {
        await fd.close();
      }
      parameters = readMp4CommentBinary(buf);
    }
  }

  if (!parameters) {
    return new NextResponse(JSON.stringify({ prompt: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // The A1111 parameters string: first line is the positive prompt
  const prompt = parameters.split('\n')[0].trim();
  return new NextResponse(JSON.stringify({ prompt }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
