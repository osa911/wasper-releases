#!/usr/bin/env python3
"""Run FFmpeg with normalized WAV output opened below an inherited directory."""

import os
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


def main():
    name, *arguments = sys.argv[1:]
    name = output_name(name)
    if not stat.S_ISDIR(os.fstat(STAGE_DIRECTORY).st_mode):
        raise ValueError("normalized WAV stage descriptor is not a directory")
    if arguments.count(OUTPUT_MARKER) != 1:
        raise ValueError("normalized WAV command must contain one output descriptor marker")
    descriptor = os.open(name, OUTPUT_FLAGS, 0o600, dir_fd=STAGE_DIRECTORY)
    try:
        output_index = arguments.index(OUTPUT_MARKER)
        arguments[output_index : output_index + 1] = ["-y", "-f", "wav", f"/dev/fd/{descriptor}"]
        return subprocess.run(
            ["ffmpeg", *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            pass_fds=(descriptor,),
            check=False,
        ).returncode
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"normalized WAV transform failed: {error}", file=sys.stderr)
        raise SystemExit(1)
