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
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ZcodeSettings = makeProviderSettingsSchema(
  {
    // Off by default (like Cursor and Grok): the binding needs the
    // third-party zcode-acp-server bridge plus a local ZCode install, so
    // users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("zcode-acp-server").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the zcode-acp-server ACP bridge binary.",
        providerSettingsForm: { placeholder: "zcode-acp-server", clearWhenEmpty: "omit" },
      }),
    ),
    zcodeBinaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "ZCode binary path",
        description:
          "Path to the ZCode CLI the bridge launches. Forwarded as ZCODE_BIN; when unset the bridge falls back to PATH and desktop-app installs.",
        providerSettingsForm: { placeholder: "zcode", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "zcodeBinaryPath"],
  },
);
export type ZcodeSettings = typeof ZcodeSettings.Type;
