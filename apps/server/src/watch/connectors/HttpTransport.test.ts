import { assert, it } from "@effect/vitest";
import { WatchConnectorError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as HttpTransport from "./HttpTransport.ts";
import * as PackStore from "./PackStore.ts";

const isConnectorError = Schema.is(WatchConnectorError);

/** Awaits a rejection; asserts the typed egress-blocked reason. */
const expectEgressBlocked = async (promise: Promise<unknown>) => {
  const rejection = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert.isTrue(isConnectorError(rejection));
  if (isConnectorError(rejection)) {
    assert.equal(rejection.reason, "egressBlocked");
  }
};

/** Awaits a rejection; asserts the typed fetch-failed reason. */
const expectFetchFailed = async (promise: Promise<unknown>) => {
  const rejection = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert.isTrue(isConnectorError(rejection));
  if (isConnectorError(rejection)) {
    assert.equal(rejection.reason, "fetchFailed");
  }
};

it("matches declared hosts exactly, wildcard subdomains, and nothing else", () => {
  const declared = ["api.example.com", "*.webhooks.example.com"];
  assert.isTrue(HttpTransport.isHostAllowed("api.example.com", declared));
  // Case-insensitive on both sides.
  assert.isTrue(HttpTransport.isHostAllowed("API.Example.COM", ["api.example.com"]));
  assert.isTrue(HttpTransport.isHostAllowed("a.webhooks.example.com", declared));
  // The wildcard does not cover the apex or unrelated suffixes.
  assert.isFalse(HttpTransport.isHostAllowed("webhooks.example.com", declared));
  assert.isFalse(HttpTransport.isHostAllowed("evilapi.example.com", declared));
  assert.isFalse(HttpTransport.isHostAllowed("example.com.evil.net", declared));
});

it("rejects an undeclared host at the fetch layer without touching the network", async () => {
  let called = false;
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: () => {
      called = true;
      return Promise.resolve(new Response("ok"));
    },
  });
  await expectEgressBlocked(fetch("https://evil.example.com/data"));
  assert.isFalse(called);
});

it("rejects non-http(s) schemes and Request-shaped inputs too", async () => {
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: () => Promise.reject(new Error("should not be called")),
  });
  await expectEgressBlocked(fetch("file:///etc/passwd"));
  await expectEgressBlocked(fetch(new Request("https://unlisted.example.com/x")));
});

it("never auto-follows redirects — a 302 to an undeclared host opens no socket", async () => {
  const seen: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: (input, init) => {
      seen.push({ url: input.toString(), redirect: init?.redirect });
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/x" },
        }),
      );
    },
  });
  // Even when pack code explicitly asks for follow, manual wins and the 302
  // is surfaced instead of being chased to the redirect target.
  const response = await fetch("https://api.example.com/status", { redirect: "follow" });
  assert.equal(response.status, 302);
  assert.deepEqual(seen, [{ url: "https://api.example.com/status", redirect: "manual" }]);
  // Pack code following the hop itself goes back through the gate.
  await expectEgressBlocked(fetch(response.headers.get("location") ?? ""));
  assert.equal(seen.length, 1);
});

it("passes declared hosts through to the injected implementation", async () => {
  const seen: Array<string> = [];
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com", "*.webhooks.example.com"],
    fetchImpl: (input) => {
      seen.push(input.toString());
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  const response = await fetch("https://api.example.com/status");
  assert.equal(response.status, 200);
  await fetch(new URL("https://hooks.webhooks.example.com/p"));
  assert.deepEqual(seen, [
    "https://api.example.com/status",
    "https://hooks.webhooks.example.com/p",
  ]);
});

it("matches a host spelled with a trailing-dot FQDN marker to its declared rule", () => {
  // `api.example.com.` is the same name as `api.example.com` — the trailing
  // dot is normalized off before matching, so neither spelling forks the gate.
  assert.isTrue(HttpTransport.isHostAllowed("api.example.com.", ["api.example.com"]));
  assert.isTrue(HttpTransport.isHostAllowed("a.example.com.", ["*.example.com"]));
  assert.isFalse(HttpTransport.isHostAllowed("evil.example.", ["*.example.com"]));
  assert.isFalse(HttpTransport.isHostAllowed("example.com.", ["*.example.com"]));
});

it("blocks a declared host resolving to a loopback or link-local address at runtime egress", async () => {
  const gated = (addresses: ReadonlyArray<PackStore.PackFetchAddress>) =>
    HttpTransport.makeEgressFetch({
      egressHosts: ["api.example.com"],
      fetchImpl: HttpTransport.makeNodeEgressFetch({
        resolveHost: () => Promise.resolve(addresses),
      }),
    });
  // Runtime egress has no allowLocal acknowledgement: a declared host that
  // resolves private is refused before any socket opens.
  await expectEgressBlocked(
    gated([{ address: "127.0.0.1", family: 4 }])("https://api.example.com/data"),
  );
  await expectEgressBlocked(
    gated([{ address: "169.254.169.254", family: 4 }])("https://api.example.com/latest/meta-data"),
  );
  await expectEgressBlocked(
    gated([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ])("https://api.example.com/data"),
  );
});

it("resolves the normalized hostname — case and FQDN dot cannot fork the check", async () => {
  const seen: Array<string> = [];
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: HttpTransport.makeNodeEgressFetch({
      resolveHost: (host) => {
        seen.push(host);
        return Promise.resolve([{ address: "127.0.0.1", family: 4 as const }]);
      },
    }),
  });
  await expectEgressBlocked(fetch("https://API.Example.COM./data"));
  assert.deepEqual(seen, ["api.example.com"]);
});

it("rejects an egress response whose declared length exceeds the byte cap", async () => {
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: () =>
      Promise.resolve(
        new Response("x".repeat(64), {
          status: 200,
          headers: { "content-length": "64" },
        }),
      ),
    maxResponseBytes: 32,
  });
  await expectFetchFailed(fetch("https://api.example.com/big"));
});

it("rejects an egress response whose streamed body crosses the byte cap", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a".repeat(64)));
      controller.enqueue(new TextEncoder().encode("b".repeat(64)));
      controller.close();
    },
  });
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: () => Promise.resolve(new Response(body, { status: 200 })),
    maxResponseBytes: 64,
  });
  const response = await fetch("https://api.example.com/stream");
  await expectFetchFailed(response.text());
});

it("lets a response under the byte cap read normally", async () => {
  const fetch = HttpTransport.makeEgressFetch({
    egressHosts: ["api.example.com"],
    fetchImpl: () => Promise.resolve(new Response("ok", { status: 200 })),
    maxResponseBytes: 8,
  });
  const response = await fetch("https://api.example.com/small");
  assert.equal(await response.text(), "ok");
});
