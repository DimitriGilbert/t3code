import { WatchConnectorError } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * The `http`-transport egress gate. Pack fetch code receives a `ctx.fetch`
 * built here: every request's host is checked against the manifest's declared
 * `egressHosts` before a socket is opened — the pack's own code can never
 * reach an undeclared host. This is the enforcement layer the PRD's "declared
 * egress allowlist" mitigation stands on; the sandbox itself is not the
 * boundary.
 */

export type ConnectorEgressFetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The concrete fetch implementation behind the egress wrapper — injectable so
 * tests (and any future DNS-pinning layer) can substitute it without pack code
 * ever seeing the difference.
 */
export class ConnectorEgressFetch extends Context.Reference<ConnectorEgressFetchImpl>(
  "t3/watch/connectors/HttpTransport/ConnectorEgressFetch",
  { defaultValue: () => fetch },
) {}

/** Default ceiling for a single egress call when pack code sets no signal. */
export const DEFAULT_EGRESS_TIMEOUT_MS = 30_000;

/**
 * A declared host matches exactly, or as a `*.example.com` wildcard covering
 * subdomains (the apex itself still needs its own entry).
 */
export const isHostAllowed = (hostname: string, declared: ReadonlyArray<string>): boolean => {
  const host = hostname.toLowerCase();
  for (const entry of declared) {
    const rule = entry.toLowerCase();
    if (rule === host) return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2);
      if (host.endsWith(`.${suffix}`)) return true;
    }
  }
  return false;
};

const egressBlocked = (url: string) =>
  new WatchConnectorError({
    message: `Connector egress to ${url} is not in the pack's declared egressHosts.`,
    reason: "egressBlocked",
  });

/**
 * Builds the `fetch` handed to pack code. Scheme is pinned to http(s) and the
 * hostname must match the declared allowlist — checked before any network I/O,
 * so an undeclared host fails closed without a socket ever opening.
 */
export const makeEgressFetch =
  ({
    egressHosts,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_EGRESS_TIMEOUT_MS,
  }: {
    readonly egressHosts: ReadonlyArray<string>;
    readonly fetchImpl?: ConnectorEgressFetchImpl;
    readonly timeoutMs?: number;
  }): ConnectorEgressFetchImpl =>
  (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return Promise.reject(egressBlocked(input.toString()));
    }
    if (!isHostAllowed(url.hostname, egressHosts)) {
      return Promise.reject(egressBlocked(url.toString()));
    }
    return fetchImpl(input, {
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
  };
