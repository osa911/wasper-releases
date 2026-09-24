#!/usr/bin/env python3
"""Resident JSONL bridge for bounded MLX Parakeet runtime variants."""

import argparse
import importlib.metadata
import json
import sys
import traceback


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_model(model_path, precision, mx):
    import mlx.nn as nn
    import parakeet_mlx

    if precision == "bf16":
        return parakeet_mlx.from_pretrained(model_path, dtype=mx.bfloat16)

    from parakeet_mlx.utils import from_config

    with open(f"{model_path}/config.json", encoding="utf-8") as handle:
        config = json.load(handle)
    model = from_config(config)
    quantization = config.get("quantization", {})
    nn.quantize(
        model,
        group_size=int(quantization.get("group_size", 64)),
        bits=int(quantization.get("bits", 8)),
    )
    model.load_weights(f"{model_path}/model.safetensors")
    mx.eval(model.parameters())
    return model


def transcript_text(result):
    if isinstance(result, str):
        return result
    for field in ("text", "transcript"):
        value = getattr(result, field, None)
        if isinstance(value, str):
            return value
    raise TypeError(f"unsupported parakeet-mlx result: {type(result).__name__}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--precision", choices=("bf16", "int8-g64"), required=True)
    parser.add_argument("--chunk-duration-seconds", type=float, required=True)
    parser.add_argument("--overlap-duration-seconds", type=float, required=True)
    parser.add_argument("--max-metal-memory-bytes", type=int, required=True)
    args = parser.parse_args()

    import mlx.core as mx

    mx.metal.set_memory_limit(args.max_metal_memory_bytes)
    mx.metal.set_cache_limit(0)
    model = load_model(args.model, args.precision, mx)
    runtime = {
        "name": "parakeet-mlx",
        "parakeetMlxVersion": importlib.metadata.version("parakeet-mlx"),
        "mlxVersion": importlib.metadata.version("mlx"),
        "precision": args.precision,
        "chunkDurationSeconds": args.chunk_duration_seconds,
        "overlapDurationSeconds": args.overlap_duration_seconds,
        "maxMetalMemoryBytes": args.max_metal_memory_bytes,
    }

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("requestId")
        try:
            request_type = request.get("type")
            if request_type == "health":
                emit({"requestId": request_id, "status": "ok", "runtime": runtime})
            elif request_type == "transcribe":
                try:
                    result = model.transcribe(
                        request["audioPath"],
                        dtype=mx.bfloat16,
                        chunk_duration=args.chunk_duration_seconds,
                        overlap_duration=args.overlap_duration_seconds,
                    )
                    emit({"requestId": request_id, "text": transcript_text(result)})
                finally:
                    mx.metal.clear_cache()
            elif request_type == "stop":
                emit({"requestId": request_id, "status": "stopping"})
                return
            else:
                raise ValueError(f"unsupported request type: {request_type}")
        except Exception as error:  # Bridge boundary must serialize holder failures.
            traceback.print_exc(file=sys.stderr)
            emit({"requestId": request_id, "error": str(error)})


if __name__ == "__main__":
    main()
