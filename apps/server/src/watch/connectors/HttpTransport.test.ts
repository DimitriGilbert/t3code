import { assert, it } from "@effect/vitest";
import { WatchConnectorError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as HttpTransport from "./HttpTransport.ts";

const isConnectorError = Schema.is(WatchConnectorError);

/** Awaits a rejection; asserts the typed egress-blocked reason. */
const expectEgressBlocked = async (promise: Promise<Response>) => {
  const rejection = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert.isTrue(isConnectorError(rejection));
  if (isConnectorError(rejection)) {
    assert.equal(rejection.reason, "egressBlocked");
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
