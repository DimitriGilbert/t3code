/**
 * Devin's server entry: the adapter driver the orchestrator registers. The
 * `ProviderDriver` (status/auth probing, maintenance, snapshot) lands in a
 * later phase.
 *
 * @module provider-devin/server
 */
export { DEVIN_DEFAULT_INSTANCE_ID, DEVIN_PROVIDER } from "./server/driverKind.ts";
export { DevinAdapterV2Driver, type DevinAdapterV2DriverEnv } from "./server/adapter.ts";
export {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "./server/devinSessionUpdates.ts";
