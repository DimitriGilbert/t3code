/**
 * ZCode's server entry: the adapter driver the orchestrator registers and the
 * `ProviderDriver` the instance registry builds (status/auth probing,
 * maintenance, snapshot).
 *
 * @module provider-zcode/server
 */
export { ZCODE_DEFAULT_INSTANCE_ID, ZCODE_PROVIDER } from "./server/driverKind.ts";
export { ZcodeAdapterV2Driver, type ZcodeAdapterV2DriverEnv } from "./server/adapter.ts";
export { ZcodeDriver, type ZcodeDriverEnv } from "./server/driver.ts";
