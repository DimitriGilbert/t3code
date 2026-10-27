// @effect-diagnostics nodeBuiltinImport:off - credential decryption is
// AES-256-GCM over local bytes; the cipher and path hashing are pure
// functions with no async boundary, so node:crypto/node:path stay sync.
/**
 * ZCode credential material: decrypt `v2/credentials.json` (enc:v1
 * AES-256-GCM), build the account overlay, and answer
 * `interaction/requestProviderRuntimeHeaders`. Never log plaintext.
 *
 * @module provider-zcode/server/zcodeCredentials
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { zcodeHomePath } from "./status.ts";
import { ZCODE_BUILTIN_PROVIDER_CONFIG_ENV } from "./zcodeAppServer.ts";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";
const ZHIPU_ACCOUNT_ACCESS = "zhipu-account";
/** Plan modes that take the single-active-connection `current` flag. */
const CURRENT_SCOPED_MODES = new Set(["individual-coding-plan", "team-coding-plan", "start-plan"]);

const credentialSecret = Effect.fn("credentialSecret")(function* (environment: NodeJS.ProcessEnv) {
  const configured = environment[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const username = (yield* HostProcess.Username) ?? "unknown";
  return `zcode-credential-fallback:${platform}:${home}:${username}`;
});

const decryptCredential = (key: Buffer, value: string): string | undefined => {
  if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) return value;
  const parts = value.slice(ENCRYPTED_VALUE_PREFIX.length).split(".");
  if (parts.length !== 3) return undefined;
  const [ivRaw, authTagRaw, cipherRaw] = parts;
  if (!ivRaw || !authTagRaw || cipherRaw === undefined) return undefined;
  try {
    const iv = Buffer.from(ivRaw, "base64url");
    const authTag = Buffer.from(authTagRaw, "base64url");
    if (iv.length !== 12 || authTag.length !== 16) return undefined;
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(cipherRaw, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return undefined;
  }
};

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const readJsonObject = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
  if (raw._tag === "None") return undefined;
  const parsed = yield* decodeJsonString(raw.value).pipe(Effect.option);
  if (
    parsed._tag === "None" ||
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return undefined;
  }
  return parsed.value as Record<string, unknown>;
});

/** Decrypted credential store: key → plaintext. Missing/corrupt → empty. */
export const readZcodeCredentialStore = Effect.fn("readZcodeCredentialStore")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyMap<string, string>, never, FileSystem.FileSystem | Path.Path> {
  const home = yield* zcodeHomePath(environment);
  const path = yield* Path.Path;
  const store = yield* readJsonObject(path.join(home, "v2", "credentials.json"));
  const result = new Map<string, string>();
  if (store === undefined) return result;
  const secret = yield* credentialSecret(environment);
  const key = NodeCrypto.createHash("sha256").update(secret).digest();
  for (const [name, raw] of Object.entries(store)) {
    if (typeof raw !== "string") continue;
    const value = decryptCredential(key, raw);
    if (value !== undefined) result.set(name, value);
  }
  return result;
});

/** The builtin provider-config file the spawned app-server will read. */
export const resolveZcodeBuiltinProviderConfigPath = Effect.fn(
  "resolveZcodeBuiltinProviderConfigPath",
)(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const configured = environment[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* zcodeHomePath(environment);
  const candidate = path.join(home, "v2", "runtime", "provider", "bundled", "zcode-builtin.json");
  return (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
    ? candidate
    : undefined;
});

interface BuiltinProviderRule {
  readonly providerId: string;
  readonly providerName: string;
  readonly family: string;
  readonly mode: string;
  readonly builtinModelIds: ReadonlyArray<string>;
}

interface BuiltinRelease {
  readonly revision: number;
  readonly rules: ReadonlyArray<BuiltinProviderRule>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readBuiltinRelease = (raw: Record<string, unknown>): BuiltinRelease | undefined => {
  if (typeof raw.revision !== "number") return undefined;
  const rules = asRecord(asRecord(raw.config)?.providerConfigRules)?.providerRules;
  if (!Array.isArray(rules)) return undefined;
  const providers: Array<BuiltinProviderRule> = [];
  for (const rule of rules) {
    const record = asRecord(rule);
    const config = asRecord(record?.config);
    const access = asRecord(config?.access);
    if (
      typeof record?.providerId === "string" &&
      access?.type === ZHIPU_ACCOUNT_ACCESS &&
      typeof access.accountType === "string" &&
      typeof access.mode === "string"
    ) {
      providers.push({
        providerId: record.providerId,
        providerName:
          typeof record.providerName === "string" ? record.providerName : record.providerId,
        family: access.accountType,
        mode: access.mode,
        builtinModelIds: Array.isArray(config?.builtinModelIds)
          ? config.builtinModelIds.filter((id): id is string => typeof id === "string")
          : [],
      });
    }
  }
  return { revision: raw.revision, rules: providers };
};

/** `account:<family>-<kind>` id for a family connection selection. */
const selectedProviderId = (family: string, kind: string): string => `account:${family}-${kind}`;

const providerApiKey = (
  credentials: ReadonlyMap<string, string>,
  providerId: string,
): string | undefined => {
  // Stored keys look like
  // `account-provider:<scope>:<providerId>:...:account:<identity>:api-key`.
  const needle = `:${providerId}:`;
  for (const [key, value] of credentials) {
    if (
      key.startsWith("account-provider:") &&
      key.endsWith(":api-key") &&
      key.includes(needle) &&
      value.trim() !== ""
    ) {
      return value;
    }
  }
  return undefined;
};

/** Request auth material for `interaction/requestProviderRuntimeHeaders`. */
export const resolveZcodeRequestApiKey = (
  credentials: ReadonlyMap<string, string>,
  providerId: string,
): string | undefined => {
  const planKey = providerApiKey(credentials, providerId);
  if (planKey !== undefined) return planKey;
  // Start-plan requests authenticate with the account JWT.
  if (providerId.endsWith("-start-plan")) {
    const jwt = credentials.get("zcodejwttoken");
    if (jwt !== undefined && jwt.trim() !== "") return jwt;
  }
  return undefined;
};

interface AccountContext {
  readonly builtinPath: string;
  readonly release: BuiltinRelease;
  readonly credentials: ReadonlyMap<string, string>;
  readonly selections: Record<string, unknown>;
  readonly activeFamily: string | undefined;
  readonly hasJwt: boolean;
}

const resolveAccountContext = Effect.fn("resolveAccountContext")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<AccountContext | undefined, never, FileSystem.FileSystem | Path.Path> {
  const builtinPath = yield* resolveZcodeBuiltinProviderConfigPath(environment);
  if (builtinPath === undefined) return undefined;
  const raw = yield* readJsonObject(builtinPath);
  const release = raw === undefined ? undefined : readBuiltinRelease(raw);
  if (release === undefined) return undefined;
  const home = yield* zcodeHomePath(environment);
  const path = yield* Path.Path;
  const settings = yield* readJsonObject(path.join(home, "v2", "setting.json"));
  const credentials = yield* readZcodeCredentialStore(environment);
  return {
    builtinPath,
    release,
    credentials,
    selections: asRecord(settings?.providerFamilyConnectionSelections) ?? {},
    activeFamily: credentials.get("oauth:active_provider")?.trim(),
    hasJwt: credentials.get("zcodejwttoken") !== undefined,
  };
});

const entitlementOf = (
  context: Pick<AccountContext, "credentials" | "activeFamily" | "hasJwt">,
  rule: BuiltinProviderRule,
): boolean =>
  providerApiKey(context.credentials, rule.providerId) !== undefined ||
  (rule.mode === "start-plan" && context.hasJwt && rule.family === context.activeFamily);

/** Provider id of each family's selected connection (settings, else first entitled). */
const selectedByFamilyOf = (
  release: BuiltinRelease,
  selections: Record<string, unknown>,
  entitled: (rule: BuiltinProviderRule) => boolean,
): ReadonlyMap<string, string> => {
  const selected = new Map<string, string>();
  const firstEntitled = new Map<string, string>();
  for (const rule of release.rules) {
    if (entitled(rule) && !firstEntitled.has(rule.family)) {
      firstEntitled.set(rule.family, rule.providerId);
    }
    const selection = asRecord(selections[rule.family]);
    if (typeof selection?.kind === "string") {
      selected.set(rule.family, selectedProviderId(rule.family, selection.kind));
    }
  }
  for (const [family, fallback] of firstEntitled) {
    if (!selected.has(family)) selected.set(family, fallback);
  }
  return selected;
};

/** Models the registry would publish for this account state, as `providerId/modelId`. */
export const discoverZcodeModels = Effect.fn("discoverZcodeModels")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const context = yield* resolveAccountContext(environment);
  if (context === undefined) return [];
  const selected = selectedByFamilyOf(context.release, context.selections, (rule) =>
    entitlementOf(context, rule),
  );
  const models: Array<{ slug: string; name: string }> = [];
  for (const rule of context.release.rules) {
    if (!entitlementOf(context, rule)) continue;
    if (CURRENT_SCOPED_MODES.has(rule.mode) && selected.get(rule.family) !== rule.providerId) {
      continue;
    }
    for (const modelId of rule.builtinModelIds) {
      models.push({ slug: `${rule.providerId}/${modelId}`, name: modelId });
    }
  }
  return models;
});

/**
 * Build the `provider/updateAccountConfig` overlay the app-server's provider
 * registry needs before any model resolves. `basedOnZCodeBuiltinRevision` is
 * `zcode-builtin:<release.revision>:<sha256(resolved builtin file path)>` — a
 * wrong value makes `provider/refreshRegistry` silently no-op.
 */
export const buildZcodeAccountOverlay = Effect.fn("buildZcodeAccountOverlay")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}): Effect.fn.Return<
  ZCodeSchema.ZCodeProviderUpdateAccountConfigParams | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const context = yield* resolveAccountContext(input.environment);
  if (context === undefined) return undefined;
  const sourceKey = NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(context.builtinPath))
    .digest("hex");
  const selectedByFamily = selectedByFamilyOf(context.release, context.selections, (rule) =>
    entitlementOf(context, rule),
  );

  const providers: Record<string, unknown> = {};
  const states: Record<
    string,
    {
      readonly availability: "available" | "unavailable";
      readonly entitled: boolean;
      readonly current?: boolean;
    }
  > = {};
  for (const rule of context.release.rules) {
    const entitled = entitlementOf(context, rule);
    providers[rule.providerId] = {
      access: { type: ZHIPU_ACCOUNT_ACCESS, entitled },
    };
    states[rule.providerId] = {
      availability: entitled ? "available" : "unavailable",
      entitled,
      ...(CURRENT_SCOPED_MODES.has(rule.mode)
        ? { current: selectedByFamily.get(rule.family) === rule.providerId }
        : {}),
    };
  }

  return {
    revision: input.revision,
    basedOnZCodeBuiltinRevision: `zcode-builtin:${context.release.revision}:${sourceKey}`,
    providers,
    states,
  };
});
