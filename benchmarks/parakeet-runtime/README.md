# Parakeet runtime benchmark

This package measures native Parakeet transcription servers on the same corpus
and scoring rules. The Wasper row measures the native Parakeet server packaged
with Wasper. It does not measure Wasper.app dictation behavior, such as its UI,
recording pipeline, or text insertion.

## Current reproducibility status

All seven runtime locks are ready for public acquisition. `Local MLX INT8` is
derived from the exact pinned public MLX Community model and its generated
artifact hashes are verified. `Fluid Core ML` uses the pinned public FluidAudio
source and Core ML model. This source differs from the modified checkout used
for historical measurements. Two long recordings still require
rights-holder-authorized manual input before a complete full run.

No frozen 2026-09 result is published in this commit. See the
[historical evidence status](results/2026-09-m1-pro/README.md) for why this
commit contains no historical numeric projection.

`ready-short` is a separate runnable verification mode. It uses all seven
runtime locks and the 243 automatically recoverable short fixtures. Its run
identity and CLI output label it as a partial, non-comparable verification run.
It does not recreate the historical seven-runtime result.

## Requirements

Use macOS on an Apple Silicon Mac. Install Node.js 22 or later, Xcode Command
Line Tools, Git, Python 3, CMake, and FFmpeg (which provides both `ffmpeg` and
`ffprobe`). Install Wasper 1.8.0 or a later release.
The 1.8.0 release is the exact published baseline; a later release is accepted
but reported as a later-release comparison.

Run these commands from `benchmarks/parakeet-runtime`:

```sh
xcode-select --install
brew install node@22
brew install python@3.12
brew install cmake
brew install ffmpeg
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install parakeet-mlx==0.5.2 mlx==0.32.2 onnx-asr==0.12.0 onnxruntime==1.30.0
npm run doctor
```

Keep `.venv` activated whenever you run `npm run doctor`, `npm run benchmark`,
or `npm run smoke`. The benchmark uses the active `python3` so its pinned
runtime packages stay isolated from the system Python installation.

`npm run smoke` is a quick setup check. It acquires and starts all seven
runtimes, then runs one automatic short recording through each.
Like `ready-short`, it is not a full comparison and does not
download long recordings or require source-terms acceptance.

`npm run doctor` is read-only. It does not install software, create the cache,
download a model, or fetch a corpus. It prints the hardware, Darwin platform
and kernel release, Node version, available disk, cache and output locations,
Wasper classification, and a state for every runtime. It exits nonzero when a
prerequisite invalidates a full run; that is expected at this commit because of
the long-source blockers. Doctor checks the exact `python3`
used by bootstrap, both FFmpeg tools needed to recover audio, every package pin
required by a ready runtime, and `swift` because the checked-in lock includes a
Swift runtime. It prints a command for each missing prerequisite and never runs
that command itself.

The doctor requires at least 24 GiB of free disk. This is a preflight floor,
not an exact cache size. No measured full-run elapsed time or cache size is
available yet.

If doctor reports a missing Python package, activate `.venv` and use the
command it prints. The manual remediations documented here are
`xcode-select --install`, `brew install node@22`, `brew install python@3.12`,
`brew install cmake`, `brew install ffmpeg`, `python -m pip install <package>==<version>`, and
`npm run clean`.
If doctor reports that Wasper.app is missing, complete these steps:

1. Download the current macOS archive from [Wasper releases](https://github.com/osa911/wasper-releases/releases).
2. Open the archive and move `Wasper.app` to `/Applications`.
3. Run `npm run doctor` again.

Connect the Mac to the internet before acquiring public models or corpus
sources.

## Plan a full run

The complete schedule has 5,544 requests and about 110:29:10 of aggregate
source audio across the fixed runtimes, passes, and cohorts.

No reliable elapsed-time estimate is published because no complete measured
result exists for the current public locks and full long cohort. A future valid
full run will add that measured planning figure.

Reserve 32 GiB of free storage for planning. Doctor enforces a 24 GiB floor.
The extra 8 GiB is headroom, not an exact cache size. The current runtime lock
lists about 5.7 GiB of downloads; the locally generated MLX derivative, corpus
sources, build outputs, and run data add more storage.

## Run the benchmark when prerequisites are available

Use the runnable public verification subset with:

```sh
npm run benchmark -- ready-short
```

This mode fetches all seven runtime locks and recovers only the
automatic short cohort. Its output is labelled `partial-non-comparable`. Do
not treat its metrics as the historical full comparison, and do not infer
anything about manual long inputs from it.

The eventual full-run command is:

```sh
npm run benchmark -- full --accept-source-terms
```

`--accept-source-terms` acknowledges the terms and licenses recorded in the
corpus manifests before any long-source download. Read those terms first. The
flag does not authorize reuse beyond a source's license, and it does not bypass
the two manual-authorized inputs. Do not substitute recordings, references, or
transcripts for those inputs: a partial long cohort is not a full-run result.

By default, generated artifacts are kept only in the marker-owned cache:

```text
~/Library/Caches/Wasper/benchmarks/parakeet-runtime-v1
```

Run outputs are always under its marker-owned `runs` directory. You can pass
`--output-dir` only when it resolves exactly to that directory. The command
rejects a custom output subdirectory so `npm run clean` has a fixed deletion
scope. Treat raw local run output as non-public: do not commit it or publish
it.

To remove generated benchmark data, run:

```sh
npm run clean
```

Run cleanup only after the benchmark exits and while no other process changes
the same cache. Cleanup removes only the generated `artifacts`, `corpus`,
`holders`, and `runs` directories after validating the cache ownership marker
and containment. It refuses a missing, altered, or unsafe marker and does not
delete a repository, home directory, or arbitrary custom path. macOS does not
provide an operation that can delete a previously verified file by identity, so
`clean` cannot protect against another process running under your macOS account
that changes the cache after validation.

## Interpret the results

RTF is response time divided by audio duration. Lower than 1.0 means a response
faster than real time. WER is word-edit errors divided by reference words; CER
is character-edit errors divided by reference characters. Lower WER and CER are
better. Warm-up requests establish runtime residency and are excluded from
timing.

Memory evidence for a timed request is one macOS physical-footprint sample for
the owned runtime process tree, collected only after that response resolves.
The runner also samples after activation health and warm-up so it can stop an
already over-cap runtime before scoring requests. The request result is reported
as `post_response_phys_footprint`; it is not a peak-memory measurement during a
request. The 8 GiB exclusion rule applies to those samples and to a runtime
that explicitly reports a single allocation request above the cap. A runtime
excluded for either condition stops for the rest of the run.

Each long recording is sent as one complete recording. The benchmark never
chunks or merges long audio. A runtime may have its own documented long-audio
strategy, but the benchmark does not supply one. When long coverage is
incomplete, the result omits long quality and speed metrics rather than ranking
partial coverage against complete coverage.

## Public runtime and model sources

The exact revisions, files, and SHA-256 values are in
[`locks/runtimes.json`](locks/runtimes.json). Read every model card, runtime
source, and package license before downloading or using an artifact. Artifact
downloads follow only the checked-in HTTPS redirect hosts for their source
family.

| Runtime | Public sources | State at this commit |
| --- | --- | --- |
| Wasper Metal INT8 | [Wasper 1.8.0 release](https://github.com/osa911/wasper-releases/releases/download/v1.8.0/Wasper-1.8.0-arm64-mac.zip); [model](https://huggingface.co/osa911/wasper-parakeet-tdt-0.6b-v3-onnx-int8) | Ready |
| MLX Community F32/BF16 | [model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3); [parakeet-mlx](https://pypi.org/project/parakeet-mlx/0.5.2/); [MLX](https://pypi.org/project/mlx/0.32.2/) | Ready |
| Local MLX INT8 | [model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3); [parakeet-mlx](https://pypi.org/project/parakeet-mlx/0.5.2/); [MLX](https://pypi.org/project/mlx/0.32.2/); [converter](src/runtime/convert-local-mlx-int8.py) | Ready: generated locally from the locked MLX Community base and hash-verified |
| Handy Q8 | [model](https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf); [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) | Ready |
| NVIDIA Q8 | [model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); [NVIDIA's v0.1.0 macOS Metal archive](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz) | Ready |
| Istupakov ONNX INT8 | [model](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx); [onnx-asr](https://pypi.org/project/onnx-asr/0.12.0/); [onnxruntime](https://pypi.org/project/onnxruntime/1.30.0/) | Ready |
| Fluid Core ML | [model](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml); [FluidAudio](https://github.com/FluidInference/FluidAudio) | Ready: pinned public source and model |

The short corpus contains 243 automatically recoverable entries. Of the 21
long entries, 19 have automatic public sources and two require
rights-holder-authorized manual input. The manifests record source URLs, terms,
licenses, hashes, and acquisition state:

- [`corpus/short-fleurs.json`](corpus/short-fleurs.json)
- [`corpus/long-sources.json`](corpus/long-sources.json)

Use source material only under its applicable terms and license. The benchmark
does not grant rights to audio, reference text, or derived transcripts.

## Reproduce Local MLX INT8

`Local MLX INT8` is not a private download. The runner first recovers the
locked MLX Community F32 model at commit
`ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15`, then uses
`parakeet-mlx==0.5.2` and `mlx==0.32.2` to apply MLX weight-only
quantization with 8-bit weights and a group size of 64. It saves the converted
weights, writes the matching quantization metadata into `config.json`, and
copies the pinned vocabulary.

Both `npm run benchmark -- ready-short` and `npm run benchmark -- full
--accept-source-terms` perform this step automatically. The output is accepted
only when all three generated files match the names, sizes, and SHA-256 values
in [`locks/runtimes.json`](locks/runtimes.json). A partial, modified, or
mismatched local derivative is rejected instead of silently reused.

To inspect the conversion independently after the base model is in the
benchmark cache, activate the documented `.venv` and use a new empty output
directory:

```sh
python -I -B src/runtime/convert-local-mlx-int8.py \
  --input-dir ~/Library/Caches/Wasper/benchmarks/parakeet-runtime-v1/artifacts/mlx-fp32 \
  --output-dir /path/to/empty-local-mlx-int8 \
  --bits 8 \
  --group-size 64
shasum -a 256 /path/to/empty-local-mlx-int8/config.json \
  /path/to/empty-local-mlx-int8/model.safetensors \
  /path/to/empty-local-mlx-int8/vocab.txt
```

The standalone command is for inspection. The benchmark itself creates and
owns its verified copy under the marker-owned cache described above.
