/**
 * ZCode's client definition: settings form, label, and glyph. The glyph is
 * the z.ai "Z" mark from ZCode's own logo (public/logo), without its
 * rounded-square chrome. Browser- and React Native-safe.
 *
 * @module provider-zcode/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ZcodeSettings } from "./settings.ts";

export const zcodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zcode"),
  label: "ZCode",
  settingsSchema: ZcodeSettings,
  icon: {
    viewBox: "0 0 18 18",
    fill: { light: "#151718", dark: "#F5F5F5" },
    paths: [
      {
        d: "M9.03854 3.86902L8.2306 5.01755C8.1036 5.19645 7.89598 5.306 7.67092 5.306H3.26767V3.86328C3.26767 3.86902 9.03854 3.86902 9.03854 3.86902Z",
      },
      { d: "M14.5209 3.86328L7.59573 13.6741H2.97913L9.90426 3.86328H14.5209Z" },
      {
        d: "M8.46146 13.6732L9.27514 12.5189C9.40214 12.34 9.60975 12.2305 9.83482 12.2305H14.2323V13.6732H8.46146Z",
      },
    ],
  },
});
