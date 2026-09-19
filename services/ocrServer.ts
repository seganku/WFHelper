import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { withScope } from "./logger";
import { resolveRuntimeResourcePath } from "./runtimeResources";

const log = withScope("ocrServer");

const READY_MARKER = "===OCR_SERVER_READY===";
const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESTARTS = 3;
const RESTART_BASE_DELAY_MS = 1_500;
const SHUTDOWN_GRACE_MS = 1_000;
/** Windows OCR workers cost roughly 80-120 MB each. Reward scans peak at 3 slots
 * plus 1 riven overlap, so cap at 4; default 2, WF_OCR_SERVER_POOL overrides. */
const OCR_SERVER_POOL_SIZE = Math.max(
  1,
  Math.min(4, Number.parseInt(String(process.env.WF_OCR_SERVER_POOL || "2"), 10) || 2),
);

const OCR_SERVER_SCRIPT = resolveRuntimeResourcePath("scripts", "ocr-server.ps1");
const OCR_HELPER_COMMAND: { command: string; args: string[] } = {
  command: "powershell",
  args: ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-NoProfile", "-File", OCR_SERVER_SCRIPT],
};

interface StructuredOcrBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StructuredOcrWord {
  text: string;
  box: StructuredOcrBox;
}

interface StructuredOcrLine {
  text: string;
  box: StructuredOcrBox;
  words: StructuredOcrWord[];
}

export interface StructuredOcrResult {
  text: string;
  lines: StructuredOcrLine[];
}

interface OcrHelperRequest {
  id: string;
  imagePath?: string;
  imageBase64?: string;
}

interface OcrHelperResponse {
  id?: string;
  ok?: boolean;
  error?: string;
  result?: StructuredOcrResult;
}

interface QueuedRequest {
  payload: OcrHelperRequest;
  resolve: (result: StructuredOcrResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Report malformed output without flooding the log.
const MALFORMED_WARN_INTERVAL_MS = 30_000;

// Latch WinRT initialization failures instead of respawning for every crop.
const ENGINE_UNAVAILABLE_RETRY_MS = 10 * 60_000;

let _engineUnavailableReason: string | null = null;
let _engineUnavailableAt = 0;
let _nativeOcrOkAt = 0;

function noteEngineUnavailable(reason: string): void {
  _engineUnavailableReason = reason;
  _engineUnavailableAt = Date.now();
  log.warn(`[OcrServer] Engine unavailable, pausing server spawns: ${reason}`);
}

function latchedEngineError(): Error | null {
  if (!_engineUnavailableReason) return null;
  if (Date.now() - _engineUnavailableAt >= ENGINE_UNAVAILABLE_RETRY_MS) {
    // OCR language packs can get installed while we run - allow a fresh probe
    _engineUnavailableReason = null;
    return null;
  }
  return new Error(`Windows OCR unavailable: ${_engineUnavailableReason}`);
}

/** False only after the helper explicitly reported an unusable WinRT OCR engine. */
export function getWindowsOcrHealth(): { available: boolean; reason: string | null } {
  if (_engineUnavailableReason && _nativeOcrOkAt <= _engineUnavailableAt) {
    return { available: false, reason: _engineUnavailableReason };
  }
  return { available: true, reason: null };
}

function parseStartupErrorLine(stdoutBuf: string): string | null {
  for (const line of stdoutBuf.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as OcrHelperResponse;
      if (parsed?.id === "startup" && parsed.ok === false && parsed.error) {
        return String(parsed.error);
      }
    } catch {
      // partial or non-JSON output
    }
  }
  return null;
}

class OcrServerWorker {
  private _proc: ChildProcessWithoutNullStreams | null = null;
  private _ready = false;
  private _starting = false;
  private _startPromise: Promise<void> | null = null;
  private _stdoutBuf = "";
  private _queue: QueuedRequest[] = [];
  private _inflight: QueuedRequest | null = null;
  private _restartCount = 0;
  private _disposed = false;
  private _requestSeq = 0;
  private _malformedLineCount = 0;
  private _lastMalformedWarnAt = 0;

  async warmup(): Promise<void> {
    try {
      await this._ensureReady();
    } catch {
      // best effort only
    }
  }

  getPendingCount(): number {
    return this._queue.length + (this._inflight ? 1 : 0) + (this._starting ? 1 : 0);
  }

  async runOCR(imagePath: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    const result = await this.runOCRStructured({ imagePath }, timeoutMs);
    return result.text || "";
  }

  async runOCRBuffer(imageBuffer: Buffer, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    const result = await this.runOCRStructured(
      { imageBase64: imageBuffer.toString("base64") },
      timeoutMs,
    );
    return result.text || "";
  }

  async runOCRStructured(
    request: { imagePath?: string; imageBase64?: string },
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<StructuredOcrResult> {
    if (this._disposed) throw new Error("OCR server has been disposed");
    await this._ensureReady();
    return this._enqueue(request, timeoutMs);
  }

  private async _ensureReady(): Promise<void> {
    if (this._ready && this._proc && !this._proc.killed) return;
    // The helper is a PowerShell script over Windows.Media.Ocr; there is no
    // other platform to spawn it on, and trying costs a startup timeout.
    if (process.platform !== "win32") {
      throw new Error("Windows OCR is unavailable on this platform");
    }
    const latched = latchedEngineError();
    if (latched) throw latched;
    if (this._starting && this._startPromise) return this._startPromise;
    this._startPromise = this._spawn().then(
      () => {
        this._startPromise = null;
      },
      (err) => {
        this._starting = false;
        this._startPromise = null;
        throw err;
      },
    );
    return this._startPromise;
  }

  private _spawn(): Promise<void> {
    this._starting = true;
    this._ready = false;
    this._stdoutBuf = "";

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(OCR_HELPER_COMMAND.command, OCR_HELPER_COMMAND.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderrTail = "";

      let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        startupTimer = null;
        proc.kill();
        reject(new Error("OCR server startup timed out"));
      }, STARTUP_TIMEOUT_MS);

      const clearStartup = (): void => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        this._stdoutBuf += chunk;

        if (!this._ready) {
          const idx = this._stdoutBuf.indexOf(READY_MARKER);
          if (idx !== -1) {
            clearStartup();
            this._stdoutBuf = this._stdoutBuf
              .slice(idx + READY_MARKER.length)
              .replace(/^\r?\n/, "");
            this._ready = true;
            this._starting = false;
            this._proc = proc;
            this._restartCount = 0;
            log.info("[OcrServer] Server ready");
            resolve();
          }
          return;
        }

        this._drainBuffer();
      });

      // Without this a failed spawn (ENOENT) raises an uncaught exception.
      proc.on("error", (err: Error) => {
        clearStartup();
        this._ready = false;
        this._proc = null;
        this._starting = false;
        noteEngineUnavailable(`OCR helper could not be started: ${err.message}`);
        reject(err);
      });

      proc.stderr.on("data", (chunk: string) => {
        const msg = String(chunk).trim();
        if (!msg) return;
        stderrTail = `${stderrTail} ${msg}`.trim().slice(-400);
        log.warn("[OcrServer] stderr:", msg);
      });

      proc.on("close", (code) => {
        clearStartup();
        const wasReady = this._ready;
        this._ready = false;
        this._proc = null;
        this._starting = false;

        if (!wasReady) {
          // ps1 reports engine-init failures as a startup JSON line on stdout
          const startupError = parseStartupErrorLine(this._stdoutBuf);
          if (startupError) noteEngineUnavailable(startupError);
          const detail = startupError || stderrTail;
          reject(
            new Error(
              `OCR server exited before ready (code=${code ?? "null"})${detail ? `: ${detail}` : ""}`,
            ),
          );
          return;
        }

        log.warn(`[OcrServer] Process exited (code=${code ?? "null"})`);

        if (this._inflight) {
          clearTimeout(this._inflight.timeoutHandle);
          this._inflight.reject(new Error("OCR server exited during request"));
          this._inflight = null;
        }

        if (!this._disposed) this._scheduleRestart();
      });
    });
  }

  private _scheduleRestart(): void {
    if (this._restartCount >= MAX_RESTARTS) {
      log.warn(`[OcrServer] Exceeded restart limit (${MAX_RESTARTS}), not restarting`);
      for (const req of this._queue) {
        clearTimeout(req.timeoutHandle);
        req.reject(new Error("OCR server unavailable after max restarts"));
      }
      this._queue = [];
      return;
    }

    this._restartCount += 1;
    const delay = RESTART_BASE_DELAY_MS * this._restartCount;
    log.info(
      `[OcrServer] Restarting in ${delay}ms (attempt ${this._restartCount}/${MAX_RESTARTS})`,
    );
    setTimeout(() => {
      if (this._disposed) return;
      this._spawn().catch((err) => {
        log.warn("[OcrServer] Restart failed:", String(err));
        this._scheduleRestart();
      });
    }, delay);
  }

  private _enqueue(
    request: { imagePath?: string; imageBase64?: string },
    timeoutMs: number,
  ): Promise<StructuredOcrResult> {
    return new Promise<StructuredOcrResult>((resolve, reject) => {
      const payload: OcrHelperRequest = {
        id: `ocr-${++this._requestSeq}`,
        ...(request.imagePath ? { imagePath: request.imagePath } : {}),
        ...(request.imageBase64 ? { imageBase64: request.imageBase64 } : {}),
      };

      const req: QueuedRequest = {
        payload,
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          this._queue = this._queue.filter((queued) => queued !== req);
          if (this._inflight === req) {
            this._inflight = null;
            this._proc?.kill();
          }
          reject(new Error(`OCR timed out for request ${payload.id}`));
        }, timeoutMs),
      };

      this._queue.push(req);
      this._pump();
    });
  }

  private _pump(): void {
    if (this._inflight) return;
    if (this._queue.length === 0) return;
    if (!this._ready || !this._proc) return;

    const req = this._queue.shift()!;
    this._inflight = req;
    this._proc.stdin.write(JSON.stringify(req.payload) + "\n");
  }

  private _drainBuffer(): void {
    while (true) {
      const newlineIndex = this._stdoutBuf.indexOf("\n");
      if (newlineIndex === -1) return;

      const rawLine = this._stdoutBuf.slice(0, newlineIndex).trim();
      this._stdoutBuf = this._stdoutBuf.slice(newlineIndex + 1);
      if (!rawLine) continue;

      let response: OcrHelperResponse;
      try {
        response = JSON.parse(rawLine) as OcrHelperResponse;
      } catch {
        this._malformedLineCount += 1;
        const now = Date.now();
        if (now - this._lastMalformedWarnAt >= MALFORMED_WARN_INTERVAL_MS) {
          log.warn(
            `OCR helper emitted ${this._malformedLineCount} malformed stdout line(s); latest preview: ${rawLine.slice(0, 120)}`,
          );
          this._lastMalformedWarnAt = now;
          this._malformedLineCount = 0;
        }
        continue;
      }

      const req = this._inflight;
      if (!req) continue;
      if (response.id && response.id !== req.payload.id) continue;

      this._inflight = null;
      clearTimeout(req.timeoutHandle);

      if (!response.ok || !response.result) {
        req.reject(new Error(`Windows OCR error: ${response.error || "unknown error"}`));
      } else {
        req.resolve(response.result);
      }

      this._pump();
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._proc) {
      try {
        this._proc.stdin.write("EXIT\n");
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this._proc && !this._proc.killed) this._proc.kill();
      }, SHUTDOWN_GRACE_MS);
    }

    for (const req of this._queue) {
      clearTimeout(req.timeoutHandle);
      req.reject(new Error("OCR server disposed"));
    }
    this._queue = [];

    if (this._inflight) {
      clearTimeout(this._inflight.timeoutHandle);
      this._inflight.reject(new Error("OCR server disposed"));
      this._inflight = null;
    }
  }
}

class OcrServerPool {
  private _workers: OcrServerWorker[];

  constructor(size: number) {
    this._workers = Array.from({ length: size }, () => new OcrServerWorker());
  }

  private _pickWorker(): OcrServerWorker {
    return this._workers.reduce((best, current) =>
      current.getPendingCount() < best.getPendingCount() ? current : best,
    );
  }

  async warmup(): Promise<void> {
    await Promise.all(this._workers.map((worker) => worker.warmup()));
  }

  async runOCR(imagePath: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    return this._pickWorker().runOCR(imagePath, timeoutMs);
  }

  async runOCRBuffer(imageBuffer: Buffer, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    return this._pickWorker().runOCRBuffer(imageBuffer, timeoutMs);
  }

  async runOCRStructured(
    request: { imagePath?: string; imageBase64?: string },
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<StructuredOcrResult> {
    return this._pickWorker().runOCRStructured(request, timeoutMs);
  }

  dispose(): void {
    for (const worker of this._workers) worker.dispose();
  }
}

export const ocrServer = new OcrServerPool(OCR_SERVER_POOL_SIZE);

// @napi-rs/system-ocr calls Windows Media.Ocr natively (no PowerShell pool
// IPC); falls back to the pool when the native module fails to load.

type NativeRecognize = (
  input: string,
  accuracy?: number | null,
  preferredLangs?: string[] | null,
  signal?: AbortSignal | null,
) => Promise<{ text: string; confidence: number }>;

let _nativeRecognize: NativeRecognize | null = null;

try {
  const mod = require("@napi-rs/system-ocr") as { recognize: NativeRecognize };
  _nativeRecognize = mod.recognize;
  log.info("[OcrServer] Native OCR engine loaded (@napi-rs/system-ocr)");
} catch {
  log.info("[OcrServer] Native OCR engine not available, using PowerShell pool");
}

export const nativeOcrAvailable = !!_nativeRecognize;

const _nativeOcrInFlight = new Set<Promise<unknown>>();
let _nativeOcrSeq = 0;

/** The addon is pulled in with require(), which module mocking cannot reach. */
export function setNativeRecognizeForTest(recognize: NativeRecognize | null): void {
  _nativeRecognize = recognize;
}

async function runNativeOcr(
  recognize: NativeRecognize,
  input: string,
  timeoutMs: number | undefined,
  label: string,
): Promise<string> {
  if (typeof input !== "string") {
    throw new TypeError(`${label}: native OCR takes a path, not a buffer`);
  }
  const controller = new AbortController();
  const started = recognize(input, null, null, controller.signal);
  _nativeOcrInFlight.add(started);
  const settled = started.finally(() => _nativeOcrInFlight.delete(started));

  if (!timeoutMs || timeoutMs <= 0) {
    const result = await settled;
    _nativeOcrOkAt = Date.now();
    return result.text || "";
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([settled, expiry]);
    _nativeOcrOkAt = Date.now();
    return result.text || "";
  } catch (err) {
    await settled.catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const _scratchFree: string[] = [];
const _scratchAll = new Set<string>();

const SCRATCH_PREFIX = "wfhelper-ocr-";
let _scratchSwept = false;

// A kill leaves the pid's scratch files behind, so reclaim earlier runs' once.
// Windows refuses to unlink a file another live instance still holds open.
function sweepStaleScratchFiles(): void {
  if (_scratchSwept) return;
  _scratchSwept = true;
  const mine = `${SCRATCH_PREFIX}${process.pid}-`;
  const dir = os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX) || !name.endsWith(".png")) continue;
    if (name.startsWith(mine)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // ignore
    }
  }
}

function acquireScratchPath(): string {
  sweepStaleScratchFiles();
  const reused = _scratchFree.pop();
  if (reused) return reused;
  const created = path.join(os.tmpdir(), `${SCRATCH_PREFIX}${process.pid}-${_nativeOcrSeq++}.png`);
  _scratchAll.add(created);
  return created;
}

function removeScratchFiles(): void {
  for (const scratch of _scratchAll) {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      // a scratch file the addon still holds open outlives the process instead
    }
  }
  _scratchAll.clear();
  _scratchFree.length = 0;
}

export async function drainNativeOcr(timeoutMs = 5000): Promise<void> {
  try {
    if (_nativeOcrInFlight.size === 0) return;
    const pending = Promise.allSettled([..._nativeOcrInFlight]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } finally {
    removeScratchFiles();
  }
}

// The addon takes a napi reference for a Uint8Array and drops it inside its
// libuv-worker task, so `napi_delete_reference` runs off the JS thread and
// corrupts the reference list. The path overload holds no reference.
export async function nativeOcrBuffer(imageBuffer: Buffer, timeoutMs?: number): Promise<string> {
  if (!_nativeRecognize) throw new Error("Native OCR not available");
  const scratch = acquireScratchPath();
  try {
    await fs.promises.writeFile(scratch, imageBuffer);
    return await runNativeOcr(_nativeRecognize, scratch, timeoutMs, "nativeOcrBuffer");
  } finally {
    _scratchAll.add(scratch);
    _scratchFree.push(scratch);
  }
}

export async function nativeOcrFile(imagePath: string, timeoutMs?: number): Promise<string> {
  if (!_nativeRecognize) throw new Error("Native OCR not available");
  return await runNativeOcr(_nativeRecognize, imagePath, timeoutMs, "nativeOcrFile");
}
