from fnmatch import fnmatch
from typing import List, Optional, Union, TYPE_CHECKING, Tuple
import hashlib
import json
import os
import re
import torch

from optimum.quanto.quantize import _quantize_submodule, quantization_map
from optimum.quanto.tensor import Optimizer, qtype, qtypes
from torchao.quantization.quant_api import (
    quantize_ as torchao_quantize_,
    Float8WeightOnlyConfig,
    UIntXWeightOnlyConfig,
    Int8WeightOnlyConfig
)
from optimum.quanto import freeze
from tqdm import tqdm
from safetensors.torch import load_file, save_file
from huggingface_hub import hf_hub_download

from toolkit.print import print_acc

if TYPE_CHECKING:
    from toolkit.models.base_model import BaseModel

# the quantize function in quanto had a bug where it was using exclude instead of include

Q_MODULES = [
    "QLinear",
    "QConv2d",
    "QEmbedding",
    "QBatchNorm2d",
    "QLayerNorm",
    "QConvTranspose2d",
    "QEmbeddingBag",
]


def filter_lora_state_dict_for_quantized_model(
    transformer: "torch.nn.Module",
    lora_state_dict: dict,
) -> dict:
    """Remove LoRA keys targeting quanto-quantized layers.

    PEFT's load_lora_weights with assign=True calls QModule._load_from_state_dict,
    which unconditionally pops weight._data from the state dict — raising KeyError
    if the key isn't present (i.e. when loading a LoRA, not a full checkpoint).

    LoRA key prefixes vary by training tool:
      - kohya / custom: 'diffusion_model.<module>.<lora_A/B>...'
      - diffusers:      'transformer.<module>.<lora_A/B>...'
    Both must be stripped before matching against named_modules() names.
    """
    quantized_modules = {
        name
        for name, mod in transformer.named_modules()
        if mod.__class__.__name__ in Q_MODULES
    }
    if not quantized_modules:
        return lora_state_dict

    _LORA_MARKERS = (
        ".lora_A.", ".lora_B.", ".lora_alpha",
        ".lora_embedding_A.", ".lora_embedding_B.",
    )
    _STRIP_PREFIXES = ("diffusion_model.", "transformer.")

    def _module_name(key: str) -> str:
        for pfx in _STRIP_PREFIXES:
            if key.startswith(pfx):
                key = key[len(pfx):]
                break
        for marker in _LORA_MARKERS:
            i = key.find(marker)
            if i >= 0:
                return key[:i]
        return key

    return {
        k: v for k, v in lora_state_dict.items()
        if _module_name(k) not in quantized_modules
    }

torchao_qtypes = {
    # "int4": Int4WeightOnlyConfig(),
    "uint2": UIntXWeightOnlyConfig(torch.uint2),
    "uint3": UIntXWeightOnlyConfig(torch.uint3),
    "uint4": UIntXWeightOnlyConfig(torch.uint4),
    "uint5": UIntXWeightOnlyConfig(torch.uint5),
    "uint6": UIntXWeightOnlyConfig(torch.uint6),
    "uint7": UIntXWeightOnlyConfig(torch.uint7),
    "uint8": UIntXWeightOnlyConfig(torch.uint8),
    "int8": Int8WeightOnlyConfig(),
    "float8": Float8WeightOnlyConfig(),
}


class aotype:
    def __init__(self, name: str):
        self.name = name
        self.config = torchao_qtypes[name]


def get_qtype(qtype: Union[str, qtype]) -> qtype:
    if qtype in torchao_qtypes:
        return aotype(qtype)
    if isinstance(qtype, str):
        return qtypes[qtype]
    else:
        return qtype


def is_quantized_tensor(t) -> bool:
    # torchao stores quantized weights as tensor subclasses (e.g. AffineQuantizedTensor) under torchao.*
    # that still report as nn.Parameter and expose .dequantize(). (quanto is handled separately.)
    return 'torchao' in type(t).__module__ and hasattr(t, 'dequantize')


def dequantize_if_quantized(t):
    return t.dequantize() if is_quantized_tensor(t) else t


def get_torchao_config(qtype):
    # returns the torchao quantization config for a given qtype string, or None if it isn't torchao
    if qtype is None:
        return None
    try:
        q = get_qtype(qtype)
    except Exception:
        return None
    return q.config if isinstance(q, aotype) else None


def requantize_module_weight(module, fp_weight, orig_dtype, config) -> None:
    """Write a full precision weight back into module.weight, re-quantizing in place if a torchao
    config is provided so the module stays quantized (used by the continuous merge/reset method).
    If config is None the weight is left in full precision."""
    module.weight = torch.nn.Parameter(fp_weight.to(orig_dtype), requires_grad=False)
    if config is not None:
        torchao_quantize_(module, config)


def quantize(
    model: torch.nn.Module,
    weights: Optional[Union[str, qtype, aotype]] = None,
    activations: Optional[Union[str, qtype]] = None,
    optimizer: Optional[Optimizer] = None,
    include: Optional[Union[str, List[str]]] = None,
    exclude: Optional[Union[str, List[str]]] = None,
):
    """Quantize the specified model submodules

    Recursively quantize the submodules of the specified parent model.

    Only modules that have quantized counterparts will be quantized.

    If include patterns are specified, the submodule name must match one of them.

    If exclude patterns are specified, the submodule must not match one of them.

    Include or exclude patterns are Unix shell-style wildcards which are NOT regular expressions. See
    https://docs.python.org/3/library/fnmatch.html for more details.

    Note: quantization happens in-place and modifies the original model and its descendants.

    Args:
        model (`torch.nn.Module`): the model whose submodules will be quantized.
        weights (`Optional[Union[str, qtype]]`): the qtype for weights quantization.
        activations (`Optional[Union[str, qtype]]`): the qtype for activations quantization.
        include (`Optional[Union[str, List[str]]]`):
            Patterns constituting the allowlist. If provided, module names must match at
            least one pattern from the allowlist.
        exclude (`Optional[Union[str, List[str]]]`):
            Patterns constituting the denylist. If provided, module names must not match
            any patterns from the denylist.
    """
    if include is not None:
        include = [include] if isinstance(include, str) else include
    if exclude is not None:
        exclude = [exclude] if isinstance(exclude, str) else exclude
    for name, m in model.named_modules():
        if include is not None and not any(
            fnmatch(name, pattern) for pattern in include
        ):
            continue
        if exclude is not None and any(fnmatch(name, pattern) for pattern in exclude):
            continue
        try:
            # check if m is QLinear or QConv2d
            if m.__class__.__name__ in Q_MODULES:
                continue
            else:
                if isinstance(weights, aotype):
                    torchao_quantize_(m, weights.config)
                else:
                    _quantize_submodule(
                        model,
                        name,
                        m,
                        weights=weights,
                        activations=activations,
                        optimizer=optimizer,
                    )
        except Exception as e:
            print(f"Failed to quantize {name}: {e}")
            # raise e


def _compute_quant_cache_key(base_model: "BaseModel") -> Tuple[str, str]:
    """Return (slug, hash20) for the quantization cache filename.

    The slug is a sanitised basename of name_or_path so cache files are
    human-readable and clearly tied to a specific checkpoint.
    """
    name = base_model.model_config.name_or_path
    qtype_name = base_model.model_config.qtype
    parts = [name, qtype_name, "v1"]
    if os.path.isfile(name) or os.path.isdir(name):
        try:
            parts.append(str(int(os.path.getmtime(name))))
        except OSError:
            pass
    hash20 = hashlib.sha256("|".join(parts).encode()).hexdigest()[:20]
    # human-readable slug from the last path component (no extension)
    basename = os.path.splitext(os.path.basename(name))[0] or name
    slug = re.sub(r'[^A-Za-z0-9._-]', '-', basename)[:40].strip('-')
    return slug, hash20


def _save_to_quant_cache(
    model_to_quantize: torch.nn.Module,
    cache_path: str,
    cache_qmap_path: str,
):
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    raw_state = model_to_quantize.orig_state_dict()
    raw_state = {k: v.cpu().contiguous() for k, v in raw_state.items()}
    save_file(raw_state, cache_path)
    qmap = quantization_map(model_to_quantize)
    with open(cache_qmap_path, "w", encoding="utf-8") as f:
        json.dump(qmap, f, indent=2)


def _load_from_quant_cache(
    model_to_quantize: torch.nn.Module,
    cache_path: str,
    cache_qmap_path: str,
):
    with open(cache_qmap_path, "r", encoding="utf-8") as f:
        qmap = json.load(f)

    # Recreate QLinear module structure from the qmap (no GPU, no freeze computation).
    # Pre-filter to only quantized entries so tqdm reflects real work items.
    quantized_items = [
        (name, m) for name, m in model_to_quantize.named_modules()
        if name in qmap
    ]
    for name, m in tqdm(quantized_items, desc=" - rebuilding quantization structure"):
        qconfig = qmap[name]
        w = qconfig["weights"]
        a = qconfig["activations"]
        weights_qt = get_qtype(w) if w != "none" else None
        activations_qt = get_qtype(a) if a != "none" else None
        if weights_qt is not None and not isinstance(weights_qt, aotype):
            _quantize_submodule(model_to_quantize, name, m, weights=weights_qt, activations=activations_qt)

    # Load the frozen QTensor state — QModuleMixin._load_from_state_dict reconstructs
    # QBytesTensors from _data/_scale without re-running any quantization math.
    print_acc(f" - loading quantized weights from cache...")
    state_dict = load_file(cache_path, device="cpu")
    print_acc(" - applying weights to model...")
    model_to_quantize.load_state_dict(state_dict, strict=False)
    freeze(model_to_quantize)


def quantize_model(
    base_model: "BaseModel",
    model_to_quantize: torch.nn.Module,
):
    from toolkit.dequantize import patch_dequantization_on_save

    if not hasattr(base_model, "get_transformer_block_names"):
        raise ValueError(
            "The model to quantize must have a method `get_transformer_block_names`."
        )

    # patch the state dict method
    patch_dequantization_on_save(model_to_quantize)

    # sensitive modules to keep in full precision (fnmatch patterns)
    exclude_modules = base_model.get_quantization_exclude_modules() or []

    if base_model.model_config.accuracy_recovery_adapter is not None:
        from toolkit.config_modules import NetworkConfig
        from toolkit.lora_special import LoRASpecialNetwork

        # we need to load and quantize with an accuracy recovery adapter
        # todo handle hf repos
        load_lora_path = base_model.model_config.accuracy_recovery_adapter

        if not os.path.exists(load_lora_path):
            # not local file, grab from the hub

            path_split = load_lora_path.split("/")
            if len(path_split) > 3:
                raise ValueError(
                    "The accuracy recovery adapter path must be a local path or for a hf repo, 'username/repo_name/filename.safetensors'."
                )
            repo_id = f"{path_split[0]}/{path_split[1]}"
            print_acc(f"Grabbing lora from the hub: {load_lora_path}")
            new_lora_path = hf_hub_download(
                repo_id,
                filename=path_split[-1],
            )
            # replace the path
            load_lora_path = new_lora_path

        # build the lora config based on the lora weights
        lora_state_dict = load_file(load_lora_path)
        
        if hasattr(base_model, "convert_lora_weights_before_load"):
            lora_state_dict = base_model.convert_lora_weights_before_load(lora_state_dict)
        
        network_config = {
            "type": "lora",
            "network_kwargs": {"only_if_contains": []},
            "transformer_only": False,
        }
        first_key = list(lora_state_dict.keys())[0]
        first_weight = lora_state_dict[first_key]
        # if it starts with lycoris and includes lokr
        if first_key.startswith("lycoris") and any(
            "lokr" in key for key in lora_state_dict.keys()
        ):
            network_config["type"] = "lokr"
        
        network_kwargs = {}

        # find firse loraA weight
        if network_config["type"] == "lora":
            linear_dim = None
            for key, value in lora_state_dict.items():
                if "lora_A" in key:
                    linear_dim = int(value.shape[0])
                    break
            linear_alpha = linear_dim
            network_config["linear"] = linear_dim
            network_config["linear_alpha"] = linear_alpha

            # we build the keys to match every key
            only_if_contains = []
            for key in lora_state_dict.keys():
                contains_key = key.split(".lora_")[0]
                if contains_key not in only_if_contains:
                    only_if_contains.append(contains_key)

            network_kwargs["only_if_contains"] = only_if_contains
        elif network_config["type"] == "lokr":
            # find the factor
            largest_factor = 0
            for key, value in lora_state_dict.items():
                if "lokr_w1" in key:
                    factor = int(value.shape[0])
                    if factor > largest_factor:
                        largest_factor = factor
            network_config["lokr_full_rank"] = True
            network_config["lokr_factor"] = largest_factor

            only_if_contains = []
            for key in lora_state_dict.keys():
                if "lokr_w1" in key:
                    contains_key = key.split(".lokr_w1")[0]
                    contains_key = contains_key.replace("lycoris_", "")
                    if contains_key not in only_if_contains:
                        only_if_contains.append(contains_key)
            network_kwargs["only_if_contains"] = only_if_contains
        
        if hasattr(base_model, 'target_lora_modules'):
            network_kwargs['target_lin_modules'] = base_model.target_lora_modules

        # todo auto grab these
        # get dim and scale
        network_config = NetworkConfig(**network_config)

        network = LoRASpecialNetwork(
            text_encoder=None,
            unet=model_to_quantize,
            lora_dim=network_config.linear,
            multiplier=1.0,
            alpha=network_config.linear_alpha,
            # conv_lora_dim=self.network_config.conv,
            # conv_alpha=self.network_config.conv_alpha,
            train_unet=True,
            train_text_encoder=False,
            network_config=network_config,
            network_type=network_config.type,
            transformer_only=network_config.transformer_only,
            is_transformer=base_model.is_transformer,
            base_model=base_model,
            is_ara=True,
            **network_kwargs
        )
        network.apply_to(
            None, model_to_quantize, apply_text_encoder=False, apply_unet=True
        )
        network.force_to(base_model.device_torch, dtype=base_model.torch_dtype)
        network._update_torch_multiplier()
        network.load_weights(lora_state_dict)
        network.eval()
        network.is_active = True
        network.can_merge_in = False
        base_model.accuracy_recovery_adapter = network

        # quantize it
        lora_exclude_modules = []
        quantization_type = get_qtype(base_model.model_config.qtype)
        for lora_module in tqdm(network.unet_loras, desc="Attaching quantization"):
            # the lora has already hijacked the original module
            orig_module = lora_module.org_module[0]
            orig_module.to(base_model.torch_dtype)
            # make the params not require gradients
            for param in orig_module.parameters():
                param.requires_grad = False
            quantize(orig_module, weights=quantization_type)
            freeze(orig_module)
            module_name = lora_module.lora_name.replace('$$', '.').replace('transformer.', '')
            lora_exclude_modules.append(module_name)
            if base_model.model_config.low_vram:
                # move it back to cpu
                orig_module.to("cpu")
        pass
        # quantize additional layers
        print_acc(" - quantizing additional layers")
        quantization_type = get_qtype('uint8')
        quantize(
            model_to_quantize,
            weights=quantization_type,
            exclude=lora_exclude_modules + exclude_modules
        )
    else:
        # quantize model the original way without an accuracy recovery adapter
        # move and quantize only certain pieces at a time.
        quantization_type = get_qtype(base_model.model_config.qtype)

        # Cache check: skip GPU quantization if a pre-computed cache exists
        cache_dir = os.environ.get("AITK_QUANTIZATION_CACHE_DIR", None)
        wants_cache = getattr(base_model.model_config, "cache_quantized_model", False)
        use_cache = (
            cache_dir
            and wants_cache
            and not isinstance(quantization_type, aotype)  # quanto only; torchao not supported
        )
        if wants_cache and not use_cache:
            if isinstance(quantization_type, aotype):
                base_model.print_and_status_update(
                    f" - Note: cache_quantized_model is enabled but caching is not supported "
                    f"for torchao quantization (qtype={base_model.model_config.qtype}). "
                    f"This happens when layer_offloading=true forces qfloat8 → float8. "
                    f"Model will be re-quantized each run."
                )
            elif not cache_dir:
                base_model.print_and_status_update(
                    f" - Note: cache_quantized_model is enabled but AITK_QUANTIZATION_CACHE_DIR "
                    f"is not set. Configure a cache directory in Settings."
                )
        cache_path = cache_qmap_path = None
        if use_cache:
            slug, cache_key = _compute_quant_cache_key(base_model)
            cache_path = os.path.join(cache_dir, f"quant_{slug}_{cache_key}.safetensors")
            cache_qmap_path = os.path.join(cache_dir, f"quant_{slug}_{cache_key}_qmap.json")
            if os.path.exists(cache_path) and os.path.exists(cache_qmap_path):
                try:
                    base_model.print_and_status_update(" - loading cached quantized model...")
                    _load_from_quant_cache(model_to_quantize, cache_path, cache_qmap_path)
                    base_model.print_and_status_update(" - cached quantized model loaded")
                    return
                except Exception as e:
                    base_model.print_and_status_update(
                        f" - cache load failed ({e}), re-quantizing from scratch"
                    )

        # all_blocks = list(model_to_quantize.transformer_blocks)
        all_blocks: List[torch.nn.Module] = []
        transformer_block_names = base_model.get_transformer_block_names()
        for name in transformer_block_names:
            # name may be a dotted path for models that nest their blocks
            # (e.g. hidream_o1's "model.language_model.layers").
            block_list = model_to_quantize
            for part in name.split('.'):
                block_list = getattr(block_list, part, None)
                if block_list is None:
                    break
            if block_list is not None:
                all_blocks += list(block_list)
        base_model.print_and_status_update(
            f" - quantizing {len(all_blocks)} transformer blocks"
        )
        for block in tqdm(all_blocks):
            base_model.maybe_stop()
            block.to(base_model.device_torch, dtype=base_model.torch_dtype, non_blocking=True)
            quantize(block, weights=quantization_type)
            freeze(block)
            block.to("cpu", non_blocking=True)

        # Quantize the extras (non-transformer-block children) that weren't handled block-by-block above.
        # We skip the already-frozen transformer block lists to avoid rescanning thousands of frozen
        # sub-modules, which would be extremely slow on large models like LTX2-22B.
        base_model.print_and_status_update(" - quantizing extras")
        # model_to_quantize.to(base_model.device_torch, dtype=base_model.torch_dtype)
        quantize(model_to_quantize, weights=quantization_type, exclude=exclude_modules)
        freeze(model_to_quantize)

        # Save to cache after successful quantization
        if use_cache and cache_path:
            try:
                base_model.print_and_status_update(" - saving quantization cache...")
                _save_to_quant_cache(model_to_quantize, cache_path, cache_qmap_path)
                base_model.print_and_status_update(f" - quantization cache saved to {cache_path}")
            except Exception as e:
                base_model.print_and_status_update(f" - warning: failed to save quantization cache: {e}")
