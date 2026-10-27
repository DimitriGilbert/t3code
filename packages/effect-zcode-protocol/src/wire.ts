// Physical v4 wire layer: TopicWireFrame envelopes carry the logical topic
// frame either inline ("complete") or split at the UTF-8 byte level
// ("fragment" chunks reassembled then crc32-verified). Port of zcode's
// wire.ts / wire-codec.ts / wire-assembler.ts (zai-org/ZCode).
import * as Schema from "effect/Schema";

/** Physical wire version; independent of the snapshot-level protocolVersion=1. */
export const V4_WIRE_PROTOCOL_VERSION = 3 as const;

export const PROTOCOL_V4_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  logicalFrameAssemblyMaxFragments: 1024,
  logicalFrameAssemblyMaxConcurrent: 32,
  logicalFrameAssemblyMaxStagedBytes: 32 * 1024 * 1024,
  logicalFrameAssemblyTimeoutMs: 30_000,
} as const;

/** Deterministic content fault: the same bytes will always be rejected. */
export const WIRE_FAULT_INVALID_PAYLOAD = "proto.frameAssemblyInvalidPayload";

export const isDeterministicContentFault = (reasonCode: string | undefined): boolean =>
  reasonCode === WIRE_FAULT_INVALID_PAYLOAD;

export const TopicFrameDeliveryKind = Schema.Literals(["initial", "online", "recovery"]);
export type TopicFrameDeliveryKind = typeof TopicFrameDeliveryKind.Type;

const parseDeliveryKind = (value: unknown): TopicFrameDeliveryKind | null =>
  value === "initial" || value === "online" || value === "recovery" ? value : null;

export const TopicWireChecksum = Schema.Struct({
  algorithm: Schema.Literal("crc32"),
  value: Schema.String,
});
export type TopicWireChecksum = typeof TopicWireChecksum.Type;

const nonEmptyString = Schema.NonEmptyString;

/**
 * Route boundary validation only: deliveryKind/fragment internals are checked
 * inside the owned assembler so malformed pieces become typed faults.
 */
export const TopicWireFrameCandidate = Schema.Union([
  Schema.Struct({
    wireVersion: Schema.Literal(V4_WIRE_PROTOCOL_VERSION),
    kind: Schema.Literal("complete"),
    deliveryKind: Schema.optionalKey(Schema.Unknown),
    logicalFrameId: nonEmptyString,
    logicalFrameOrdinal: Schema.Number,
    topic: nonEmptyString,
    subscriptionId: nonEmptyString,
    frame: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    wireVersion: Schema.Literal(V4_WIRE_PROTOCOL_VERSION),
    kind: Schema.Literal("fragment"),
    deliveryKind: Schema.optionalKey(Schema.Unknown),
    logicalFrameId: nonEmptyString,
    logicalFrameOrdinal: Schema.Number,
    topic: nonEmptyString,
    subscriptionId: nonEmptyString,
    fragmentIndex: Schema.optionalKey(Schema.Unknown),
    fragmentCount: Schema.optionalKey(Schema.Unknown),
    logicalBytes: Schema.optionalKey(Schema.Unknown),
    checksum: Schema.optionalKey(Schema.Unknown),
    dataBase64: Schema.optionalKey(Schema.Unknown),
  }),
]);
export type TopicWireFrameCandidate = typeof TopicWireFrameCandidate.Type;

export type TopicWireFrame<F> =
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: "complete";
      deliveryKind: TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      frame: F;
    }
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: "fragment";
      deliveryKind: TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      fragmentIndex: number;
      fragmentCount: number;
      logicalBytes: number;
      checksum: TopicWireChecksum;
      dataBase64: string;
    };

// ── binary helpers (wire-binary.ts port) ──

export function crc32WireBytes(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function encodeWireBytesBase64(bytes: Uint8Array): string {
  let result = "";
  let block: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset] ?? 0;
    const hasB = offset + 1 < bytes.byteLength;
    const hasC = offset + 2 < bytes.byteLength;
    const b = hasB ? (bytes[offset + 1] ?? 0) : 0;
    const c = hasC ? (bytes[offset + 2] ?? 0) : 0;
    block.push(
      BASE64_ALPHABET[a >>> 2]!,
      BASE64_ALPHABET[((a & 0x03) << 4) | (b >>> 4)]!,
      hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >>> 6)]! : "=",
      hasC ? BASE64_ALPHABET[c & 0x3f]! : "=",
    );
    if (block.length >= 16_384) {
      result += block.join("");
      block = [];
    }
  }
  return result + block.join("");
}

export function decodeWireBase64(value: string): Uint8Array | null {
  if (value.length < 4 || !BASE64_PATTERN.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let writeOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset]!);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (writeOffset < output.length) output[writeOffset++] = combined >>> 16;
    if (writeOffset < output.length) {
      output[writeOffset++] = (combined >>> 8) & 0xff;
    }
    if (writeOffset < output.length) output[writeOffset++] = combined & 0xff;
  }
  return output;
}

export const utf8JsonByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

// Upstream also budgets Channel/mobile-relay envelopes; our only carrier is
// CLI NDJSON, so the physical bound measures that frame alone.
const measureCliPhysicalFrameBytes = (wire: TopicWireFrameCandidate): number =>
  utf8JsonByteLength({ method: "v4/conversation/frame", params: wire }) + 1;

// ── encoder (wire-codec.ts port, for fixture recording/tests) ──

export class TopicWireFrameEncodingError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "TopicWireFrameEncodingError";
    this.reasonCode = reasonCode;
  }
}

const hardBound = (value: number | undefined, maximum: number, name: string): number => {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TopicWireFrameEncodingError(`proto.invalidLimit.${name}`);
  }
  return Math.min(Math.floor(resolved), maximum);
};

export interface EncodeTopicWireFramesOptions {
  deliveryKind: TopicFrameDeliveryKind;
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  maxPhysicalFrameBytes?: number;
  maxAssemblyBytes?: number;
}

/** Fragment a logical frame the same way the server does on oversized payloads. */
export function encodeTopicWireFrames<F>(
  frame: F,
  options: EncodeTopicWireFramesOptions,
): Array<TopicWireFrame<F>> {
  const maxPhysicalFrameBytes = hardBound(
    options.maxPhysicalFrameBytes,
    PROTOCOL_V4_LIMITS.maxFrameBytes,
    "maxPhysicalFrameBytes",
  );
  const maxAssemblyBytes = hardBound(
    options.maxAssemblyBytes,
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    "maxAssemblyBytes",
  );
  const logical = new TextEncoder().encode(JSON.stringify(frame));
  if (logical.byteLength > maxAssemblyBytes) {
    throw new TopicWireFrameEncodingError("proto.frameAssemblyTooLarge");
  }

  const complete: TopicWireFrame<F> = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    frame,
  };
  if (measureCliPhysicalFrameBytes(complete) <= maxPhysicalFrameBytes) {
    return [complete];
  }

  const checksum: TopicWireChecksum = { algorithm: "crc32", value: crc32WireBytes(logical) };
  const makeFragment = (fragmentIndex: number, fragmentCount: number, dataBase64: string) =>
    ({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "fragment" as const,
      deliveryKind: options.deliveryKind,
      logicalFrameId: options.logicalFrameId,
      logicalFrameOrdinal: options.logicalFrameOrdinal,
      topic: options.topic,
      subscriptionId: options.subscriptionId,
      fragmentIndex,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64,
    }) satisfies TopicWireFrame<F>;

  // Binary-search the largest chunk whose worst-case envelope fits the budget.
  let chunkBytes = 0;
  let low = 1;
  let high = Math.min(logical.byteLength, maxPhysicalFrameBytes);
  const worstCount = logical.byteLength;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const wire = makeFragment(
      Math.max(0, worstCount - 1),
      worstCount,
      "A".repeat(4 * Math.ceil(candidate / 3)),
    );
    if (measureCliPhysicalFrameBytes(wire) <= maxPhysicalFrameBytes) {
      chunkBytes = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  if (chunkBytes < 1) {
    throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
  }
  const fragmentCount = Math.ceil(logical.byteLength / chunkBytes);
  if (fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    throw new TopicWireFrameEncodingError("proto.frameFragmentCountExceeded");
  }

  const frames: Array<TopicWireFrame<F>> = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, logical.byteLength);
    const wire = makeFragment(
      fragmentIndex,
      fragmentCount,
      encodeWireBytesBase64(logical.subarray(start, end)),
    );
    // The budget includes the real NDJSON envelope; any estimation drift must
    // fail closed rather than emit a frame the assembler will reject.
    if (measureCliPhysicalFrameBytes(wire) > maxPhysicalFrameBytes) {
      throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
    }
    frames.push(wire);
  }
  return frames;
}

// ── assembler (wire-assembler.ts port) ──

export interface TopicWireAssemblyFault {
  readonly deliveryKind?: TopicFrameDeliveryKind;
  readonly reasonCode: string;
  readonly logicalFrameId: string;
  readonly logicalFrameOrdinal: number;
  readonly topic: string;
  readonly subscriptionId: string;
}

export type TopicWireAssemblyEvent<F> =
  | { kind: "complete"; frame: F; deliveryKind: TopicFrameDeliveryKind }
  | { kind: "fault"; fault: TopicWireAssemblyFault };

export interface TopicWireFrameAssemblerOptions {
  readonly maxAssemblyBytes?: number;
  readonly maxFragments?: number;
  readonly maxConcurrentAssemblies?: number;
  readonly maxStagedDecodedBytes?: number;
  readonly timeoutMs?: number;
  readonly maxPhysicalFrameBytes?: number;
}

interface FragmentAssembly {
  deliveryKind: TopicFrameDeliveryKind;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  topic: string;
  subscriptionId: string;
  fragmentCount: number;
  logicalBytes: number;
  checksum: { algorithm: "crc32"; value: string };
  fragments: Array<Uint8Array | undefined>;
  receivedCount: number;
  decodedBytes: number;
  firstSeenAt: number;
}

interface SettledLogicalFrame {
  logicalFrameId: string;
  logicalFrameOrdinal: number;
}

type FragmentWireCandidate = Extract<TopicWireFrameCandidate, { kind: "fragment" }>;
type ValidatedFragmentWire = FragmentWireCandidate & {
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: { algorithm: string; value: string };
  dataBase64: string;
};

const COMPLETE_WIRE_KEYS = new Set([
  "wireVersion",
  "kind",
  "deliveryKind",
  "logicalFrameId",
  "logicalFrameOrdinal",
  "topic",
  "subscriptionId",
  "frame",
]);
const FRAGMENT_WIRE_KEYS = new Set([
  "wireVersion",
  "kind",
  "deliveryKind",
  "logicalFrameId",
  "logicalFrameOrdinal",
  "topic",
  "subscriptionId",
  "fragmentIndex",
  "fragmentCount",
  "logicalBytes",
  "checksum",
  "dataBase64",
]);
const CHECKSUM_KEYS = new Set(["algorithm", "value"]);

const hasOnlyKeys = (value: object, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key));

function hasValidFragmentInner(wire: FragmentWireCandidate): wire is ValidatedFragmentWire {
  if (
    !hasOnlyKeys(wire, FRAGMENT_WIRE_KEYS) ||
    typeof wire.fragmentIndex !== "number" ||
    typeof wire.fragmentCount !== "number" ||
    typeof wire.logicalBytes !== "number" ||
    typeof wire.dataBase64 !== "string" ||
    typeof wire.checksum !== "object" ||
    wire.checksum === null ||
    Array.isArray(wire.checksum) ||
    !hasOnlyKeys(wire.checksum, CHECKSUM_KEYS)
  ) {
    return false;
  }
  const checksum = wire.checksum as Record<string, unknown>;
  return typeof checksum.algorithm === "string" && typeof checksum.value === "string";
}

// \0 separator: ("a","bc") and ("ab","c") must not share a route's assembly state.
const routeKey = (topic: string, subscriptionId: string): string => `${topic}\0${subscriptionId}`;

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const frameMatchesEnvelope = (
  frame: unknown,
  wire: { topic: string; subscriptionId: string },
): boolean => {
  if (typeof frame !== "object" || frame === null) return false;
  const value = frame as { topic?: unknown; subscriptionId?: unknown };
  return value.topic === wire.topic && value.subscriptionId === wire.subscriptionId;
};

export class TopicWireFrameAssembler<F> {
  private readonly assemblies = new Map<string, FragmentAssembly>();
  // Per-route monotonic ordinal tombstone; settled ids cannot resurrect.
  private readonly settledByRoute = new Map<string, SettledLogicalFrame>();
  private stagedDecodedBytes = 0;
  private readonly maxAssemblyBytes: number;
  private readonly maxFragments: number;
  private readonly maxConcurrentAssemblies: number;
  private readonly maxStagedDecodedBytes: number;
  private readonly timeoutMs: number;
  private readonly maxPhysicalFrameBytes: number;
  private readonly decodeFrame: (value: unknown) => F | undefined;

  constructor(frameSchema: Schema.Codec<F>, options: TopicWireFrameAssemblerOptions = {}) {
    const decode = Schema.decodeUnknownSync(frameSchema);
    this.decodeFrame = (value) => {
      try {
        return decode(value);
      } catch {
        return undefined;
      }
    };
    this.maxAssemblyBytes = hardBound(
      options.maxAssemblyBytes,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
      "maxAssemblyBytes",
    );
    this.maxFragments = hardBound(
      options.maxFragments,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments,
      "maxFragments",
    );
    this.maxConcurrentAssemblies = hardBound(
      options.maxConcurrentAssemblies,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxConcurrent,
      "maxConcurrentAssemblies",
    );
    this.maxStagedDecodedBytes = hardBound(
      options.maxStagedDecodedBytes,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxStagedBytes,
      "maxStagedDecodedBytes",
    );
    this.timeoutMs = hardBound(
      options.timeoutMs,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs,
      "timeoutMs",
    );
    this.maxPhysicalFrameBytes = hardBound(
      options.maxPhysicalFrameBytes,
      PROTOCOL_V4_LIMITS.maxFrameBytes,
      "maxPhysicalFrameBytes",
    );
  }

  // Callers pass their own clock (Effect Clock upstream, explicit `now` in
  // tests) so the assembler stays free of the wall clock.
  accept(wire: TopicWireFrameCandidate, now: number): Array<TopicWireAssemblyEvent<F>> {
    const events = this.expire(now);
    const key = routeKey(wire.topic, wire.subscriptionId);
    if (!Number.isSafeInteger(wire.logicalFrameOrdinal) || wire.logicalFrameOrdinal < 1) {
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }

    // Ordinal tombstone check precedes envelope/base64 validation: a late
    // stale fragment must not release an in-flight newer assembly.
    const settled = this.settledByRoute.get(key);
    if (settled) {
      if (wire.logicalFrameOrdinal < settled.logicalFrameOrdinal) return events;
      if (wire.logicalFrameOrdinal === settled.logicalFrameOrdinal) {
        if (wire.logicalFrameId !== settled.logicalFrameId) {
          events.push(this.fault(wire, "proto.frameAssemblyOrdinalConflict"));
        }
        return events;
      }
    }

    const deliveryKind = parseDeliveryKind(wire.deliveryKind);
    if (deliveryKind === "recovery") {
      // An authoritative higher-ordinal recovery supersedes a timed-out older
      // assembly in the same accept(); suppress that stale fault.
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
          event?.kind === "fault" &&
          event.fault.topic === wire.topic &&
          event.fault.subscriptionId === wire.subscriptionId &&
          event.fault.logicalFrameOrdinal < wire.logicalFrameOrdinal
        ) {
          events.splice(index, 1);
        }
      }
    }
    const current = this.assemblies.get(key);
    if (current) {
      if (wire.logicalFrameOrdinal < current.logicalFrameOrdinal) return events;
      if (wire.logicalFrameOrdinal === current.logicalFrameOrdinal) {
        if (wire.logicalFrameId !== current.logicalFrameId) {
          this.release(key, current);
          this.settle(key, current);
          events.push(this.fault(wire, "proto.frameAssemblyOrdinalConflict"));
          return events;
        }
      } else {
        this.release(key, current);
        this.settle(key, current);
        if (deliveryKind !== "recovery") {
          events.push(this.fault(current, "proto.frameAssemblySuperseded"));
        }
      }
    }

    if (deliveryKind === null) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }

    if (wire.kind === "complete") {
      if (
        !hasOnlyKeys(wire, COMPLETE_WIRE_KEYS) ||
        !Object.prototype.hasOwnProperty.call(wire, "frame")
      ) {
        this.releaseAndSettle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
      if (measureCliPhysicalFrameBytes(wire) > this.maxPhysicalFrameBytes) {
        this.releaseAndSettle(key, wire);
        events.push(this.fault(wire, "proto.frameEnvelopeTooLarge"));
        return events;
      }
      const active = this.assemblies.get(key);
      if (active) {
        this.release(key, active);
        this.settle(key, active);
        events.push(this.fault(active, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
      const logicalBytes = new TextEncoder().encode(JSON.stringify(wire.frame)).byteLength;
      if (logicalBytes > this.maxAssemblyBytes) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyTooLarge"));
        return events;
      }
      if (!frameMatchesEnvelope(wire.frame, wire)) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
      const parsed = this.decodeFrame(wire.frame);
      if (parsed === undefined) {
        this.settle(key, wire);
        events.push(this.fault(wire, WIRE_FAULT_INVALID_PAYLOAD));
        return events;
      }
      this.settle(key, wire);
      events.push({ kind: "complete", frame: parsed, deliveryKind });
      return events;
    }

    if (!hasValidFragmentInner(wire)) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }
    if (measureCliPhysicalFrameBytes(wire) > this.maxPhysicalFrameBytes) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameEnvelopeTooLarge"));
      return events;
    }

    if (wire.fragmentCount > this.maxFragments) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameFragmentCountExceeded"));
      return events;
    }
    if (wire.logicalBytes > this.maxAssemblyBytes) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyTooLarge"));
      return events;
    }
    if (
      !Number.isInteger(wire.fragmentCount) ||
      wire.fragmentCount < 1 ||
      !Number.isInteger(wire.fragmentIndex) ||
      wire.fragmentIndex < 0 ||
      wire.fragmentIndex >= wire.fragmentCount ||
      !Number.isInteger(wire.logicalBytes) ||
      wire.logicalBytes < 1 ||
      wire.fragmentCount > wire.logicalBytes ||
      wire.checksum.algorithm !== "crc32" ||
      !/^[0-9a-f]{8}$/u.test(wire.checksum.value)
    ) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }

    const decoded = decodeWireBase64(wire.dataBase64);
    if (!decoded) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyInvalidBase64"));
      return events;
    }

    let assembly = this.assemblies.get(key);
    if (assembly) {
      if (
        assembly.fragmentCount !== wire.fragmentCount ||
        assembly.deliveryKind !== deliveryKind ||
        assembly.logicalBytes !== wire.logicalBytes ||
        assembly.checksum.algorithm !== wire.checksum.algorithm ||
        assembly.checksum.value !== wire.checksum.value
      ) {
        this.release(key, assembly);
        this.settle(key, assembly);
        events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
    } else {
      if (this.assemblies.size >= this.maxConcurrentAssemblies) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyConcurrentLimit"));
        return events;
      }
      if (this.stagedDecodedBytes + decoded.byteLength > this.maxStagedDecodedBytes) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyBudgetExceeded"));
        return events;
      }
      assembly = {
        deliveryKind,
        logicalFrameId: wire.logicalFrameId,
        logicalFrameOrdinal: wire.logicalFrameOrdinal,
        topic: wire.topic,
        subscriptionId: wire.subscriptionId,
        fragmentCount: wire.fragmentCount,
        logicalBytes: wire.logicalBytes,
        checksum: { algorithm: "crc32", value: wire.checksum.value },
        fragments: Array.from({ length: wire.fragmentCount }, () => undefined),
        receivedCount: 0,
        decodedBytes: 0,
        firstSeenAt: now,
      };
      this.assemblies.set(key, assembly);
    }

    const previous = assembly.fragments[wire.fragmentIndex];
    if (previous) {
      if (!bytesEqual(previous, decoded)) {
        this.release(key, assembly);
        this.settle(key, assembly);
        events.push(this.fault(wire, "proto.frameAssemblyFragmentConflict"));
      }
      return events;
    }
    if (this.stagedDecodedBytes + decoded.byteLength > this.maxStagedDecodedBytes) {
      this.release(key, assembly);
      this.settle(key, assembly);
      events.push(this.fault(wire, "proto.frameAssemblyBudgetExceeded"));
      return events;
    }
    if (assembly.decodedBytes + decoded.byteLength > assembly.logicalBytes) {
      this.release(key, assembly);
      this.settle(key, assembly);
      events.push(this.fault(wire, "proto.frameAssemblyLengthMismatch"));
      return events;
    }
    assembly.fragments[wire.fragmentIndex] = decoded;
    assembly.receivedCount += 1;
    assembly.decodedBytes += decoded.byteLength;
    this.stagedDecodedBytes += decoded.byteLength;
    if (assembly.receivedCount !== assembly.fragmentCount) return events;

    this.release(key, assembly);
    if (assembly.decodedBytes !== assembly.logicalBytes) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyLengthMismatch"));
      return events;
    }
    const logical = new Uint8Array(assembly.decodedBytes);
    let offset = 0;
    for (const fragment of assembly.fragments) {
      if (!fragment) {
        this.settle(key, assembly);
        events.push(this.fault(assembly, "proto.frameAssemblyLengthMismatch"));
        return events;
      }
      logical.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (crc32WireBytes(logical) !== assembly.checksum.value) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyChecksumMismatch"));
      return events;
    }
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(logical);
    } catch {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyInvalidUtf8"));
      return events;
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyInvalidJson"));
      return events;
    }
    if (!frameMatchesEnvelope(value, assembly)) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }
    const parsed = this.decodeFrame(value);
    if (parsed === undefined) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, WIRE_FAULT_INVALID_PAYLOAD));
      return events;
    }
    this.settle(key, assembly);
    events.push({ kind: "complete", frame: parsed, deliveryKind: assembly.deliveryKind });
    return events;
  }

  expire(now: number): Array<TopicWireAssemblyEvent<F>> {
    const events: Array<TopicWireAssemblyEvent<F>> = [];
    for (const [key, assembly] of this.assemblies) {
      if (now - assembly.firstSeenAt < this.timeoutMs) continue;
      this.release(key, assembly);
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyTimedOut"));
    }
    return events;
  }

  discard(topic: string, subscriptionId: string): void {
    const key = routeKey(topic, subscriptionId);
    const assembly = this.assemblies.get(key);
    if (assembly) this.release(key, assembly);
    this.settledByRoute.delete(key);
  }

  /** Release the route's active bytes but keep the ordinal tombstone. */
  abort(topic: string, subscriptionId: string): void {
    const key = routeKey(topic, subscriptionId);
    const assembly = this.assemblies.get(key);
    if (!assembly) return;
    this.release(key, assembly);
    this.settle(key, assembly);
  }

  clear(): void {
    this.assemblies.clear();
    this.settledByRoute.clear();
    this.stagedDecodedBytes = 0;
  }

  getStats(): { assemblies: number; stagedDecodedBytes: number } {
    return { assemblies: this.assemblies.size, stagedDecodedBytes: this.stagedDecodedBytes };
  }

  get nextExpiryAt(): number | null {
    let next: number | null = null;
    for (const assembly of this.assemblies.values()) {
      const expiresAt = assembly.firstSeenAt + this.timeoutMs;
      if (next === null || expiresAt < next) next = expiresAt;
    }
    return next;
  }

  private release(key: string, assembly: FragmentAssembly): void {
    if (this.assemblies.get(key) !== assembly) return;
    this.assemblies.delete(key);
    this.stagedDecodedBytes -= assembly.decodedBytes;
  }

  private settle(
    key: string,
    frame: Pick<FragmentAssembly, "logicalFrameId" | "logicalFrameOrdinal">,
  ): void {
    const previous = this.settledByRoute.get(key);
    if (previous && previous.logicalFrameOrdinal > frame.logicalFrameOrdinal) return;
    this.settledByRoute.set(key, {
      logicalFrameId: frame.logicalFrameId,
      logicalFrameOrdinal: frame.logicalFrameOrdinal,
    });
  }

  private releaseAndSettle(
    key: string,
    frame: Pick<FragmentAssembly, "logicalFrameId" | "logicalFrameOrdinal">,
  ): void {
    const active = this.assemblies.get(key);
    if (
      active &&
      active.logicalFrameOrdinal === frame.logicalFrameOrdinal &&
      active.logicalFrameId === frame.logicalFrameId
    ) {
      this.release(key, active);
    }
    this.settle(key, frame);
  }

  private fault(
    source: {
      deliveryKind?: unknown;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
    },
    reasonCode: string,
  ): TopicWireAssemblyEvent<F> {
    const deliveryKind = parseDeliveryKind(source.deliveryKind);
    return {
      kind: "fault",
      fault: {
        ...(deliveryKind === null ? {} : { deliveryKind }),
        reasonCode,
        logicalFrameId: source.logicalFrameId,
        logicalFrameOrdinal: source.logicalFrameOrdinal,
        topic: source.topic,
        subscriptionId: source.subscriptionId,
      },
    };
  }
}
