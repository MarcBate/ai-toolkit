# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This is a **personal fork** of [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit) with significant additions. The upstream remote is `origin` (ostris); the fork remote is `fork` (MarcBate). Working branch is `main`.

**Rule:** When ostris merges a feature that already exists in this fork, ask the user which implementation to keep before making any changes.

**Merging origin/main:** `git fetch origin main` then `git merge origin/main --no-edit`. This repo is heavily
diverged (hundreds of fork-only commits), so `git diff HEAD..origin/main` looks enormous (thousands of lines,
mostly our fork-only files showing as pure deletions) — that's just total divergence, not what the merge will
actually touch. Trust the real merge conflicts instead, and resolve each by keeping our implementation unless
ostris's side is clearly a superset (verify by reading both sides, don't assume).

After every merge — conflicted or not, since files can auto-merge cleanly and still lose our changes — verify
these known fork customizations are still present before considering the merge done:
- `toolkit/dataloader_mixins.py`: our `read_text_file` + JSON caption parsing (`caption`/`caption_short`/`extra_values`) and `PoiFileItemDTOMixin`
- `ui/src/app/jobs/new/SimpleJob.tsx`: MRU LoRA input (`LoraPathInput`/`MruTextInput`), neg-prompt hidden for ideogram4, per-dataset Trigger Word field
- `ui/src/app/jobs/new/options.tsx`: `sample.neg` in `DisableableSections` for ideogram4
- `ui/src/app/layout.tsx`: `StopJobModal` and `StripAudioModal` alongside any new Ostris modals
- `ui/src/helpers/defaultSamples.ts`: `guidance_scale: 7` in `defaultIdeogramSamplesConfig`
- `ui/src/components/SampleImageViewer.tsx`: both our `promptExpanded` state and Ostris's `showBoxes` state
- `ui/src/components/StopJobModal.tsx`, `SaveSnapshotModal.tsx`, `QueueStatusWidget.tsx`, `JobTrainingSessions.tsx`, and the `/api/jobs/[jobID]/save_and_pause`, `/save_and_requeue`, `/save_now` routes: fork-only, shouldn't be touched by a merge at all — confirm they still exist

A one-line `grep -c` per marker (see chat history for the exact commands) is enough — report which markers you
checked and that they survived, don't just say "looks fine." Also `py_compile` any touched `.py` files and
`npx tsc --noEmit` (filtering out pre-existing `.next/types` noise) on touched `.ts`/`.tsx` files before calling
the merge done. Report the *actual* merge diff (`git diff <pre-merge-sha>..HEAD --stat`), not the misleading
two-dot origin comparison, so the user sees what really changed.

---

## Running the stack

Everything runs inside **WSL Ubuntu-22.04**. The Python venv is at `venv/` inside the repo.

```bash
# Start the full stack (UI + optional git pull + pip/npm sync)
bash run_ai_toolkit.sh          # from WSL; opens browser at http://localhost:8675

# Run a training job directly
wsl -d Ubuntu-22.04 -- /home/marcbate/venvs/ai-toolkit/bin/python3 run.py config/my_config.yaml
```

Always use `wsl -d Ubuntu-22.04` explicitly — the default WSL distro is not the right one.

**UI commands** (run from `ui/` in WSL):
```bash
npm run dev            # dev mode with hot reload (Next.js + cron worker)
npm run build_and_start  # production build + start (what run_ai_toolkit.sh uses)
npm run update_db      # regenerate Prisma client + push schema to SQLite
npm run lint           # ESLint
npx tsc --noEmit       # TypeScript type-check without emitting
```

After any change to `ui/prisma/schema.prisma`, run `npm run update_db`.

---

## Architecture

### Python backend

- **Entry point:** `run.py` — loads a YAML config, resolves the job type, instantiates the right process class, runs it.
- **Job config:** YAML files under `config/`. Each config names an extension (e.g. `sd_trainer.DiffusionTrainer`) and a `process` list.
- **Extensions:** `extensions_built_in/` contains all model-specific trainers. Key ones:
  - `sd_trainer/DiffusionTrainer.py` — main trainer for Flux, SDXL, etc. Extends `SDTrainer`.
  - `sd_trainer/UITrainer.py` — adds SQLite-backed UI control (stop/save/sample flags) on top of `SDTrainer`.
  - `diffusion_models/ltx2/ltx2.py` — LTX-2.3 video model; overrides `save_image` to call `encode_video` then embed MP4 metadata.
  - `diffusion_models/wan22/` — WAN 2.2 with LightX2V fast sampling.
- **`toolkit/config_modules.py`** — `GenerateImageConfig` is the central class for sample generation; owns `save_image()`, `_embed_mp4_metadata()`, and `_build_civitai_parameters()`.
- **`toolkit/ui_utils.py`** — defines `JobStoppedException(BaseException)` used to interrupt training cleanly at any point including quantization.

### UI ↔ Python communication

Jobs communicate entirely through a **SQLite database** (`aitk_db.db` in the repo root). The Python trainer polls these columns on the `Job` table at the end of each step:

| Column | Meaning |
|--------|---------|
| `stop` | Stop training after saving if `save` is also set |
| `save` | Save a checkpoint on the next step, then continue |
| `sample` | Generate samples on the next step |
| `return_to_queue` | Stop and re-queue |

`save` and `stop` are set together by the "Save and Pause" action — the trainer always saves before stopping. `save_now` exists in the schema (added upstream) but is **not used** by the trainer; `save` is the canonical flag.

### UI (Next.js + Prisma)

- **UI server:** Next.js 15 app in `ui/src/app/`. API routes are under `ui/src/app/api/`.
- **Background worker:** `ui/cron/worker.ts` — manages the training queue, spawns Python processes via `startJob.ts`.
- **Job actions** flow: UI button → `ui/src/utils/jobs.ts` function → API route → Prisma update to `aitk_db.db` → Python trainer polls and acts.
- **Key components:** `JobActionBar.tsx` (per-job buttons), `SaveSnapshotModal.tsx` (save/pause dialog), `SampleImageViewer.tsx` (reads prompt from file metadata via `/api/img/metadata`).

### CivitAI metadata

Sample outputs embed A1111-format metadata for CivitAI compatibility:
- **PNG:** `parameters` tEXt chunk via `PIL.PngImagePlugin.PngInfo`
- **MP4:** ffmpeg FFMETADATA1 re-mux with `-movflags use_metadata_tags` writing `parameters=` and `comment=` keys. Falls back to mutagen `©cmt` if ffmpeg fails.
- **WSL/NTFS caveat:** `os.replace()` fails on `/mnt/c/` paths; the code catches `OSError` and copies bytes in-place instead.

---

## Fork additions summary

See `README.md` "Fork additions" section for the full list. Key areas:

- **Save-before-pause** — `saveAndPauseJob()` sets both `save` and `stop` atomically; Python saves then stops in the same step hook.
- **On-demand save/sample** — trigger mid-training from the UI without stopping.
- **Stop during quantization** — `JobStoppedException` propagates through quantization loops via `maybe_stop()` hooks.
- **LightX2V** — fast WAN 2.2 sampling via two-stage PEFT adapter approach.
- **Gemma API** — LTX-2.3 training without loading the 12B text encoder locally.
- **UI additions** — drag-to-reorder queue, queue filter, negative prompt field, find/replace captions, loss graph persistence, sample grid placeholders.

---

## Key paths

| Purpose | Path |
|---------|------|
| Training output | `C:\Data\AIToolkit-StagingArea\output\` |
| HuggingFace cache | `/mnt/wsl/hfcache/huggingface` (ext4 VHD, see below) |
| UI runs on | `http://localhost:8675` |
| WSL distro | `Ubuntu-22.04` |
| Python venv | `/home/marcbate/venvs/ai-toolkit/bin/python3` (see below — **not** in the repo) |

### The venv is NOT in the repo

`<repo>/venv` is a **symlink** to `/home/marcbate/venvs/ai-toolkit`, which lives on
the distro's ext4. The venv is ~56,000 small files and that is drvfs's worst case:
importing torch + transformers + diffusers costs **~67s** under `/mnt/c` versus
**~2s** native.

**Always invoke the real path.** Going through the symlink does not help — Python
keeps the invocation path as `sys.prefix`, so every site-packages read is still
translated across the bridge (measured 30s vs 2s). `run_ai_toolkit.sh` sets
`VENV_DIR` to the real path and exports `AITK_PYTHON`, which `resolvePythonPath()`
in `ui/cron/pythonPath.ts` prefers over the in-repo candidates.

The symlink exists only so `source venv/bin/activate` still works by habit.

### HuggingFace cache lives on a dedicated ext4 VHD

The cache is **not** under `/mnt/c` anymore. The WSL drvfs bridge caps at ~225 MB/s
regardless of how fast the underlying Windows drive is (measured: 223 MB/s on `/mnt/c`,
228 MB/s on a second NVMe, **13.3 GB/s** on native ext4). Loading a 25GB transformer
took ~112s across the bridge.

It now lives on `C:\Data\WSL\hf-cache.vhdx`, a 400GB ext4 disk mounted at
`/mnt/wsl/hfcache`. `run_ai_toolkit.sh` exports `HF_HOME` there and refuses to start
if the mount is missing — otherwise HF would silently re-download everything.

**WSL does not re-attach the disk after a reboot.** A logon scheduled task runs:

```
wsl.exe --mount --vhd "C:\Data\WSL\hf-cache.vhdx" --name hfcache
```

To attach it manually (elevated prompt required):

```
wsl --mount --vhd "C:\Data\WSL\hf-cache.vhdx" --name hfcache
```

The captioner project keeps its own copy of the Gliese caption model in the old
Windows cache (`C:\Users\marc.bate\.cache\huggingface`), along with the HF auth
token — that path is still live and should not be deleted.
