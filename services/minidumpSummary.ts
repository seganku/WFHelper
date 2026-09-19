import fs from "node:fs";

import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("minidumpSummary");

const SIGNATURE = 0x504d444d; // "MDMP"
const STREAM_THREAD_LIST = 3;
const STREAM_MODULE_LIST = 4;
const STREAM_EXCEPTION = 6;
const STREAM_THREAD_NAMES = 24;
const MODULE_ENTRY_BYTES = 108;
const THREAD_ENTRY_BYTES = 48;
const THREAD_NAME_ENTRY_BYTES = 12;
const MAX_THREAD_NAMES = 4096;
const MAX_NAME_BYTES = 1024;

const EXCEPTION_NAMES = new Map<number, string>([
  [0x80000003, "EXCEPTION_BREAKPOINT"],
  [0xc0000005, "EXCEPTION_ACCESS_VIOLATION"],
  [0xc000001d, "EXCEPTION_ILLEGAL_INSTRUCTION"],
  [0xc0000094, "EXCEPTION_INT_DIVIDE_BY_ZERO"],
  [0xc00000fd, "EXCEPTION_STACK_OVERFLOW"],
  [0xc0000374, "STATUS_HEAP_CORRUPTION"],
  [0xc0000409, "STATUS_STACK_BUFFER_OVERRUN"],
  [0xe0000008, "Chromium out-of-memory abort"],
]);

interface Streams {
  [type: number]: { size: number; rva: number };
}

function readStreams(buf: Buffer): Streams | null {
  if (buf.length < 32 || buf.readUInt32LE(0) !== SIGNATURE) return null;
  const count = buf.readUInt32LE(8);
  const dirRva = buf.readUInt32LE(12);
  const streams: Streams = {};
  for (let i = 0; i < count; i++) {
    const at = dirRva + i * 12;
    if (at + 12 > buf.length) return null;
    streams[buf.readUInt32LE(at)] = {
      size: buf.readUInt32LE(at + 4),
      rva: buf.readUInt32LE(at + 8),
    };
  }
  return streams;
}

function nameAt(buf: Buffer, nameRva: number): string | null {
  if (nameRva + 4 > buf.length) return null;
  const bytes = buf.readUInt32LE(nameRva);
  if (bytes === 0 || bytes > MAX_NAME_BYTES || nameRva + 4 + bytes > buf.length) return null;
  return buf.subarray(nameRva + 4, nameRva + 4 + bytes).toString("utf16le");
}

function threadNameFor(buf: Buffer, streams: Streams, threadId: number): string | null {
  const stream = streams[STREAM_THREAD_NAMES];
  if (!stream) return null;
  const count = Math.min(buf.readUInt32LE(stream.rva), MAX_THREAD_NAMES);
  for (let i = 0; i < count; i++) {
    const at = stream.rva + 4 + i * THREAD_NAME_ENTRY_BYTES;
    if (at + THREAD_NAME_ENTRY_BYTES > buf.length) return null;
    if (buf.readUInt32LE(at) !== threadId) continue;
    return nameAt(buf, Number(buf.readBigUInt64LE(at + 4)));
  }
  return null;
}

interface Modules {
  faulting: string | null;
  addons: string[];
}

function walkModules(buf: Buffer, streams: Streams, address: bigint): Modules {
  const found: Modules = { faulting: null, addons: [] };
  const stream = streams[STREAM_MODULE_LIST];
  if (!stream || stream.rva + 4 > buf.length) return found;
  const count = buf.readUInt32LE(stream.rva);
  for (let i = 0; i < count; i++) {
    const at = stream.rva + 4 + i * MODULE_ENTRY_BYTES;
    if (at + MODULE_ENTRY_BYTES > buf.length) break;
    const full = nameAt(buf, buf.readUInt32LE(at + 20));
    if (!full) continue;
    const file = full.split("\\").pop() ?? full;
    if (!found.faulting) {
      const base = buf.readBigUInt64LE(at);
      const size = BigInt(buf.readUInt32LE(at + 8));
      if (address >= base && address < base + size) {
        found.faulting = `${file}+0x${(address - base).toString(16)}`;
      }
    }
    if (full.toLowerCase().endsWith(".node")) found.addons.push(file);
  }
  return found;
}

function threadCounts(
  buf: Buffer,
  streams: Streams,
): { total: number; named: Map<string, number> } {
  const named = new Map<string, number>();
  const stream = streams[STREAM_THREAD_LIST];
  if (!stream) return { total: 0, named };
  const total = buf.readUInt32LE(stream.rva);
  for (let i = 0; i < total; i++) {
    const at = stream.rva + 4 + i * THREAD_ENTRY_BYTES;
    if (at + 4 > buf.length) break;
    const name = threadNameFor(buf, streams, buf.readUInt32LE(at));
    if (!name) continue;
    named.set(name, (named.get(name) || 0) + 1);
  }
  return { total, named };
}

/** One line naming why a native death happened, from the dump Crashpad already
 *  writes. A Chromium abort leaves no log line and no reason on stderr, so the
 *  dump is the only record. */
export async function summarizeCrashDump(file: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file);
  } catch (err) {
    log.warn("[MinidumpSummary] unreadable dump:", normalizeErrorMessage(err));
    return null;
  }

  try {
    const streams = readStreams(buf);
    const exception = streams?.[STREAM_EXCEPTION];
    if (!streams || !exception) return null;

    const threadId = buf.readUInt32LE(exception.rva);
    const record = exception.rva + 8;
    const code = buf.readUInt32LE(record);
    const address = buf.readBigUInt64LE(record + 16);

    const parts = [`0x${code.toString(16).padStart(8, "0")}`];
    const known = EXCEPTION_NAMES.get(code);
    if (known) parts.push(known);

    const name = threadNameFor(buf, streams, threadId);
    parts.push(`thread=${name || threadId}`);

    const modules = walkModules(buf, streams, address);
    if (modules.faulting) parts.push(`at=${modules.faulting}`);

    const { total, named } = threadCounts(buf, streams);
    if (total) parts.push(`threads=${total}`);
    const busiest = [...named.entries()].sort((a, b) => b[1] - a[1])[0];
    if (busiest && busiest[1] > 1) parts.push(`${busiest[0]}=${busiest[1]}`);

    // The faulting module names the victim of a heap corruption, never its
    // source; the addon list is what points at the culprit.
    if (modules.addons.length) parts.push(`addons=${modules.addons.join(",")}`);

    return parts.join(" ");
  } catch (err) {
    log.warn("[MinidumpSummary] parse failed:", normalizeErrorMessage(err));
    return null;
  }
}
