import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summarizeCrashDump } from "../../services/minidumpSummary";

let dir = "";

interface ThreadSpec {
  id: number;
  name?: string;
}

interface DumpSpec {
  code: number;
  faultingThread: number;
  address: bigint;
  threads: ThreadSpec[];
  module?: { base: bigint; size: number; name: string };
  addons?: string[];
  declaredModules?: number;
}

/** Minimal MDMP: header, directory, exception, thread list, thread names and an
 *  optional module, laid out the way Crashpad writes them. */
function buildDump(spec: DumpSpec): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;
  const put = (buf: Buffer): number => {
    const at = cursor;
    chunks.push(buf);
    cursor += buf.length;
    return at;
  };

  const utf16 = (value: string): Buffer => {
    const text = Buffer.from(value, "utf16le");
    const out = Buffer.alloc(4 + text.length + 2);
    out.writeUInt32LE(text.length, 0);
    text.copy(out, 4);
    return out;
  };

  put(Buffer.alloc(32)); // header, filled in last

  const nameRvas = new Map<number, number>();
  for (const thread of spec.threads) {
    if (thread.name) nameRvas.set(thread.id, put(utf16(thread.name)));
  }
  const moduleNameRva = spec.module ? put(utf16(spec.module.name)) : 0;
  const addonNameRvas = (spec.addons ?? []).map((name) => put(utf16(name)));

  const exception = Buffer.alloc(168);
  exception.writeUInt32LE(spec.faultingThread, 0);
  exception.writeUInt32LE(spec.code, 8);
  exception.writeBigUInt64LE(spec.address, 8 + 16);
  const exceptionRva = put(exception);

  const threadList = Buffer.alloc(4 + spec.threads.length * 48);
  threadList.writeUInt32LE(spec.threads.length, 0);
  spec.threads.forEach((thread, i) => threadList.writeUInt32LE(thread.id, 4 + i * 48));
  const threadListRva = put(threadList);

  const named = spec.threads.filter((thread) => thread.name);
  const names = Buffer.alloc(4 + named.length * 12);
  names.writeUInt32LE(named.length, 0);
  named.forEach((thread, i) => {
    names.writeUInt32LE(thread.id, 4 + i * 12);
    names.writeBigUInt64LE(BigInt(nameRvas.get(thread.id) ?? 0), 4 + i * 12 + 4);
  });
  const namesRva = put(names);

  let moduleListRva = 0;
  if (spec.module || addonNameRvas.length) {
    const rows = (spec.module ? 1 : 0) + addonNameRvas.length;
    const modules = Buffer.alloc(4 + rows * 108);
    modules.writeUInt32LE(spec.declaredModules ?? rows, 0);
    let row = 0;
    if (spec.module) {
      const at = 4 + row * 108;
      modules.writeBigUInt64LE(spec.module.base, at);
      modules.writeUInt32LE(spec.module.size, at + 8);
      modules.writeUInt32LE(moduleNameRva, at + 20);
      row++;
    }
    for (const rva of addonNameRvas) {
      const at = 4 + row * 108;
      modules.writeBigUInt64LE(0n, at);
      modules.writeUInt32LE(0, at + 8);
      modules.writeUInt32LE(rva, at + 20);
      row++;
    }
    moduleListRva = put(modules);
  }

  const entries: [number, number][] = [
    [6, exceptionRva],
    [3, threadListRva],
    [24, namesRva],
  ];
  if (moduleListRva) entries.push([4, moduleListRva]);

  const directory = Buffer.alloc(entries.length * 12);
  entries.forEach(([type, rva], i) => {
    directory.writeUInt32LE(type, i * 12);
    directory.writeUInt32LE(0, i * 12 + 4);
    directory.writeUInt32LE(rva, i * 12 + 8);
  });
  const directoryRva = put(directory);

  const header = Buffer.alloc(32);
  header.write("MDMP", 0, "ascii");
  header.writeUInt32LE(entries.length, 8);
  header.writeUInt32LE(directoryRva, 12);
  chunks[0] = header;
  return Buffer.concat(chunks);
}

function write(name: string, spec: DumpSpec): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buildDump(spec));
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dmp-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function patchNameLength(file: string, name: string, bytes: number): void {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(Buffer.from(name, "utf16le"));
  expect(at).toBeGreaterThan(0);
  buf.writeUInt32LE(bytes, at - 4);
  fs.writeFileSync(file, buf);
}

describe("crash dump summary", () => {
  it("names the exception, the faulting thread and the busiest pool", async () => {
    const file = write("crash.dmp", {
      code: 0x80000003,
      faultingThread: 5736,
      address: 0x7ff6dc2fb11an,
      module: { base: 0x7ff6d4710000n, size: 0x10000000, name: "C:\\app\\WFHelper.exe" },
      threads: [
        { id: 1, name: "CrBrowserMain" },
        { id: 5736, name: "V8Worker" },
        { id: 7, name: "libvips worker" },
        { id: 8, name: "libvips worker" },
        { id: 9, name: "libvips worker" },
      ],
    });

    const summary = await summarizeCrashDump(file);

    expect(summary).toContain("0x80000003");
    expect(summary).toContain("EXCEPTION_BREAKPOINT");
    expect(summary).toContain("thread=V8Worker");
    expect(summary).toContain("WFHelper.exe+0x7beb11a");
    expect(summary).toContain("threads=5");
    expect(summary).toContain("libvips worker=3");
  });

  it("falls back to the thread id when the dump carries no names", async () => {
    const file = write("noname.dmp", {
      code: 0xc0000005,
      faultingThread: 42,
      address: 0n,
      threads: [{ id: 42 }],
    });

    const summary = await summarizeCrashDump(file);

    expect(summary).toContain("EXCEPTION_ACCESS_VIOLATION");
    expect(summary).toContain("thread=42");
  });

  it("reports an unknown exception code rather than guessing", async () => {
    const file = write("odd.dmp", {
      code: 0x12345678,
      faultingThread: 1,
      address: 0n,
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });

    expect(await summarizeCrashDump(file)).toContain("0x12345678");
  });

  it("returns null for a file that is not a minidump", async () => {
    const file = path.join(dir, "junk.dmp");
    fs.writeFileSync(file, Buffer.from("not a dump at all"));

    expect(await summarizeCrashDump(file)).toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await summarizeCrashDump(path.join(dir, "absent.dmp"))).toBeNull();
  });

  it("survives a truncated dump", async () => {
    const file = write("cut.dmp", {
      code: 0x80000003,
      faultingThread: 1,
      address: 0n,
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });
    const full = fs.readFileSync(file);
    fs.writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)));

    await expect(summarizeCrashDump(file)).resolves.toBeNull();
  });

  it("names the native addons loaded at the time of death", async () => {
    const file = write("addons.dmp", {
      code: 0xc0000374,
      faultingThread: 1,
      address: 0x7ff6d4710010n,
      module: { base: 0x7ff6d4710000n, size: 0x1000, name: "C:\\app\\WFHelper.exe" },
      addons: ["C:\\app\\system-ocr.win32-x64-msvc.node", "C:\\app\\sharp-win32-x64.node"],
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });

    const summary = await summarizeCrashDump(file);

    expect(summary).toContain("STATUS_HEAP_CORRUPTION");
    expect(summary).toContain("addons=system-ocr.win32-x64-msvc.node,sharp-win32-x64.node");
  });

  it("leaves the addon list out when no native module is loaded", async () => {
    const file = write("plain.dmp", {
      code: 0x80000003,
      faultingThread: 1,
      address: 0n,
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });

    expect(await summarizeCrashDump(file)).not.toContain("addons=");
  });

  it("drops a thread name whose length runs past the dump", async () => {
    const file = write("badname.dmp", {
      code: 0x80000003,
      faultingThread: 1,
      address: 0n,
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });
    patchNameLength(file, "CrBrowserMain", 0xfffffff0);

    const summary = await summarizeCrashDump(file);

    expect(summary).toBe("0x80000003 EXCEPTION_BREAKPOINT thread=1 threads=1");
  });

  it("drops a module name whose length runs past the dump", async () => {
    const file = write("badmodule.dmp", {
      code: 0xc0000374,
      faultingThread: 1,
      address: 0x7ff6d4710010n,
      module: { base: 0x7ff6d4710000n, size: 0x1000, name: "C:\\app\\WFHelper.exe" },
      addons: ["C:\\app\\system-ocr.win32-x64-msvc.node"],
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });
    patchNameLength(file, "C:\\app\\WFHelper.exe", 0x10000);

    const summary = await summarizeCrashDump(file);

    expect(summary).not.toContain("at=");
    expect(summary).toContain("addons=system-ocr.win32-x64-msvc.node");
    expect(summary!.length).toBeLessThan(120);
  });

  it("keeps the modules already read when the module list runs past the dump", async () => {
    const file = write("longlist.dmp", {
      code: 0xc0000374,
      faultingThread: 1,
      address: 0x7ff6d4710010n,
      module: { base: 0x7ff6d4710000n, size: 0x1000, name: "C:\\app\\WFHelper.exe" },
      addons: ["C:\\app\\system-ocr.win32-x64-msvc.node"],
      declaredModules: 4096,
      threads: [{ id: 1, name: "CrBrowserMain" }],
    });

    const summary = await summarizeCrashDump(file);

    expect(summary).toContain("WFHelper.exe+0x10");
    expect(summary).toContain("addons=system-ocr.win32-x64-msvc.node");
  });
});
