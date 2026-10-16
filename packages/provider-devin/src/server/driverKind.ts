/**
 * Devin's driver kind and default instance id, shared by the adapter,
 * driver, and replay testkit.
 *
 * @module provider-devin/server/driverKind
 */
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";

export const DEVIN_PROVIDER = ProviderDriverKind.make("devin");
export const DEVIN_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(DEVIN_PROVIDER);
