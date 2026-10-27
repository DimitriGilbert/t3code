/**
 * Application text generation over `workspace/generateText` on a disposable
 * `zcode app-server --stdio`. Review-guide investigation needs read-only
 * tools the RPC cannot scope, so it stays unsupported.
 *
 * @module provider-zcode/server/zcodeTextGeneration
 */
import { TextGenerationError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ZCodeError from "@t3tools/effect-zcode-protocol/errors";
import * as ZCodeRpc from "@t3tools/effect-zcode-protocol/rpc";
import type * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { ZcodeSettings } from "../settings.ts";
import { buildZcodeAppServerSpawnInput, openZcodeAppServerClient } from "./zcodeAppServer.ts";
import {
  installZcodeRuntimeRequestHandlers,
  pushZcodeAccountOverlay,
} from "./zcodeSessionSetup.ts";
import { zcodeResolveModelSelection } from "./zcodeRows.ts";
import { ZCODE_DEFAULT_MODEL_SLUG } from "./status.ts";

const ZCODE_TEXT_GENERATION_TIMEOUT_MS = 60_000;
const ZCODE_TEXT_GENERATION_MAX_OUTPUT_TOKENS = 8_192;
const isTextGenerationError = Schema.is(TextGenerationError);

const reasoningEffortOption = (request: TextGenerationOperations.Request<Schema.Top>) => {
  const value = request.modelSelection.options?.find(
    (option) => option.id === "reasoningEffort",
  )?.value;
  return typeof value === "string" ? value : undefined;
};

export const makeZcodeTextGeneration = Effect.fn("makeZcodeTextGeneration")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZcodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly liveWorkspaceConfigs: ReadonlyMap<string, ZCodeSchema.WorkspaceConfigState>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runner: TextGenerationOperations.Runner = (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawnInput = buildZcodeAppServerSpawnInput(
          input.settings,
          request.cwd,
          input.environment,
        );
        const client = yield* openZcodeAppServerClient({
          command: spawnInput.command,
          args: spawnInput.args,
          cwd: spawnInput.cwd,
          env: spawnInput.env,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        // §2.6: unknown reverse requests must never hang the caller.
        yield* client.handleUnknownServerRequest((method: string) =>
          Effect.fail(ZCodeError.ZCodeAppServerRequestError.methodNotFound(method)),
        );
        yield* installZcodeRuntimeRequestHandlers(client, {
          environment: input.environment,
          fileSystem,
          path,
        });
        yield* pushZcodeAccountOverlay(client, {
          environment: input.environment,
          fileSystem,
          path,
          revision: `t3-${input.instanceId}-text-generation`,
          refreshReason: "t3-text-generation",
        });
        // `default` means the workspace's current model: the live catalog's
        // `model` config option names it once a session has seeded the topic.
        const configModel = input.liveWorkspaceConfigs
          .get(request.cwd)
          ?.configOptions?.find((option) => option.id === "model")?.currentValue;
        const slug =
          request.modelSelection.model === ZCODE_DEFAULT_MODEL_SLUG &&
          typeof configModel === "string" &&
          configModel.trim() !== ""
            ? configModel
            : request.modelSelection.model;
        const resolved = zcodeResolveModelSelection({
          model: slug,
          reasoningEffort: reasoningEffortOption(request),
          config: null,
        });
        if (resolved === undefined) {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail:
              "ZCode cannot resolve a model selection until a session has seeded the workspace catalog.",
          });
        }
        const result = yield* client.request(ZCodeRpc.LEGACY_METHODS.workspaceGenerateText, {
          workspace: { workspacePath: request.cwd, workspaceKey: request.cwd },
          selection: {
            providerId: resolved.providerId,
            modelId: resolved.modelId,
            options: { reasoningLevel: resolved.reasoningLevel },
          },
          prompt: request.prompt,
          querySource: `t3-${request.operation}`,
          maxOutputTokens: ZCODE_TEXT_GENERATION_MAX_OUTPUT_TOKENS,
        });
        return yield* TextGenerationOperations.decodeJsonReply(request, "ZCode", result.text);
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: `ZCode ${request.operation} failed.`,
                cause,
              }),
        ),
      ),
    );

  return TextGenerationOperations.fromRunner(
    "zcode",
    TextGenerationOperations.withoutInvestigation("ZCode", (request) =>
      runner(request).pipe(
        Effect.timeoutOption(ZCODE_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: request.operation,
                  detail: `ZCode ${request.operation} timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
  );
});
