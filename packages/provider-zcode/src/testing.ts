/**
 * ZCode internals the server's replay testkit, fixture recorder, and
 * orchestration tests drive directly.
 *
 * @module provider-zcode/testing
 */
export {
  ZcodeAdapterV2Driver,
  ZcodeProviderCapabilitiesV2,
  extractZcodeProposedPlanMarkdown,
  extractZcodeSubagentUpdate,
  makeZcodeAcpAdapterFlavor,
  makeZcodeAdapterV2,
  zcodePermissionDisposition,
  zcodePromptFailure,
  zcodeSessionModeForPolicy,
  type ZcodeAdapterV2DriverEnv,
  type ZcodeAdapterV2Options,
} from "./server/adapter.ts";
export {
  ZCODE_ACP_AUTH_METHOD_ID,
  ZCODE_ACP_SERVER_BIN,
  ZCODE_BUILTIN_PROVIDER_CONFIG_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_ENV,
  applyZcodeAcpModelSelection,
  buildZcodeAcpSpawnInput,
  makeZcodeAcpRuntime,
  zcodeAcpRuntimeProcessOwnership,
  zcodeAcpSpawnArgs,
  zcodeProviderConfigEnv,
} from "./server/zcodeAcp.ts";
export {
  buildInitialZcodeProviderSnapshot,
  checkZcodeProviderStatus,
  enrichZcodeSnapshot,
  ZCODE_DEFAULT_MODEL_SLUG,
  zcodeCredentialFilesPresent,
  zcodeHomePath,
  zcodeModelsFromConfigOptions,
  zcodeSlashCommandsFromCommands,
  type ZcodeStatusProbeOptions,
} from "./server/status.ts";
export { makeZcodeAuth, ZCODE_LOGIN_METHOD_ID } from "./server/auth.ts";
export { ZcodeDriver, type ZcodeDriverEnv } from "./server/driver.ts";
export { ZCODE_DEFAULT_INSTANCE_ID, ZCODE_PROVIDER } from "./server/driverKind.ts";
