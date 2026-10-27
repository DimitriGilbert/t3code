import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  decodeWireBase64,
  encodeTopicWireFrames,
  encodeWireBytesBase64,
  crc32WireBytes,
  utf8JsonByteLength,
  TopicWireFrameAssembler,
  WIRE_FAULT_INVALID_PAYLOAD,
} from "./wire.ts";
import type { TopicWireFrameCandidate } from "./wire.ts";

const frameSchema = Schema.Struct({
  topic: Schema.String,
  subscriptionId: Schema.String,
  fromSeq: Schema.Number,
  toSeq: Schema.Number,
  sentAt: Schema.Number,
  payload: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: Schema.Unknown }),
    Schema.Struct({ kind: Schema.Literal("deltas"), deltas: Schema.Array(Schema.Unknown) }),
  ]),
});
type Frame = typeof frameSchema.Type;

const baseFrame = (overrides: Partial<Frame> = {}): Frame => ({
  topic: "conversation/s1",
  subscriptionId: "sub-1",
  fromSeq: 0,
  toSeq: 1,
  sentAt: 100,
  payload: { kind: "deltas", deltas: [] },
  ...overrides,
});

const wireOptions = {
  deliveryKind: "online" as const,
  topic: "conversation/s1",
  subscriptionId: "sub-1",
  logicalFrameId: "lf-1",
  logicalFrameOrdinal: 1,
};

it("crc32 + base64 round-trip arbitrary bytes", () => {
  const bytes = new TextEncoder().encode("héllo 🌍 zcode");
  const encoded = encodeWireBytesBase64(bytes);
  assert.deepEqual(decodeWireBase64(encoded), bytes);
  assert.equal(crc32WireBytes(bytes).length, 8);
  assert.isNull(decodeWireBase64("not!base64"));
});

it("emits a complete wire frame under the physical budget", () => {
  const wires = encodeTopicWireFrames(baseFrame(), wireOptions);
  assert.equal(wires.length, 1);
  assert.equal(wires[0]!.kind, "complete");
});

it("budgets the full NDJSON envelope, not the bare wire frame", () => {
  const frame = baseFrame({
    payload: { kind: "deltas", deltas: [{ op: "x", v: "y".repeat(2000) }] },
  });
  const [complete] = encodeTopicWireFrames(frame, wireOptions);
  const bareBytes = utf8JsonByteLength(complete);
  const envelopeBytes =
    utf8JsonByteLength({
      method: "v4/conversation/frame",
      params: complete,
    }) + 1;
  // Bare wire JSON fits the budget, but the NDJSON envelope around it does
  // not — the encoder must fragment and every emitted frame must fit too.
  const maxPhysicalFrameBytes = bareBytes;
  assert.isAbove(envelopeBytes, maxPhysicalFrameBytes);
  const wires = encodeTopicWireFrames(frame, { ...wireOptions, maxPhysicalFrameBytes });
  assert.isAbove(wires.length, 1);
  for (const wire of wires) {
    const emitted = utf8JsonByteLength({ method: "v4/conversation/frame", params: wire }) + 1;
    assert.isAtMost(emitted, maxPhysicalFrameBytes);
  }
  // ...and the assembler accepts what the encoder emitted.
  const assembler = new TopicWireFrameAssembler(frameSchema, { maxPhysicalFrameBytes });
  const events = wires.flatMap((w) => assembler.accept(w as TopicWireFrameCandidate, 0));
  assert.isTrue(events.some((e) => e.kind === "complete" && e.frame.topic === frame.topic));
});

it("reassembles fragments across a UTF-8 boundary and schema-decodes", () => {
  const frame = baseFrame({
    payload: { kind: "deltas", deltas: [{ op: "row.delta", append: "é🙂x".repeat(400) }] },
  });
  const wires = encodeTopicWireFrames(frame, { ...wireOptions, maxPhysicalFrameBytes: 800 });
  assert.isAbove(wires.length, 2);
  assert.isTrue(wires.every((w) => w.kind === "fragment"));

  const assembler = new TopicWireFrameAssembler(frameSchema);
  const events = wires.flatMap((w) => assembler.accept(w as TopicWireFrameCandidate, 0));
  const completes = events.filter((e) => e.kind === "complete");
  assert.equal(completes.length, 1);
  assert.deepEqual(completes[0]!.frame, frame);
  assert.equal(completes[0]!.deliveryKind, "online");
});

it("reports checksum mismatch on corrupted fragments", () => {
  const frame = baseFrame({
    payload: { kind: "deltas", deltas: [{ op: "x", v: "y".repeat(900) }] },
  });
  const wires = encodeTopicWireFrames(frame, { ...wireOptions, maxPhysicalFrameBytes: 800 });
  const corrupted = wires.map((w, i) =>
    i === 0 && w.kind === "fragment"
      ? {
          ...w,
          dataBase64: encodeWireBytesBase64(
            new Uint8Array(decodeWireBase64(w.dataBase64)!.length).fill(65),
          ),
        }
      : w,
  );
  const assembler = new TopicWireFrameAssembler(frameSchema);
  const events = corrupted.flatMap((w) => assembler.accept(w as TopicWireFrameCandidate, 0));
  const faults = events.filter((e) => e.kind === "fault");
  assert.equal(faults.at(-1)?.fault.reasonCode, "proto.frameAssemblyChecksumMismatch");
});

it("rejects a schema-invalid logical payload as a deterministic fault", () => {
  const assembler = new TopicWireFrameAssembler(frameSchema);
  const wire = {
    wireVersion: 3 as const,
    kind: "complete" as const,
    deliveryKind: "online" as const,
    logicalFrameId: "lf-bad",
    logicalFrameOrdinal: 1,
    topic: "conversation/s1",
    subscriptionId: "sub-1",
    frame: { topic: "conversation/s1", subscriptionId: "sub-1", nope: true },
  };
  const events = assembler.accept(wire, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "fault");
  const reasonCode = events[0]?.kind === "fault" ? events[0].fault.reasonCode : undefined;
  assert.equal(reasonCode, WIRE_FAULT_INVALID_PAYLOAD);
});

it("faults an ordinal conflict and ignores older settled frames", () => {
  const assembler = new TopicWireFrameAssembler(frameSchema);
  const make = (id: string, ordinal: number): TopicWireFrameCandidate => ({
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: id,
    logicalFrameOrdinal: ordinal,
    topic: "conversation/s1",
    subscriptionId: "sub-1",
    frame: baseFrame({ toSeq: ordinal }),
  });
  assert.equal(assembler.accept(make("lf-2", 2), 0)[0]?.kind, "complete");
  // Older ordinal is silently ignored after settle.
  assert.equal(assembler.accept(make("lf-1", 1), 0).length, 0);
  // Same ordinal, different id → ordinal conflict.
  const conflict = assembler.accept(make("lf-other", 2), 0);
  assert.equal(
    conflict[0]?.kind === "fault" && conflict[0].fault.reasonCode,
    "proto.frameAssemblyOrdinalConflict",
  );
});

it("supersedes an incomplete assembly with a newer ordinal", () => {
  const frame = baseFrame({
    payload: { kind: "deltas", deltas: [{ op: "x", v: "z".repeat(900) }] },
  });
  const wires = encodeTopicWireFrames(frame, { ...wireOptions, maxPhysicalFrameBytes: 800 });
  const assembler = new TopicWireFrameAssembler(frameSchema);
  // Feed only the first fragment, then a complete frame at a newer ordinal.
  assembler.accept(wires[0] as TopicWireFrameCandidate, 0);
  const events = assembler.accept(
    {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "lf-2",
      logicalFrameOrdinal: 2,
      topic: "conversation/s1",
      subscriptionId: "sub-1",
      frame: baseFrame({ toSeq: 2 }),
    },
    0,
  );
  assert.isTrue(
    events.some(
      (e) => e.kind === "fault" && e.fault.reasonCode === "proto.frameAssemblySuperseded",
    ),
  );
  assert.isTrue(events.some((e) => e.kind === "complete"));
});

it("keeps assembly routes separate for colliding concatenations", () => {
  const assembler = new TopicWireFrameAssembler(frameSchema);
  const make = (
    id: string,
    ordinal: number,
    topic: string,
    subscriptionId: string,
  ): TopicWireFrameCandidate => ({
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: id,
    logicalFrameOrdinal: ordinal,
    topic,
    subscriptionId,
    frame: baseFrame({ topic, subscriptionId }),
  });
  // ("a","bc") and ("ab","c") share the naive string concatenation; an
  // already-settled id+ordinal on one route must not suppress the other's.
  assert.equal(assembler.accept(make("lf-1", 1, "a", "bc"), 0)[0]?.kind, "complete");
  assert.equal(assembler.accept(make("lf-1", 1, "ab", "c"), 0)[0]?.kind, "complete");
});

it("expires timed-out assemblies", () => {
  const frame = baseFrame({
    payload: { kind: "deltas", deltas: [{ op: "x", v: "z".repeat(900) }] },
  });
  const wires = encodeTopicWireFrames(frame, { ...wireOptions, maxPhysicalFrameBytes: 800 });
  const assembler = new TopicWireFrameAssembler(frameSchema, { timeoutMs: 1000 });
  assembler.accept(wires[0] as TopicWireFrameCandidate, 0);
  const events = assembler.expire(2000);
  assert.equal(
    events[0]?.kind === "fault" && events[0].fault.reasonCode,
    "proto.frameAssemblyTimedOut",
  );
});

it("accepts a routed candidate through the loose boundary schema", () => {
  const decode = Schema.decodeUnknownSync(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("complete"), topic: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("fragment"), topic: Schema.String }),
    ]),
  );
  assert.equal(decode({ kind: "complete", topic: "t" }).kind, "complete");
});
