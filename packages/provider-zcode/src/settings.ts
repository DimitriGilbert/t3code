/**
 * ZCode instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-zcode/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ZcodeSettings = makeProviderSettingsSchema(
  {
    // Off by default (like Cursor and Grok): the binding needs a local
    // ZCode install (`zcode` CLI), so users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("zcode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the ZCode CLI (`zcode`) spawned as `zcode app-server --stdio`.",
        providerSettingsForm: { placeholder: "zcode", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type ZcodeSettings = typeof ZcodeSettings.Type;
