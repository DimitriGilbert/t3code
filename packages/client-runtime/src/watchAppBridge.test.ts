// @effect-diagnostics globalTimers:off - Tests flush microtasks with a real timer.
import {
  WatchConnectorInstanceId,
  WatchWidgetSourceId,
  type WatchWidgetBridgeManifest,
  type WatchWidgetSourceRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  buildWatchAppDocument,
  makeWatchAppHost,
  resolveWatchAppArtifact,
  WATCH_APP_METHODS,
  WATCH_APP_NOTIFICATIONS,
  WATCH_APP_PRELUDE,
  WATCH_APP_PRELUDE_SCRIPT_HASH,
  watchAppContentSecurityPolicy,
  type WatchAppBridgeViolation,
  type WatchAppHostHandlers,
} from "./watchAppBridge.ts";

const instanceId = Schema.decodeSync(WatchConnectorInstanceId)("instance-1");
const otherInstanceId = Schema.decodeSync(WatchConnectorInstanceId)("instance-2");
const sourceId = Schema.decodeSync(WatchWidgetSourceId)("source-1");
const manifest: WatchWidgetBridgeManifest = {
  subscriptions: ["status"],
  actions: ["restart"],
};

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeTestHost(overrides: Partial<WatchAppHostHandlers> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const violations: Array<WatchAppBridgeViolation> = [];
  const opened: Array<{ name: string; instanceId: WatchConnectorInstanceId | undefined }> = [];
  const closed: Array<string> = [];
  const invoked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const host = makeWatchAppHost({
    manifest,
    connectorInstanceId: () => instanceId,
    post: (message) => {
      posted.push(message as Record<string, unknown>);
    },
    openSubscription: async (input) => {
      opened.push(input);
      return overrides.openSubscription === undefined
        ? undefined
        : overrides.openSubscription(input);
    },
    closeSubscription: (input) => {
      closed.push(input.name);
      overrides.closeSubscription?.(input);
    },
    invokeAction: async (input) => {
      invoked.push(input);
      return overrides.invokeAction === undefined ? { ok: true } : overrides.invokeAction(input);
    },
    onViolation: (violation) => {
      violations.push(violation);
    },
  });
  return { host, posted, violations, opened, closed, invoked };
}

const request = (id: number | string, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const errorReplies = (posted: Array<Record<string, unknown>>) =>
  posted.filter((message) => "error" in message);

describe("watchAppContentSecurityPolicy", () => {
  it("denies every network direction and hash-authorizes only prelude + bundle", () => {
    const csp = watchAppContentSecurityPolicy("abc123hash==");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("font-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain(`'sha256-${WATCH_APP_PRELUDE_SCRIPT_HASH}'`);
    expect(csp).toContain("'sha256-abc123hash=='");
    // Scripts are hash-authorized only — no inline-script escape hatch.
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("unsafe-inline");
    // No other fetch directives sneak network back in.
    expect(csp).not.toMatch(/media-src|object-src|frame-src|worker-src|manifest-src|prefetch-src/);
  });

  it("rejects a script hash that cannot be a base64 digest", () => {
    expect(() => watchAppContentSecurityPolicy('"; alert(1); //')).toThrow();
    expect(() => watchAppContentSecurityPolicy("")).toThrow();
  });

  it("keeps the recorded prelude hash equal to the prelude's SHA-256", async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(WATCH_APP_PRELUDE),
    );
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(base64).toBe(WATCH_APP_PRELUDE_SCRIPT_HASH);
  });
});

describe("buildWatchAppDocument", () => {
  it("puts the CSP meta first, then the T3 prelude, then the bundle", () => {
    const document = buildWatchAppDocument({ bundle: "BUNDLE_MARKER;", scriptHash: "hash==" });
    const cspIndex = document.indexOf("Content-Security-Policy");
    const preludeIndex = document.indexOf(WATCH_APP_PRELUDE);
    const bundleIndex = document.indexOf("BUNDLE_MARKER;");
    expect(cspIndex).toBeGreaterThan(-1);
    expect(preludeIndex).toBeGreaterThan(cspIndex);
    expect(bundleIndex).toBeGreaterThan(preludeIndex);
    // T3 is defined before the bundle runs — the JSX pragma target exists.
    expect(WATCH_APP_PRELUDE).toContain("globalThis.T3");
    expect(WATCH_APP_PRELUDE).toContain("h:h");
    expect(WATCH_APP_PRELUDE).toContain("Fragment:Fragment");
  });

  it("is byte-identical across calls — the same bytes web srcdoc and mobile html load", () => {
    const first = buildWatchAppDocument({ bundle: "x();", scriptHash: "hash==" });
    const second = buildWatchAppDocument({ bundle: "x();", scriptHash: "hash==" });
    expect(first).toBe(second);
    // One prelude serves both transports: iframe postMessage and RN WebView.
    expect(WATCH_APP_PRELUDE).toContain("window.parent.postMessage");
    expect(WATCH_APP_PRELUDE).toContain("ReactNativeWebView");
    // A literal close-tag would truncate the prelude's own script block.
    expect(WATCH_APP_PRELUDE).not.toContain("</script");
  });
});

describe("makeWatchAppHost", () => {
  it("drops undeclared subscription names and surfaces them as violations", async () => {
    const { host, posted, violations, opened } = makeTestHost();
    host.receive(request(1, WATCH_APP_METHODS.subscribe, { name: "secrets" }));
    await flushAsync();
    expect(opened).toEqual([]);
    expect(violations).toEqual([
      expect.objectContaining({ code: "undeclaredSubscription", name: "secrets" }),
    ]);
    expect(errorReplies(posted)).toHaveLength(1);
    expect(errorReplies(posted)[0]?.id).toBe(1);
  });

  it("drops undeclared actions and surfaces them as violations", async () => {
    const { host, posted, violations, invoked } = makeTestHost();
    host.receive(request(1, WATCH_APP_METHODS.action, { name: "exfiltrate", arguments: {} }));
    await flushAsync();
    expect(invoked).toEqual([]);
    expect(violations).toEqual([
      expect.objectContaining({ code: "undeclaredAction", name: "exfiltrate" }),
    ]);
    expect(errorReplies(posted)).toHaveLength(1);
  });

  it("rejects a frame-supplied instance id that is not the row's binding", async () => {
    const { host, posted, violations, opened } = makeTestHost();
    host.receive(
      request(1, WATCH_APP_METHODS.subscribe, {
        name: "status",
        instanceId: otherInstanceId,
      }),
    );
    await flushAsync();
    expect(opened).toEqual([]);
    expect(violations).toEqual([
      expect.objectContaining({ code: "foreignInstance", name: "status" }),
    ]);
    expect(errorReplies(posted)).toHaveLength(1);
  });

  it("rejects any frame-supplied instance id when the row binds none", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const violations: Array<WatchAppBridgeViolation> = [];
    const opened: Array<{ name: string; instanceId: WatchConnectorInstanceId | undefined }> = [];
    const host = makeWatchAppHost({
      manifest,
      connectorInstanceId: () => undefined,
      post: (message) => {
        posted.push(message as Record<string, unknown>);
      },
      openSubscription: async (input) => {
        opened.push(input);
      },
      closeSubscription: () => {},
      invokeAction: async () => ({}),
      onViolation: (violation) => {
        violations.push(violation);
      },
    });
    host.receive(
      request(1, WATCH_APP_METHODS.subscribe, { name: "status", instanceId: instanceId }),
    );
    await flushAsync();
    expect(opened).toEqual([]);
    expect(violations[0]?.code).toBe("foreignInstance");
    expect(errorReplies(posted)).toHaveLength(1);
  });

  it("opens a declared subscription against the host-resolved instance, not the frame's", async () => {
    const { host, posted, violations, opened } = makeTestHost();
    // The frame may echo the bound id — the opened feed still gets the
    // host-side resolution, never the frame's copy.
    host.receive(
      request(1, WATCH_APP_METHODS.subscribe, { name: "status", instanceId: instanceId }),
    );
    await flushAsync();
    expect(violations).toEqual([]);
    expect(opened).toEqual([{ name: "status", instanceId }]);
    expect(posted).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);

    host.deliver("status", { ok: true });
    expect(posted.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: WATCH_APP_NOTIFICATIONS.data,
      params: { name: "status", item: { ok: true } },
    });

    host.deliverError("status", "stream failed");
    expect(posted.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: WATCH_APP_NOTIFICATIONS.dataError,
      params: { name: "status", error: { message: "stream failed" } },
    });
  });

  it("does not deliver to subscriptions the frame never opened", () => {
    const { host, posted } = makeTestHost();
    host.deliver("status", { ok: true });
    host.deliverError("status", "nope");
    expect(posted).toEqual([]);
  });

  it("closes a feed that was unsubscribed while its open was still resolving", async () => {
    let resolveOpen: (() => void) | undefined;
    const { host, posted, closed } = makeTestHost({
      openSubscription: () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    host.receive(request(1, WATCH_APP_METHODS.subscribe, { name: "status" }));
    // The widget releases before the platform feed comes up.
    host.receive(request(2, WATCH_APP_METHODS.unsubscribe, { name: "status" }));
    await flushAsync();
    resolveOpen?.();
    await flushAsync();
    // The late-resolving feed is closed back, not tracked as open — a later
    // deliver must not reach the document.
    expect(closed).toEqual(["status"]);
    host.deliver("status", { ok: true });
    expect(posted.filter((m) => m.method === WATCH_APP_NOTIFICATIONS.data)).toEqual([]);
  });

  it("unsubscribes through the request and stops delivery", async () => {
    const { host, posted, closed } = makeTestHost();
    host.receive(request(1, WATCH_APP_METHODS.subscribe, { name: "status" }));
    await flushAsync();
    host.receive(request(2, WATCH_APP_METHODS.unsubscribe, { name: "status" }));
    await flushAsync();
    expect(closed).toEqual(["status"]);
    host.deliver("status", { ok: true });
    expect(posted).toHaveLength(2);
  });

  it("invokes declared actions with their arguments and returns the result", async () => {
    const { host, posted, invoked } = makeTestHost();
    host.receive(
      request(1, WATCH_APP_METHODS.action, { name: "restart", arguments: { force: true } }),
    );
    await flushAsync();
    expect(invoked).toEqual([{ name: "restart", arguments: { force: true } }]);
    expect(posted).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("ignores malformed messages and notifications without touching handlers", () => {
    const { host, posted, opened } = makeTestHost();
    host.receive(null);
    host.receive("garbage");
    host.receive({ jsonrpc: "2.0" });
    host.receive({
      jsonrpc: "2.0",
      method: WATCH_APP_METHODS.subscribe,
      params: { name: "status" },
    });
    host.receive({ jsonrpc: "2.0", method: "t3.watch/data", params: {} });
    expect(posted).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("replies method-not-found for unknown request methods", () => {
    const { host, posted } = makeTestHost();
    host.receive(request(9, "t3.watch/exec"));
    expect(posted).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        error: { code: -32601, message: "Method not found: t3.watch/exec" },
      },
    ]);
  });

  it("closes every open feed on dispose and stops posting", async () => {
    const { host, posted, closed } = makeTestHost();
    host.receive(request(1, WATCH_APP_METHODS.subscribe, { name: "status" }));
    await flushAsync();
    host.dispose();
    expect(closed).toEqual(["status"]);
    const count = posted.length;
    host.deliver("status", { ok: true });
    host.receive(request(2, WATCH_APP_METHODS.subscribe, { name: "status" }));
    await flushAsync();
    expect(posted).toHaveLength(count);
  });
});

describe("resolveWatchAppArtifact", () => {
  const record: WatchWidgetSourceRecord = {
    sourceId,
    source: "export default () => {}",
    manifest,
    artifactHash: "a".repeat(64),
    scriptHash: "hash==",
    status: "ready" as const,
    failure: null,
  };

  it("walks loading → missing → pending → ready → failed", () => {
    expect(resolveWatchAppArtifact(undefined, undefined)._tag).toBe("pending");
    expect(resolveWatchAppArtifact(null, undefined)._tag).toBe("missing");
    expect(resolveWatchAppArtifact(record, undefined)._tag).toBe("pending");
    expect(resolveWatchAppArtifact(record, null)._tag).toBe("pending");
    expect(resolveWatchAppArtifact(record, "bundle")._tag).toBe("ready");
    expect(
      resolveWatchAppArtifact({ ...record, status: "failed", scriptHash: null }, undefined)._tag,
    ).toBe("failed");
  });
});
