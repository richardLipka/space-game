import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Canonical serialization + SHA-256 (spec §13.4, §4.5).
 *
 * - Object keys are sorted, so insertion order never affects the result.
 * - Numbers are quantized (default 1e-6) for state hashing only; the simulation itself keeps full precision.
 *   -0 is normalized to 0. NaN/Infinity throw: a non-finite value in sim state is always a bug.
 * - `undefined` object fields are omitted (like JSON). Arrays keep their order.
 * - Only plain data is accepted: objects, arrays, strings, finite numbers, booleans, null.
 */
export interface CanonicalOptions {
  /** Quantization step for numbers; 0 disables quantization (exact JSON number formatting). */
  readonly quantum?: number;
}

const DEFAULT_QUANTUM = 1e-6;

function formatNumber(n: number, quantum: number, path: string): string {
  if (!Number.isFinite(n)) throw new Error(`Non-finite number at ${path || "<root>"}: ${n}`);
  let v = n;
  if (quantum > 0) {
    v = Math.round(n / quantum) * quantum;
    // Strip float noise from the multiplication (e.g. 0.30000000000000004) with a fixed digit count.
    const digits = Math.max(0, Math.ceil(-Math.log10(quantum)));
    v = Number(v.toFixed(digits));
  }
  if (Object.is(v, -0)) v = 0;
  return JSON.stringify(v);
}

function write(value: unknown, quantum: number, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "number":
      out.push(formatNumber(value, quantum, path));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((item, i) => {
          if (i > 0) out.push(",");
          write(item === undefined ? null : item, quantum, `${path}[${i}]`, out);
        });
        out.push("]");
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`Non-plain object at ${path || "<root>"} (${proto?.constructor?.name ?? "?"})`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      out.push("{");
      keys.forEach((k, i) => {
        if (i > 0) out.push(",");
        out.push(JSON.stringify(k), ":");
        write(record[k], quantum, path ? `${path}.${k}` : k, out);
      });
      out.push("}");
      return;
    }
    default:
      throw new Error(`Unsupported value of type ${typeof value} at ${path || "<root>"}`);
  }
}

export function canonicalJson(value: unknown, options: CanonicalOptions = {}): string {
  const out: string[] = [];
  write(value, options.quantum ?? DEFAULT_QUANTUM, "", out);
  return out.join("");
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Hash of simulation state (quantized numbers). */
export function hashState(state: unknown): string {
  return sha256Hex(canonicalJson(state));
}

/**
 * Content hash for data definitions such as parts (spec §4.5): exact numbers, 16 hex chars.
 * Uses quantum 0 so that any real change to a definition changes its hash.
 */
export function contentHash(data: unknown): string {
  return sha256Hex(canonicalJson(data, { quantum: 0 })).slice(0, 16);
}
