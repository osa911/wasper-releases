'use strict';

const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const readline = require('node:readline');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUTS = Object.freeze({
  startupMs: 10 * 60_000,
  healthRequestMs: 5_000,
  transcriptionMs: 30 * 60_000,
  stopMs: 5_000,
  healthPollIntervalMs: 250,
});

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function processFailure(message, child, stderr) {
  const error = new Error(`${message}; pid=${child?.pid ?? 'none'}; stderr=${stderr.join('')}`);
  error.code = 'ADAPTER_PROCESS_CRASHED';
  return error;
}

class AdapterTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

function normalizedTimeouts(overrides = {}) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...overrides };
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`process client timeout ${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(timeouts);
}

function normalizedTranscribeFormFields(transport) {
  const formFields = transport.formFields ?? {};
  if (formFields === null || typeof formFields !== 'object' || Array.isArray(formFields)) {
    throw new TypeError('HTTP runtime transport formFields must be an object');
  }
  return Object.freeze(
    Object.entries(formFields).map(([name, value]) => {
      if (name === transport.fileField) {
        throw new TypeError('HTTP runtime transport formFields must not replace the audio field');
      }
      if (typeof value !== 'string' || value === '') {
        throw new TypeError(`HTTP runtime transport formFields.${name} must be a non-empty string`);
      }
      return Object.freeze([name, value]);
    })
  );
}

function descendantsFromProcessTable(rootPid, processTable) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, ppid } of processTable) {
      if (descendants.has(ppid) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return [...descendants].sort((left, right) => left - right).map(pid => ({ pid }));
}

function createProcessClient(
  { definition, modelIdentityHash },
  {
    timeouts: timeoutOverrides,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    execFileAsyncImpl = execFileAsync,
    delayImpl = delay,
    now = Date.now,
  } = {}
) {
  const timeouts = normalizedTimeouts(timeoutOverrides);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (typeof execFileAsyncImpl !== 'function')
    throw new TypeError('execFileAsyncImpl must be a function');
  if (typeof delayImpl !== 'function') throw new TypeError('delayImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const transcribeFormFields = normalizedTranscribeFormFields(definition.transport);
  let child = null;
  let residentIdentity = null;
  let lineReader = null;
  let nextRequestId = 0;
  const pending = new Map();
  const stderr = [];
  const stderrWaiters = new Set();

  function ensureRunning() {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw processFailure('resident runtime is not running', child, stderr);
    }
  }

  function handleJsonLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(response.requestId);
    if (!waiter) return;
    pending.delete(response.requestId);
    if (response.error) waiter.reject(new Error(response.error));
    else waiter.resolve(response);
  }

  function stderrMatch(pattern) {
    pattern.lastIndex = 0;
    const match = pattern.exec(stderr.join(''));
    pattern.lastIndex = 0;
    return match?.[0] ?? null;
  }

  function resolveStderrWaiters() {
    for (const waiter of [...stderrWaiters]) {
      const match = stderrMatch(waiter.pattern);
      if (match === null) continue;
      clearTimeout(waiter.timer);
      stderrWaiters.delete(waiter);
      waiter.resolve(match);
    }
  }

  function rejectStderrWaiters(error) {
    for (const waiter of stderrWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    stderrWaiters.clear();
  }

  function waitForStderr(pattern, timeoutMs) {
    ensureRunning();
    if (!(pattern instanceof RegExp))
      throw new TypeError('stderr pattern must be a regular expression');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('stderr timeout must be a positive safe integer');
    }
    const existing = stderrMatch(pattern);
    if (existing !== null) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { pattern, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        stderrWaiters.delete(waiter);
        reject(new AdapterTimeoutError('stderr', timeoutMs));
      }, timeoutMs);
      waiter.timer.unref?.();
      stderrWaiters.add(waiter);
    });
  }

  async function jsonlRequest(type, payload = {}) {
    ensureRunning();
    const requestId = String(++nextRequestId);
    const timeoutMs =
      type === 'health'
        ? timeouts.healthRequestMs
        : type === 'stop'
          ? timeouts.stopMs
          : timeouts.transcriptionMs;
    const outcome = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new AdapterTimeoutError(type, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ requestId, type, ...payload })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(requestId);
      if (!waiter) return;
      pending.delete(requestId);
      waiter.reject(error);
    });
    return outcome;
  }

  async function httpJson(pathname, init, operation, timeoutMs) {
    const controller = new AbortController();
    const timeoutError = new AdapterTimeoutError(operation, timeoutMs);
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`http://127.0.0.1:${definition.transport.port}${pathname}`, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
      try {
        return JSON.parse(body);
      } catch {
        return { text: body };
      }
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rawHealth() {
    return definition.transport.kind === 'jsonl'
      ? jsonlRequest('health')
      : httpJson(definition.transport.healthPath, undefined, 'health', timeouts.healthRequestMs);
  }

  async function waitForHealth() {
    const startedAt = now();
    let lastError;
    while (now() - startedAt < timeouts.startupMs) {
      ensureRunning();
      try {
        return await rawHealth();
      } catch (error) {
        if (error?.code === 'ADAPTER_PROCESS_CRASHED') throw error;
        lastError = error;
        const remainingMs = timeouts.startupMs - (now() - startedAt);
        if (remainingMs > 0) {
          await delayImpl(Math.min(timeouts.healthPollIntervalMs, remainingMs));
        }
      }
    }
    const error = new AdapterTimeoutError('startup', timeouts.startupMs);
    if (lastError) error.cause = lastError;
    throw error;
  }

  async function transcribeHttp(audioPath) {
    const bytes = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append(
      definition.transport.fileField,
      new Blob([bytes], { type: 'audio/wav' }),
      path.basename(audioPath)
    );
    for (const [name, value] of transcribeFormFields) form.append(name, value);
    const response = await httpJson(
      definition.transport.transcribePath,
      {
        method: 'POST',
        body: form,
      },
      'transcribe',
      timeouts.transcriptionMs
    );
    let encoderBucketFrames;
    if (Object.hasOwn(response, 'encoder_bucket_frames')) {
      if (
        !Number.isSafeInteger(response.encoder_bucket_frames) ||
        response.encoder_bucket_frames <= 0
      ) {
        throw new TypeError('transcribe response encoder_bucket_frames must be a positive integer');
      }
      encoderBucketFrames = response.encoder_bucket_frames;
    }
    return {
      rawTranscript: response.text ?? response.transcript ?? '',
      responseMetadata: {
        ...(response.detected_language ? { detectedLanguage: response.detected_language } : {}),
        ...(response.language ? { detectedLanguage: response.language } : {}),
      },
      ...(encoderBucketFrames === undefined ? {} : { encoderBucketFrames }),
      residentIdentity,
    };
  }

  async function start() {
    if (child) throw new Error('resident runtime client is already started');
    child = spawnImpl(definition.command, definition.args, {
      env: { ...process.env, ...definition.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', chunk => {
      stderr.push(chunk.toString());
      if (stderr.length > 200) stderr.shift();
      resolveStderrWaiters();
    });
    child.once('exit', (code, signal) => {
      const error = processFailure(
        `resident runtime exited code=${code} signal=${signal}`,
        child,
        stderr
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      rejectStderrWaiters(error);
    });
    if (definition.transport.kind === 'jsonl') {
      lineReader = readline.createInterface({ input: child.stdout });
      lineReader.on('line', handleJsonLine);
    }
    residentIdentity = {
      processId: `pid:${child.pid}`,
      modelLoadId: `model-load:${randomUUID()}`,
      modelIdentityHash,
    };
    try {
      await waitForHealth();
    } catch (error) {
      await terminateChild();
      throw error;
    }
    return { residentIdentity };
  }

  async function request(type, payload) {
    if (type === 'health') {
      const raw = await rawHealth();
      return {
        status: 'ok',
        residentIdentity,
        runtime: { ...definition.runtime, reported: raw.runtime ?? raw },
        model: {
          id: definition.modelIdentity,
          path: definition.modelPath,
          quantization: definition.quantization,
        },
      };
    }
    if (type === 'cache-stats') {
      if (definition.transport.kind !== 'http') {
        throw new Error('cache statistics require an HTTP runtime');
      }
      return httpJson('/_debug/cache-stats', undefined, 'cache-stats', timeouts.healthRequestMs);
    }
    if (definition.transport.kind === 'http') return transcribeHttp(payload.audioPath);
    const response = await jsonlRequest('transcribe', { audioPath: payload.audioPath });
    return {
      rawTranscript: response.text ?? response.transcript ?? '',
      responseMetadata: response.detectedLanguage
        ? { detectedLanguage: response.detectedLanguage }
        : {},
      ...(Number.isSafeInteger(response.encoderBucketFrames) && response.encoderBucketFrames > 0
        ? { encoderBucketFrames: response.encoderBucketFrames }
        : {}),
      residentIdentity,
    };
  }

  async function ownedProcessTree() {
    ensureRunning();
    const { stdout } = await execFileAsyncImpl('/bin/ps', ['-axo', 'pid=,ppid=']);
    const table = stdout
      .trim()
      .split('\n')
      .map(line => line.trim().split(/\s+/u).map(Number))
      .filter(parts => parts.length === 2 && parts.every(Number.isInteger))
      .map(([pid, ppid]) => ({ pid, ppid }));
    return { processes: descendantsFromProcessTable(child.pid, table) };
  }

  async function terminateChild() {
    if (!child) return;
    const running = child.exitCode === null && child.signalCode === null;
    const stopped = running
      ? new Promise(resolve => child.once('exit', resolve))
      : Promise.resolve();
    if (running && definition.transport.kind === 'jsonl') {
      try {
        await jsonlRequest('stop');
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([stopped, delayImpl(timeouts.stopMs)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    lineReader?.close();
    child = null;
    residentIdentity = null;
  }

  async function stop() {
    ensureRunning();
    await terminateChild();
  }

  return { start, request, waitForStderr, ownedProcessTree, stop };
}

module.exports = {
  AdapterTimeoutError,
  DEFAULT_TIMEOUTS,
  createProcessClient,
  descendantsFromProcessTable,
};
