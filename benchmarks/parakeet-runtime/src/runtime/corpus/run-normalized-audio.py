#!/usr/bin/env python3
"""Run FFmpeg with normalized WAV output opened below an inherited directory."""

import os
import resource
import stat
import subprocess
import sys


STAGE_DIRECTORY = 3
OUTPUT_MARKER = "__WASPER_NORMALIZED_WAV_DESCRIPTOR__"
OUTPUT_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC


def output_name(value):
    if value != os.path.basename(value) or value in ("", ".", ".."):
        raise ValueError("unsafe normalized WAV filename")
    return value


def output_limit(value):
    limit = int(value)
    if limit <= 0:
        raise ValueError("normalized WAV output byte cap must be positive")
    return limit


def apply_output_limit(limit):
    _, hard_limit = resource.getrlimit(resource.RLIMIT_FSIZE)
    effective_limit = min(limit, hard_limit) if hard_limit != resource.RLIM_INFINITY else limit
    resource.setrlimit(resource.RLIMIT_FSIZE, (effective_limit, hard_limit))


def main():
    name, max_output_bytes, *arguments = sys.argv[1:]
    name = output_name(name)
    max_output_bytes = output_limit(max_output_bytes)
    if not stat.S_ISDIR(os.fstat(STAGE_DIRECTORY).st_mode):
        raise ValueError("normalized WAV stage descriptor is not a directory")
    if arguments.count(OUTPUT_MARKER) != 1:
        raise ValueError("normalized WAV command must contain one output descriptor marker")
    descriptor = os.open(name, OUTPUT_FLAGS, 0o600, dir_fd=STAGE_DIRECTORY)
    try:
        output_index = arguments.index(OUTPUT_MARKER)
        arguments[output_index : output_index + 1] = ["-y", "-f", "wav", f"/dev/fd/{descriptor}"]
        result = subprocess.run(
            ["ffmpeg", *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            pass_fds=(descriptor,),
            preexec_fn=lambda: apply_output_limit(max_output_bytes),
            check=False,
        )
        if os.fstat(descriptor).st_size >= max_output_bytes:
            raise ValueError(f"normalized WAV exceeds {max_output_bytes} byte cap")
        return result.returncode
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"normalized WAV transform failed: {error}", file=sys.stderr)
        raise SystemExit(1)
