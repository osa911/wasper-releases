#!/usr/bin/env python3
"""Resident JSONL bridge for Handy Computer's transcribe.cpp C API."""

import argparse
import array
import json
import sys
import traceback
import wave


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def read_pcm16_mono(path):
    with wave.open(path, "rb") as source:
        if source.getnchannels() != 1 or source.getframerate() != 16000 or source.getsampwidth() != 2:
            raise ValueError("Handy fixture must be mono 16 kHz PCM16 WAV")
        samples = array.array("h")
        samples.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return [sample / 32768.0 for sample in samples]


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
    raise TypeError(f"unsupported transcribe.cpp result: {type(result).__name__}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    import transcribe_cpp

    model = transcribe_cpp.Model(args.model)
    session = model.session()
    runtime = {
        "name": "transcribe.cpp",
        "bindingVersion": getattr(transcribe_cpp, "__version__", "0.2.2-source-binding"),
        "library": transcribe_cpp.__file__,
    }
    try:
        for line in sys.stdin:
            request = json.loads(line)
            request_id = request.get("requestId")
            try:
                request_type = request.get("type")
                if request_type == "health":
                    emit({"requestId": request_id, "status": "ok", "runtime": runtime})
                elif request_type == "transcribe":
                    result = session.run(read_pcm16_mono(request["audioPath"]))
                    emit({"requestId": request_id, "text": transcript_text(result)})
                elif request_type == "stop":
                    emit({"requestId": request_id, "status": "stopping"})
                    return
                else:
                    raise ValueError(f"unsupported request type: {request_type}")
            except Exception as error:  # Bridge boundary must serialize holder failures.
                traceback.print_exc(file=sys.stderr)
                emit({"requestId": request_id, "error": str(error)})
    finally:
        session.close()
        model.close()


if __name__ == "__main__":
    main()
