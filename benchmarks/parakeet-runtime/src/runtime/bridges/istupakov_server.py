#!/usr/bin/env python3
"""Resident JSONL bridge for the local Istupakov int8 ONNX model."""

import argparse
import importlib.metadata
import json
import sys
import traceback

CPU_PROVIDERS = ["CPUExecutionProvider"]


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_local_model(model_path):
    import onnx_asr

    attempts = (
        lambda: onnx_asr.load_model(model_path, providers=CPU_PROVIDERS),
        lambda: onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v3",
            path=model_path,
            quantization="int8",
            providers=CPU_PROVIDERS,
        ),
        lambda: onnx_asr.load_model(
            "istupakov/parakeet-tdt-0.6b-v3-onnx",
            path=model_path,
            quantization="int8",
            providers=CPU_PROVIDERS,
        ),
    )
    failures = []
    for attempt in attempts:
        try:
            return attempt()
        except Exception as error:
            failures.append(str(error))
    raise RuntimeError("; ".join(failures))


def transcript_text(result):
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        for field in ("text", "transcript"):
            if isinstance(result.get(field), str):
                return result[field]
    for field in ("text", "transcript"):
        value = getattr(result, field, None)
        if isinstance(value, str):
            return value
    raise TypeError(f"unsupported onnx-asr result: {type(result).__name__}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    model = load_local_model(args.model)
    runtime = {
        "name": "onnx-asr",
        "onnxAsrVersion": importlib.metadata.version("onnx-asr"),
        "onnxRuntimeVersion": importlib.metadata.version("onnxruntime"),
        "providerPolicy": "CPUExecutionProvider",
        "providers": list(model.providers) if hasattr(model, "providers") else ["CPUExecutionProvider"],
    }

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("requestId")
        try:
            request_type = request.get("type")
            if request_type == "health":
                emit({"requestId": request_id, "status": "ok", "runtime": runtime})
            elif request_type == "transcribe":
                emit({"requestId": request_id, "text": transcript_text(model.recognize(request["audioPath"]))})
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
