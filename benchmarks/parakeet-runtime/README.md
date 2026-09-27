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
for historical measurements. All 21 long recordings have public download
links. The English and Dutch audio, normalized WAVs, and lexical references
were recovered with hashes matching the original benchmark fixtures.

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
`ffprobe`). Install Wasper 1.5.0 or later. The smoke check confirms whether
that app's native server supports the requests used by this benchmark. The
report records the app version and native-server SHA-256. A different Mac or
Wasper build can produce a different speed while following the same test.

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
prerequisite invalidates a full run. Doctor checks the exact `python3`
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

### Measure a clean local Wasper build

The benchmark accepts an installed Wasper build even when its native-server
hash differs from the published app with the same version. If you know that a
local build came from a clean production source checkout, you can also record
its 7- or 40-character Git commit:

```sh
export WASPER_BENCHMARK_LOCAL_BUILD_COMMIT=<source-commit>
npm run doctor
npm run smoke
npm run benchmark -- full --accept-source-terms
```

The benchmark checks that `Wasper.app` contains a clean production build at
that commit. It records `local-build`, the commit, and the packaged native
server SHA-256 in the result. Without this optional variable, the server hash
still identifies the measured build. Unset the variable for later runs that
use another installed app.

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

## Measure the runtimes

First run `npm run doctor` and fix any reported prerequisites. Then run
`npm run smoke` to check that each runtime can transcribe one short recording
before starting the measured run. Both commands are setup checks, not
benchmark results.

For a quicker short-recording verification run, use:

```sh
npm run benchmark -- ready-short
```

This mode fetches all seven runtime locks and recovers only the
automatic short cohort. Its output is labelled `partial-non-comparable`. Do
not treat its metrics as the historical full comparison or infer long-recording
performance from it.

To measure the full 243-short, 21-long corpus, use:

```sh
npm run benchmark -- full --accept-source-terms
```

### Use audio you already have

The benchmark reuses each prepared recording in its cache after checking the
source, normalized WAV, and reference hashes. It does not download or
normalize that recording again. You can also supply source audio before the
first run. Create an audio directory anywhere you have space, including a
mounted drive, and put each file at `<audio-directory>/<fixtureId>/source`.
Use the `fixtureId` values in `corpus/short-fleurs.json` and
`corpus/long-sources.json`. The file named `source` must contain the exact
source bytes whose SHA-256 is listed as `sourceSha256`. For an archive source,
use the selected audio member, not the whole archive.

For example, after placing the audio files in a directory of your choice:

```sh
npm run smoke -- --audio-dir /path/to/audio-directory
npm run benchmark -- full --accept-source-terms --audio-dir /path/to/audio-directory
```

The benchmark checks each local source before use. It downloads a source only
when that fixture's `source` file is absent. If a local file is present but its
hash differs, the run stops and names the file. References that are not yet in
the verified benchmark cache still come from their public links. You can use
`--audio-dir` with `recover-corpus` and `ready-short` too. The directory you
provide stays outside the benchmark cache, and `npm run clean` does not remove
it.

The runner downloads or verifies the locked models and corpus, then makes
direct, complete-recording requests to each runtime in three sequential
rotated passes. It supplies no language hint and times the response only; it
does not include Wasper.app recording or paste latency. Consecutive short
recordings share a resident runtime; each long recording starts a fresh runtime.
Every activation receives one discarded warm-up request before its timed
requests. A full schedule contains 5,544 timed requests. Run it without other
GPU-heavy work on the Mac.

On completion, the command prints a `runDirectory`. Open `report.md` in that
directory for short and long WER, CER, speed, and completed/expected request
counts. Inspect `local-review-queue.json` there for failed requests before
comparing runtimes. The report withholds long quality and speed when coverage
is incomplete. Do not rank a partial row against a complete one or treat the
`ready-short` verification report as the full comparison.

Each completed request is saved immediately by Node to the run's `requests/`
directory. A temporary file is published only after the write completes.
Saving results is outside the response timer. If a result cannot be saved,
the benchmark stops with `EVIDENCE_WRITE_FAILED` and keeps earlier records.
It does not count a disk-write failure as a transcription failure. A new run
creates a separate run directory and preserves the interrupted run.

`--accept-source-terms` acknowledges the terms and licenses recorded in the
corpus manifests before any long-source download. Read those terms first. The
flag does not authorize reuse beyond a source's license. The Dutch recording
and subtitles come from the Royal Household's own download links. The
publisher does not grant general media redistribution. The benchmark keeps
downloaded media in the local cache and does not include it in this repository.
Do not substitute recordings, references, or transcripts: the pinned hashes
identify the corpus used for the published website results.

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
timing. Runtime startup, warm-up, and shutdown are not included in the reported
request time, but the extra long-recording restarts increase total benchmark
wall-clock time. This process lifecycle differs from earlier published runs;
record the benchmark checkout SHA separately and compare the Wasper binary
identity before comparing speeds.

Memory evidence for a timed request is one macOS physical-footprint sample for
the owned runtime process tree, collected only after that response resolves.
The runner also samples after activation health and warm-up so it can stop an
already over-cap runtime before scoring requests. The request result is reported
as `post_response_phys_footprint`; it is not a peak-memory measurement during a
request. The 8 GiB exclusion rule applies to those samples and to a runtime
that explicitly reports a single allocation request above the cap. A runtime
that breaches the cap during a timed request is marked `memory-excluded` for
that recording only. The runner stops that activation and starts a fresh one
for the next recording. If health or warm-up breaches the cap before any timed
request, it excludes the remaining recordings for that runtime: no recording
can safely start under that cap. The run stops rather than starting another
process if shutdown fails. The 8 GiB cap is per runtime process tree, not a
machine-wide limit or a safe configuration promise for an 8 GiB Mac. This is
not a hard memory limit: a post-response sample cannot prevent an oversized
allocation while a request is running. If a runtime fails before responding,
inspect its recorded error and treat its coverage as incomplete.

Each long recording is sent as one complete recording. The benchmark never
chunks or merges long audio. A runtime may have its own documented long-audio
strategy, but the benchmark does not supply one. When long coverage is
incomplete, the result omits long quality and speed metrics rather than ranking
partial coverage against complete coverage.

## Reference performance and run duration

These observations are examples, not minimum performance requirements or time
guarantees. The complete seven-runtime run used an Apple M1 Pro with 16 GiB
unified memory, Darwin 23.6.0, and Node 24.15.0. It measured 243 short and 21 long
recordings in nine languages, with three sequential passes and cached models
and audio. Results vary with hardware, software versions, and system load.

Run `20260926T200529280Z-9ae2073cd42e` started on September 26, 2026 and
finished on September 27. Benchmark revision: `c6fd709`. Wasper reported version
1.8.0, but used a locally rebuilt binary, not the public 1.8.0 release binary.
Its native-server SHA-256 was
`cfdf876a127e2950a02b3ec86f80ef474bc65942048b7961f81b84388ae0408f`.
The runtime-lock SHA-256 was
`cf8c9add41c938c0f555250d7e5b222bf3b1d4a7b25ff92395bbb82a5960eb97`.
The corpus SHA-256 was
`dd13fc3bb9decd6434e56fff5ac482b3318d663a63e41e79542f96515118a8d2`.

### Latest results by runtime

Speed is the median per-request audio duration divided by response time,
expressed as multiples of real time. Higher is faster. WER is pooled across
reference words. Each runtime completed all 729 short requests.

Wasper and Handy use the September 27 rerun
`20260927T140008721Z-953975f360a6`; the other rows use the seven-runtime run
identified above. Both sessions used the same benchmark revision, model cache,
corpus, and three-pass protocol.

| Runtime | Short speed | Short WER | Long speed | Long WER | Long completed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Wasper Metal INT8 | 84.87× | 9.33% | 133.69× | 26.52% | 63/63 |
| MLX Community F32/BF16 | 27.12× | 8.36% | 29.34× | 35.16% | 63/63 |
| Local MLX INT8 | 45.28× | 8.40% | 46.06× | 35.05% | 63/63 |
| Handy Q8 | 57.86× | 8.63% | Not ranked | Not ranked | 27/63 |
| NVIDIA Q8 | 46.98× | 8.59% | Not ranked | Not ranked | 60/63 |
| Istupakov ONNX INT8 | 33.75× | 9.82% | Not ranked | Not ranked | 6/63 |
| Fluid Core ML | 11.52× | 8.59% | 31.79× | 20.38% | 63/63 |

The seven-runtime run saved all 5,544 request outcomes. The 96 long-request errors were Handy
loading or allocation failures, NVIDIA empty output on the Dutch recording,
and Istupakov attention-shape failures. Incomplete long cohorts are not ranked.
Zero post-response memory exclusions did not mean peak usage stayed below
8 GiB: monitoring observed roughly 23–26 GiB during failed Istupakov requests.
See the memory measurement limitations above.

### Elapsed time by engine

These durations refer to the complete seven-runtime run, not the two-runtime
rerun. The approximate durations include startup, discarded warm-ups, memory
sampling, failed requests, and result saving. They are not inference-only
timings. Downloads, initial setup, and the preliminary smoke check are excluded.

| Runtime | Pass 1 | Pass 2 | Pass 3 | Total |
| --- | ---: | ---: | ---: | ---: |
| Wasper Metal INT8 | 6m 31s | 6m 20s | 6m 19s | 19m 09s |
| MLX Community F32/BF16 | 17m 08s | 17m 43s | 16m 57s | 51m 48s |
| Local MLX INT8 | 10m 38s | 11m 11s | 10m 17s | 32m 07s |
| Handy Q8 | 10m 26s | 10m 31s | 10m 10s | 31m 06s |
| NVIDIA Q8 | 18m 13s | 18m 09s | 17m 56s | 54m 18s |
| Istupakov ONNX INT8 | 13m 18s | 12m 13s | 11m 46s | 37m 17s |
| Fluid Core ML | 18m 38s | 17m 53s | 17m 47s | 54m 18s |
| Entire run | | | | 4h 40m 04s |

Durations were reconstructed from request-file modification times in execution
order. Each engine interval starts at the preceding engine's last saved result
and ends at its own last saved result. The first interval starts at `createdAt`
in `run.json`; the entire run ends at the `report.md` modification time.
Transition overhead belongs to the next engine. Totals use unrounded durations,
so rounded pass values may not sum exactly. File-copy operations can change
modification times; this method requires the original run directory.

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

The short corpus contains 243 automatically recoverable entries. All 21 long
entries have automatic public sources. The [archived White House audio and
transcript](https://georgewbush-whitehouse.archives.gov/news/releases/2009/01/print/20090115-17.html)
and the [Royal Household's audio and subtitle downloads](https://www.koninklijkhuis.nl/documenten/videos/2015/12/25/kersttoespraak-2015)
produce the exact frozen source, normalized audio, and lexical-reference
hashes. The manifests record source URLs, terms, licenses, and hashes:

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
