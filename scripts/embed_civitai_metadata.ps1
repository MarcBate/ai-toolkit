# embed_civitai_metadata.ps1
#
# Reads the ComfyUI metadata embedded in each PNG and writes an A1111-format
# "parameters" tEXt chunk that CivitAI reads automatically on upload.
#
# Prompt source (in priority order):
#   1. workflow JSON → node titled "CoachBate Text Preview and Edit"
#      (CoachBatePromptBuffer, node id 52) → widgets_values[0]
#   2. workflow JSON → any CLIPTextEncode node with a literal text widget
#   3. prompt JSON  → KSampler positive conditioning chain (last resort)
#
# Generation settings (Steps, Sampler, CFG, Seed, Size) are appended in
# standard A1111 format so CivitAI displays them in the info panel.
#
# Existing ComfyUI metadata (workflow, prompt) is preserved unchanged.
# Files are updated in place. Re-running is safe — the parameters chunk is
# simply overwritten if one already exists.

# ── SETTINGS ──────────────────────────────────────────────────────────────────

$folder = "D:\Data\iCloudDrive\Comfy\260624\New folder"

# WSL distro to use (must have the ai-toolkit venv with Pillow installed)
$wslDistro = "Ubuntu-22.04"
$pythonExe = "/mnt/c/Data/git/AIToolkitWSL/ai-toolkit/venv/bin/python3"

# ── CONVERT PATH TO WSL FORMAT ────────────────────────────────────────────────

$wslFolder = $folder -replace '\\', '/'
if ($wslFolder -match '^([A-Za-z]):(.*)') {
    $drive = $Matches[1].ToLower()
    $rest  = $Matches[2]
    $wslFolder = "/mnt/$drive$rest"
}

# ── PYTHON SCRIPT (heredoc passed via stdin) ──────────────────────────────────

$pythonScript = @'
import sys, json, os
from PIL import Image, PngImagePlugin

FOLDER = sys.argv[1]

# Class type of the node whose widgets_values[0] holds the per-image positive prompt.
# The node is titled "CoachBate Text Preview and Edit" in the ComfyUI UI,
# but the JSON type field is "CoachBatePromptBuffer".
PROMPT_NODE_TYPE = "CoachBatePromptBuffer"

def get_settings_from_prompt_json(prompt_json):
    """Return KSampler + EmptyLatentImage settings from the prompt JSON."""
    settings = {}
    for node in prompt_json.values():
        ct = node.get("class_type", "")
        if ct in ("KSampler", "EmptyLatentImage"):
            settings[ct] = node.get("inputs", {})
    return settings

def build_parameters(prompt_text, settings):
    """Format A1111-style parameters string."""
    parts = []
    ks = settings.get("KSampler", {})
    ei = settings.get("EmptyLatentImage", {})

    if ks.get("steps") is not None:
        parts.append(f"Steps: {ks['steps']}")
    if ks.get("sampler_name"):
        parts.append(f"Sampler: {ks['sampler_name']}")
    if ks.get("scheduler"):
        parts.append(f"Schedule type: {ks['scheduler']}")
    if ks.get("cfg") is not None:
        parts.append(f"CFG scale: {ks['cfg']}")
    if ks.get("seed") is not None:
        parts.append(f"Seed: {ks['seed']}")
    if ei.get("width") and ei.get("height"):
        parts.append(f"Size: {ei['width']}x{ei['height']}")

    result = prompt_text.strip()
    if parts:
        result += "\n" + ", ".join(parts)
    return result

def extract_prompt(workflow_json, prompt_json):
    """
    Try sources in priority order; return A1111 parameters string or None.
    """
    settings = get_settings_from_prompt_json(prompt_json)

    # ── Strategy 1: workflow CoachBatePromptBuffer node ───────────────────────
    for node in workflow_json.get("nodes", []):
        if node.get("type") == PROMPT_NODE_TYPE:
            widgets = node.get("widgets_values", [])
            if widgets and isinstance(widgets[0], str):
                # Strip surrounding quotes that ComfyUI sometimes adds to widget display values
                val = widgets[0].strip().strip("'\"")
                if val:
                    return build_parameters(val, settings)

    # ── Strategy 2: workflow CLIPTextEncode with a non-empty text widget ──────
    for node in workflow_json.get("nodes", []):
        if node.get("type") == "CLIPTextEncode":
            widgets = node.get("widgets_values", [])
            if widgets and isinstance(widgets[0], str) and len(widgets[0].strip()) > 10:
                return build_parameters(widgets[0], settings)

    # ── Strategy 3: prompt JSON CLIPTextEncode with a literal text input ──────
    for node in prompt_json.values():
        if node.get("class_type") == "CLIPTextEncode":
            text = node.get("inputs", {}).get("text")
            if isinstance(text, str) and len(text.strip()) > 10:
                return build_parameters(text, settings)

    return None


def process_png(filepath):
    img = Image.open(filepath)
    info = img.info

    raw_workflow = info.get("workflow")
    raw_prompt   = info.get("prompt")

    if not raw_workflow and not raw_prompt:
        print(f"  SKIP (no ComfyUI metadata): {os.path.basename(filepath)}")
        return

    try:
        workflow_json = json.loads(raw_workflow) if raw_workflow else {"nodes": []}
        prompt_json   = json.loads(raw_prompt)   if raw_prompt   else {}
    except Exception as e:
        print(f"  SKIP (JSON parse error: {e}): {os.path.basename(filepath)}")
        return

    parameters = extract_prompt(workflow_json, prompt_json)
    if not parameters:
        print(f"  SKIP (could not find prompt): {os.path.basename(filepath)}")
        return

    # Preserve all existing tEXt chunks; overwrite 'parameters' only
    pnginfo = PngImagePlugin.PngInfo()
    for key, val in info.items():
        if isinstance(val, str) and key != "parameters":
            pnginfo.add_text(key, val)
    pnginfo.add_text("parameters", parameters)

    img.save(filepath, "PNG", pnginfo=pnginfo)

    preview = parameters[:120].replace("\n", " ")
    print(f"  OK  {os.path.basename(filepath)}")
    print(f"      {preview}{'...' if len(parameters) > 120 else ''}")


pngs = sorted(f for f in os.listdir(FOLDER) if f.lower().endswith(".png"))
print(f"\nProcessing {len(pngs)} PNG(s) in: {FOLDER}\n")
for name in pngs:
    process_png(os.path.join(FOLDER, name))
print("\nDone.")
'@

# ── RUN ───────────────────────────────────────────────────────────────────────

Write-Host "Folder : $folder"
Write-Host "WSL    : $wslDistro"
Write-Host ""

# Write the Python script to a temp file in the WSL home dir, run it, then clean up
$tmpWsl = "/tmp/embed_civitai_meta_$PID.py"
$tmpWin = "\\wsl.localhost\$wslDistro" + ($tmpWsl -replace '/', '\')

[System.IO.File]::WriteAllText($tmpWin, $pythonScript, [System.Text.Encoding]::UTF8)
try {
    wsl -d $wslDistro -- $pythonExe $tmpWsl $wslFolder
} finally {
    wsl -d $wslDistro -- rm -f $tmpWsl
}
