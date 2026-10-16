/**
 * ZCode's driver kind and default instance id, shared by the adapter,
 * driver, and replay testkit.
 *
 * @module provider-zcode/server/driverKind
 */
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";

export const ZCODE_PROVIDER = ProviderDriverKind.make("zcode");
export const ZCODE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(ZCODE_PROVIDER);
