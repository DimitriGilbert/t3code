/**
 * ZCode's server entry: the adapter driver the server registers. The
 * `ProviderDriver` (status/auth probing) lands with the driver phase.
 *
 * @module provider-zcode/server
 */
export { ZCODE_DEFAULT_INSTANCE_ID, ZCODE_PROVIDER } from "./server/driverKind.ts";
export { ZcodeAdapterV2Driver, type ZcodeAdapterV2DriverEnv } from "./server/adapter.ts";
