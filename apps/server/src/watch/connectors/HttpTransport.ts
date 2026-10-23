// @effect-diagnostics nodeBuiltinImport:off - the runtime egress transport
// pins socket DNS lookups to a checked address list, which needs node
// builtins (same posture as PackStore.ts).
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

import { WatchConnectorError } from "@t3tools/contracts";
import * as Context from "effect/Context";

import * as PackStore from "./PackStore.ts";

/**
 * The `http`-transport egress gate. Pack fetch code receives a `ctx.fetch`
 * built here: every request's host is checked against the manifest's declared
 * `egressHosts` before a socket is opened — the pack's own code can never
 * reach an undeclared host. This is the enforcement layer the PRD's "declared
 * egress allowlist" mitigation stands on, and it is real: pack code runs in a
 * worker thread whose only network path is a MessagePort RPC answered by the
 * implementation built here (see PackModule.ts).
 *
 * The default transport resolves the target once, refuses any answer that is
 * local to this machine, and pins the socket's `lookup` to the checked list —
 * the same resolve → block → pin pipeline pack installs use (PackStore.ts),
 * so a declared host cannot be DNS-rebound into the local network. Unlike the
 * install path there is no `allowLocal` acknowledgement: runtime egress never
 * reaches a loopback, link-local, or private address.
 */

export type ConnectorEgressFetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * How the egress transport resolves a host — injectable so tests can pin the
 * answer without pack code ever seeing the difference.
 */
export type EgressResolveHost = (
  host: string,
) => Promise<ReadonlyArray<PackStore.PackFetchAddress>>;

/**
 * The concrete fetch implementation behind the egress wrapper — injectable so
 * tests can substitute it without pack code ever seeing the difference. The
 * default is {@link nodeEgressFetch}: real sockets with DNS pinned to the
 * checked address list.
 */
export class ConnectorEgressFetch extends Context.Reference<ConnectorEgressFetchImpl>(
  "t3/watch/connectors/HttpTransport/ConnectorEgressFetch",
  { defaultValue: () => nodeEgressFetch },
) {}

/** Default ceiling for a single egress call when pack code sets no signal. */
export const DEFAULT_EGRESS_TIMEOUT_MS = 30_000;
/** Byte ceiling on one egress response body — oversized bodies are rejected, never truncated. */
export const MAX_EGRESS_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Lowercases a host and strips IPv6 brackets and trailing-dot FQDN markers,
 * so the same host can neither dodge nor miss a rule by spelling.
 */
const normalizeHostname = (hostname: string): string => {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
};

/**
 * A declared host matches exactly, or as a `*.example.com` wildcard covering
 * subdomains (the apex itself still needs its own entry).
 */
export const isHostAllowed = (hostname: string, declared: ReadonlyArray<string>): boolean => {
  const host = normalizeHostname(hostname);
  for (const entry of declared) {
    const rule = normalizeHostname(entry);
    if (rule === host) return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2);
      if (suffix.length > 0 && host.endsWith(`.${suffix}`)) return true;
    }
  }
  return false;
};

const egressBlocked = (url: string) =>
  new WatchConnectorError({
    message: `Connector egress to ${url} is not in the pack's declared egressHosts.`,
    reason: "egressBlocked",
  });

const egressFailed = (message: string, cause?: unknown) =>
  new WatchConnectorError({
    message,
    reason: "fetchFailed",
    ...(cause === undefined ? {} : { cause }),
  });

// ── Default transport: resolve → local-block → pinned lookup ─────────────

/** Response statuses that may not carry a body — `new Response` rejects one there. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * One request over node http(s) whose socket `lookup` is pinned to
 * `addresses` — the list the caller already resolved and range-checked, so
 * DNS cannot rebind the connection to an unchecked answer. The hostname still
 * drives Host/SNI, so TLS verification is unchanged.
 */
const requestPinned = (
  request: Request,
  url: URL,
  transport: typeof NodeHttp | typeof NodeHttps,
  addresses: ReadonlyArray<PackStore.PackFetchAddress>,
): Promise<Response> =>
  new Promise<Response>((resolvePromise, reject) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const nodeRequest = transport.request(
      url,
      {
        method: request.method,
        headers,
        lookup: PackStore.pinnedLookup(addresses),
        signal: request.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.resume();
          reject(
            egressFailed(`Connector egress to ${url.toString()} got invalid status ${status}.`),
          );
          return;
        }
        const responseHeaders = new Headers();
        for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) {
          responseHeaders.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!);
        }
        try {
          resolvePromise(
            new Response(
              NULL_BODY_STATUSES.has(status)
                ? null
                : (NodeStream.Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
              { status, statusText: res.statusMessage ?? "", headers: responseHeaders },
            ),
          );
        } catch (cause) {
          res.destroy();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      },
    );
    nodeRequest.on("error", (cause) =>
      reject(egressFailed(`Connector egress to ${url.toString()} failed.`, cause)),
    );
    const body = request.body;
    if (body === null) {
      nodeRequest.end();
      return;
    }
    NodeStream.Readable.fromWeb(body as Parameters<typeof NodeStream.Readable.fromWeb>[0])
      .on("error", (cause) => nodeRequest.destroy(cause))
      .pipe(nodeRequest);
  });

/**
 * The production egress transport: resolves the target once, refuses any
 * answer {@link PackStore.isLocalAddress} flags, and pins the connection to
 * the checked list. `resolveHost` is the injectable seam — the check and the
 * pin always run on whatever it answers.
 */
export const makeNodeEgressFetch =
  (options: { readonly resolveHost?: EgressResolveHost } = {}): ConnectorEgressFetchImpl =>
  async (input, init) => {
    const resolveHost = options.resolveHost ?? PackStore.resolveHostAddresses;
    const request = new Request(input, init);
    const url = new URL(request.url);
    const transport =
      url.protocol === "https:" ? NodeHttps : url.protocol === "http:" ? NodeHttp : undefined;
    if (transport === undefined) {
      throw egressBlocked(url.toString());
    }
    const host = normalizeHostname(url.hostname);
    const addresses = await resolveHost(host).catch((cause: unknown) => {
      throw egressFailed(`Connector egress could not resolve ${host}.`, cause);
    });
    if (addresses.length === 0) {
      throw egressFailed(`Connector egress host ${host} does not resolve.`);
    }
    if (addresses.some(({ address, family }) => PackStore.isLocalAddress(address, family))) {
      throw new WatchConnectorError({
        message: `Connector egress host ${host} resolves to a loopback, link-local, or private address.`,
        reason: "egressBlocked",
      });
    }
    return requestPinned(request, url, transport, addresses);
  };

const nodeEgressFetch = makeNodeEgressFetch();

// ── Egress gate ──────────────────────────────────────────────────────────

/**
 * Byte cap on egress bodies. A declared `content-length` is checked up front;
 * the stream is otherwise counted as it flows — an oversized body rejects
 * whichever read crosses the cap, it is never truncated.
 */
const capResponseBody = (response: Response, url: URL, maxBytes: number): Response => {
  if (response.body === null) return response;
  const tooLarge = () =>
    egressFailed(
      `Connector egress response from ${url.toString()} exceeds the ${maxBytes}-byte limit.`,
    );
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  let seen = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(tooLarge());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * Builds the `fetch` handed to pack code. Scheme is pinned to http(s) and the
 * hostname must match the declared allowlist — checked before any network I/O,
 * so an undeclared host fails closed without a socket ever opening. The impl
 * (the pinned transport by default) then resolves, local-checks, and connects.
 */
export const makeEgressFetch =
  ({
    egressHosts,
    fetchImpl = nodeEgressFetch,
    timeoutMs = DEFAULT_EGRESS_TIMEOUT_MS,
    maxResponseBytes = MAX_EGRESS_RESPONSE_BYTES,
  }: {
    readonly egressHosts: ReadonlyArray<string>;
    readonly fetchImpl?: ConnectorEgressFetchImpl;
    readonly timeoutMs?: number;
    /** Byte ceiling for one response body; oversized bodies fail the call. */
    readonly maxResponseBytes?: number;
  }): ConnectorEgressFetchImpl =>
  async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw egressBlocked(input.toString());
    }
    if (!isHostAllowed(url.hostname, egressHosts)) {
      throw egressBlocked(url.toString());
    }
    const response = await fetchImpl(input, {
      ...init,
      // Redirects are never auto-followed — after `...init`, so pack code
      // cannot turn it back on. A declared host could otherwise 302 into an
      // undeclared one; pack code follows hops through ctx.fetch instead,
      // which re-gates each target (the same model as PackStore's hop
      // revalidation).
      redirect: "manual",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    return capResponseBody(response, url, maxResponseBytes);
  };
