import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  input: Buffer | string;
  signal: AbortSignal | null | undefined;
  settle: (text: string) => void;
  fail: (err: Error) => void;
  promise: Promise<{ text: string; confidence: number }>;
}

const probe = vi.hoisted(() => ({ calls: [] as Call[] }));

const recognize = (
  input: Buffer | string,
  _accuracy?: number | null,
  _langs?: string[] | null,
  signal?: AbortSignal | null,
) => {
  let settle!: (text: string) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<{ text: string; confidence: number }>((resolve, reject) => {
    settle = (text) => resolve({ text, confidence: 1 });
    fail = reject;
  });
  probe.calls.push({ input, signal, settle, fail, promise });
  return promise;
};

async function load() {
  vi.resetModules();
  probe.calls = [];
  const mod = await import("../../services/ocrServer");
  mod.setNativeRecognizeForTest(recognize);
  return mod;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("native OCR lifetime", () => {
  it("hands the addon a signal it can cancel on", async () => {
    const ocr = await load();

    const run = ocr.nativeOcrFile("scan.png", 1000);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(probe.calls[0].signal?.aborted).toBe(false);

    probe.calls[0].settle("hello");
    await expect(run).resolves.toBe("hello");
  });

  it("aborts the native task when the deadline passes instead of abandoning it", async () => {
    const ocr = await load();

    const run = ocr.nativeOcrFile("scan.png", 500);
    const settled = expect(run).rejects.toThrow(/timeout after 500ms/);

    await vi.advanceTimersByTimeAsync(500);
    expect(probe.calls[0].signal?.aborted).toBe(true);

    probe.calls[0].fail(new Error("aborted"));
    await settled;
  });

  it("does not leave a rejected abandoned task unhandled", async () => {
    const ocr = await load();

    const run = ocr.nativeOcrFile("scan.png", 500);
    const settled = expect(run).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(500);

    probe.calls[0].fail(new Error("addon exploded"));

    await settled;
    await vi.advanceTimersByTimeAsync(0);
  });

  it("waits for work that is still inside the addon before shutdown continues", async () => {
    const ocr = await load();

    void ocr.nativeOcrFile("scan.png", 0).catch(() => undefined);
    let drained = false;
    void ocr.drainNativeOcr(5000).then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    probe.calls[0].settle("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
  });

  it("gives up draining rather than blocking shutdown forever", async () => {
    const ocr = await load();

    void ocr.nativeOcrFile("scan.png", 0).catch(() => undefined);
    let drained = false;
    void ocr.drainNativeOcr(1000).then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(drained).toBe(true);

    probe.calls[0].settle("late");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("returns at once when nothing is in flight", async () => {
    const ocr = await load();

    await expect(ocr.drainNativeOcr(1000)).resolves.toBeUndefined();
  });
});

describe("native OCR never hands the addon a buffer", () => {
  // Real timers here: these assert real disk I/O, which a faked clock starves.
  beforeEach(() => {
    vi.useRealTimers();
  });

  async function settleIo(check: () => boolean) {
    for (let i = 0; i < 600 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("passes a file path so the addon takes no napi reference", async () => {
    const ocr = await load();

    const run = ocr.nativeOcrBuffer(Buffer.from("pixels"), 0);
    await settleIo(() => probe.calls.length > 0);

    expect(probe.calls).toHaveLength(1);
    expect(typeof probe.calls[0].input).toBe("string");
    expect(probe.calls[0].input).toMatch(/wfhelper-ocr-.*\.png$/);

    probe.calls[0].settle("text");
    await expect(run).resolves.toBe("text");
    await ocr.drainNativeOcr(1000);
  });

  it("reuses one scratch file across reads and drops it on shutdown", async () => {
    const ocr = await load();

    const first = ocr.nativeOcrBuffer(Buffer.from("pixels"), 0);
    await settleIo(() => probe.calls.length > 0);
    const scratch = probe.calls[0].input as string;
    probe.calls[0].settle("text");
    await first;

    const second = ocr.nativeOcrBuffer(Buffer.from("more pixels"), 0);
    await settleIo(() => probe.calls.length > 1);
    expect(probe.calls[1].input).toBe(scratch);
    probe.calls[1].settle("text");
    await second;

    expect(fs.existsSync(scratch)).toBe(true);
    await ocr.drainNativeOcr(1000);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("gives two overlapping reads scratch files of their own", async () => {
    const ocr = await load();

    const first = ocr.nativeOcrBuffer(Buffer.from("pixels"), 0);
    const second = ocr.nativeOcrBuffer(Buffer.from("more pixels"), 0);
    await settleIo(() => probe.calls.length > 1);

    expect(probe.calls[0].input).not.toBe(probe.calls[1].input);

    probe.calls[0].settle("text");
    probe.calls[1].settle("text");
    await Promise.all([first, second]);
    await ocr.drainNativeOcr(1000);
  });
});
