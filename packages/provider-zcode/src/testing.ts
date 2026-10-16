/**
 * ZCode internals the server's replay testkit, fixture recorder, and
 * orchestration tests drive directly.
 *
 * @module provider-zcode/testing
 */
export {
  ZcodeAdapterV2Driver,
  ZcodeProviderCapabilitiesV2,
  makeZcodeAcpAdapterFlavor,
  makeZcodeAdapterV2,
  zcodePromptFailure,
  zcodeSessionModeForPolicy,
  type ZcodeAdapterV2DriverEnv,
  type ZcodeAdapterV2Options,
} from "./server/adapter.ts";
export {
  ZCODE_ACP_AUTH_METHOD_ID,
  applyZcodeAcpModelSelection,
  buildZcodeAcpSpawnInput,
  makeZcodeAcpRuntime,
  zcodeAcpRuntimeProcessOwnership,
  zcodeAcpSpawnArgs,
} from "./server/zcodeAcp.ts";
export { ZCODE_DEFAULT_INSTANCE_ID, ZCODE_PROVIDER } from "./server/driverKind.ts";
