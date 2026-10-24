/**
 * Project-local storage for Clanker workflow files under
 * `<workspaceRoot>/.clanker/workflows/`; the wire id is the normalized
 * project-relative POSIX path. Mutations publish a dirty signal that
 * `subscribe` turns into a fresh list emission.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { buildClankerWaves } from "@t3tools/clanker/dag";
import { parseClankerWorkflow } from "@t3tools/clanker/parse";
import {
  ClankerWorkflowInvalidNameError,
  ClankerWorkflowNotFoundError,
  ClankerWorkflowOutsideRootError,
  ClankerWorkflowPath,
  ClankerWorkflowReadError,
  ClankerWorkflowWriteError,
  type ClankerWorkflowCreateInput,
  type ClankerWorkflowDeleteInput,
  type ClankerWorkflowDocument,
  type ClankerWorkflowError,
  type ClankerWorkflowGetInput,
  type ClankerWorkflowListInput,
  type ClankerWorkflowSummary,
  type ClankerWorkflowUpdateInput,
  type ProjectId,
} from "@t3tools/contracts";

import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/** Project-relative POSIX prefix every workflow path must resolve under. */
const WORKFLOWS_DIR_RELATIVE = ".clanker/workflows";
const WORKFLOW_FILE_PATTERN = /\.(yaml|yml|json)$/i;
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class ClankerWorkflowService extends Context.Service<
  ClankerWorkflowService,
  {
    readonly list: (
      input: ClankerWorkflowListInput,
    ) => Effect.Effect<ReadonlyArray<ClankerWorkflowSummary>, ClankerWorkflowError>;
    readonly get: (
      input: ClankerWorkflowGetInput,
    ) => Effect.Effect<ClankerWorkflowDocument, ClankerWorkflowError>;
    readonly create: (
      input: ClankerWorkflowCreateInput,
    ) => Effect.Effect<ClankerWorkflowDocument, ClankerWorkflowError>;
    readonly update: (
      input: ClankerWorkflowUpdateInput,
    ) => Effect.Effect<ClankerWorkflowDocument, ClankerWorkflowError>;
    readonly delete: (
      input: ClankerWorkflowDeleteInput,
    ) => Effect.Effect<void, ClankerWorkflowError>;
    readonly subscribe: (
      input: ClankerWorkflowListInput,
    ) => Stream.Stream<ReadonlyArray<ClankerWorkflowSummary>, ClankerWorkflowError>;
  }
>()("t3/clanker/ClankerWorkflowService") {}

const scaffoldContent = (
  slug: string,
) => `# Clanker workflow: edit the name, description, and steps below.
name: ${slug}
version: "1.0.0"
description: Describe what this workflow does.

# defaults:
#   timeout: 600
#   retry: 0

steps:
  - name: plan
    prompts:
      - text: Summarize the task and propose a plan.
  - name: implement
    depends_on: [plan]
    prompts:
      - text: Implement the plan produced by the previous step.
`;

export const layer = Layer.effect(
  ClankerWorkflowService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    // Sliding(1) coalesces the dirty-signal: every notification re-lists the
    // directory anyway, so subscribers only ever need the latest one.
    const changesPubSub = yield* PubSub.sliding<ProjectId>(1);
    const notifyChanged = (projectId: ProjectId) =>
      PubSub.publish(changesPubSub, projectId).pipe(Effect.asVoid);

    /**
     * `null` means the project is gone. Reads treat that like a missing
     * workflows directory; writes fail, since there is nowhere to write.
     */
    const workspaceRootFor = Effect.fn("ClankerWorkflowService.workspaceRootFor")(function* (
      projectId: ProjectId,
    ) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(Effect.mapError((cause) => new ClankerWorkflowReadError({ path: projectId, cause })));
      return Option.isSome(shell) ? shell.value.workspaceRoot : null;
    });

    const workflowsDirFor = (workspaceRoot: string) =>
      path.join(workspaceRoot, ".clanker", "workflows");

    /**
     * Lexical confinement through WorkspacePaths plus a second check that the
     * normalized path stays inside the workflows directory, so `..` escapes,
     * absolute paths, and sibling files all fail the same way.
     */
    const resolveWorkflowPath = Effect.fn("ClankerWorkflowService.resolveWorkflowPath")(function* (
      workspaceRoot: string,
      inputPath: string,
    ) {
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: inputPath })
        .pipe(Effect.mapError(() => new ClankerWorkflowOutsideRootError({ path: inputPath })));
      if (!resolved.relativePath.startsWith(`${WORKFLOWS_DIR_RELATIVE}/`)) {
        return yield* new ClankerWorkflowOutsideRootError({ path: inputPath });
      }
      return resolved;
    });

    const isMissingEntry = (cause: { readonly reason: { readonly _tag: string } }) =>
      cause.reason._tag === "NotFound";

    const readWorkflowFile = Effect.fn("ClankerWorkflowService.readWorkflowFile")(function* (
      absolutePath: string,
      relativePath: string,
    ) {
      const stat = yield* fileSystem.stat(absolutePath).pipe(
        Effect.catchIf(isMissingEntry, () => Effect.succeed(null)),
        Effect.mapError((cause) => new ClankerWorkflowReadError({ path: relativePath, cause })),
      );
      if (stat === null || stat.type !== "File") {
        return yield* new ClankerWorkflowNotFoundError({ path: relativePath });
      }
      return yield* fileSystem
        .readFileString(absolutePath)
        .pipe(
          Effect.mapError((cause) => new ClankerWorkflowReadError({ path: relativePath, cause })),
        );
    });

    const toDocument = (relativePath: string, content: string): ClankerWorkflowDocument => {
      const parsed = parseClankerWorkflow(content);
      const wavesResult =
        parsed.workflow === undefined
          ? { waves: [] as ReadonlyArray<ReadonlyArray<string>>, diagnostics: [] }
          : buildClankerWaves(parsed.workflow.steps);
      return {
        path: ClankerWorkflowPath.make(relativePath),
        content,
        diagnostics: [...parsed.diagnostics, ...wavesResult.diagnostics],
        waves: wavesResult.waves.map((wave) => [...wave]),
      };
    };

    const toSummary = (input: {
      readonly fileName: string;
      readonly content: string;
      readonly modifiedAt: string | null;
    }): ClankerWorkflowSummary => {
      const parsed = parseClankerWorkflow(input.content);
      const waveDiagnostics =
        parsed.workflow === undefined ? [] : buildClankerWaves(parsed.workflow.steps).diagnostics;
      const diagnostics = [...parsed.diagnostics, ...waveDiagnostics];
      const stem = input.fileName.replace(WORKFLOW_FILE_PATTERN, "");
      return {
        path: ClankerWorkflowPath.make(`${WORKFLOWS_DIR_RELATIVE}/${input.fileName}`),
        name: parsed.workflow?.name.trim() || stem || input.fileName,
        ...(parsed.workflow?.version === undefined ? {} : { version: parsed.workflow.version }),
        ...(parsed.workflow?.description === undefined
          ? {}
          : { description: parsed.workflow.description }),
        stepCount: parsed.workflow?.steps.length ?? 0,
        modifiedAt: input.modifiedAt,
        issueCount: diagnostics.filter((diagnostic) => diagnostic.severity !== "warning").length,
      };
    };

    const listForRoot = Effect.fn("ClankerWorkflowService.listForRoot")(function* (
      workspaceRoot: string,
    ) {
      const workflowsDir = workflowsDirFor(workspaceRoot);
      const entries = yield* fileSystem.readDirectory(workflowsDir).pipe(
        Effect.catchIf(isMissingEntry, () => Effect.succeed([] as ReadonlyArray<string>)),
        Effect.mapError(
          (cause) => new ClankerWorkflowReadError({ path: WORKFLOWS_DIR_RELATIVE, cause }),
        ),
      );
      const fileNames = entries.filter((entry) => WORKFLOW_FILE_PATTERN.test(entry)).sort();
      return yield* Effect.forEach(
        fileNames,
        (fileName) =>
          Effect.gen(function* () {
            const absolutePath = path.join(workflowsDir, fileName);
            const stat = yield* fileSystem
              .stat(absolutePath)
              .pipe(Effect.catchIf(isMissingEntry, () => Effect.succeed(null)));
            if (stat === null || stat.type !== "File") return null;
            const content = yield* fileSystem.readFileString(absolutePath);
            return toSummary({
              fileName,
              content,
              modifiedAt: Option.match(stat.mtime, {
                onNone: () => null,
                onSome: (mtime) => mtime.toISOString(),
              }),
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ClankerWorkflowReadError({
                  path: `${WORKFLOWS_DIR_RELATIVE}/${fileName}`,
                  cause,
                }),
            ),
          ),
        { concurrency: 8 },
      ).pipe(
        Effect.map((summaries) =>
          summaries
            .filter((summary) => summary !== null)
            .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "")),
        ),
      );
    });

    const list: ClankerWorkflowService["Service"]["list"] = Effect.fn(
      "ClankerWorkflowService.list",
    )(function* (input) {
      const workspaceRoot = yield* workspaceRootFor(input.projectId);
      if (workspaceRoot === null) return [];
      return yield* listForRoot(workspaceRoot);
    });

    const subscribe: ClankerWorkflowService["Service"]["subscribe"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const resnapshot = list(input);
          return Stream.concat(
            Stream.fromEffect(resnapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((projectId) => projectId === input.projectId),
              Stream.mapEffect(() => list(input)),
            ),
          );
        }),
      );

    const get: ClankerWorkflowService["Service"]["get"] = Effect.fn("ClankerWorkflowService.get")(
      function* (input) {
        const workspaceRoot = yield* workspaceRootFor(input.projectId);
        if (workspaceRoot === null) {
          return yield* new ClankerWorkflowNotFoundError({ path: input.path });
        }
        const resolved = yield* resolveWorkflowPath(workspaceRoot, input.path);
        const content = yield* readWorkflowFile(resolved.absolutePath, resolved.relativePath);
        return toDocument(resolved.relativePath, content);
      },
    );

    const create: ClankerWorkflowService["Service"]["create"] = Effect.fn(
      "ClankerWorkflowService.create",
    )(function* (input) {
      const slug = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!WORKFLOW_NAME_PATTERN.test(slug)) {
        return yield* new ClankerWorkflowInvalidNameError({
          name: input.name,
          detail:
            "The name must contain at least one lowercase letter or digit; it is slugified to lowercase letters, digits, and dashes.",
        });
      }
      const firstFileName = `${slug}.yaml`;
      const workspaceRoot = yield* workspaceRootFor(input.projectId);
      if (workspaceRoot === null) {
        return yield* new ClankerWorkflowWriteError({
          path: `${WORKFLOWS_DIR_RELATIVE}/${firstFileName}`,
          cause: `Project ${input.projectId} was not found.`,
        });
      }
      const workflowsDir = workflowsDirFor(workspaceRoot);
      yield* fileSystem
        .makeDirectory(workflowsDir, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new ClankerWorkflowWriteError({ path: WORKFLOWS_DIR_RELATIVE, cause }),
          ),
        );
      // `update` refuses missing files, so suffixing is what keeps two
      // same-named creates from silently overwriting each other.
      const fileNameTaken = (fileName: string) =>
        fileSystem.exists(path.join(workflowsDir, fileName)).pipe(
          Effect.mapError(
            (cause) =>
              new ClankerWorkflowReadError({
                path: `${WORKFLOWS_DIR_RELATIVE}/${fileName}`,
                cause,
              }),
          ),
        );
      let fileName = firstFileName;
      for (let suffix = 2; yield* fileNameTaken(fileName); suffix++) {
        fileName = `${slug}-${suffix}.yaml`;
      }
      const relativePath = `${WORKFLOWS_DIR_RELATIVE}/${fileName}`;
      const absolutePath = path.join(workflowsDir, fileName);
      const content = input.content ?? scaffoldContent(slug);
      yield* fileSystem
        .writeFileString(absolutePath, content)
        .pipe(
          Effect.mapError((cause) => new ClankerWorkflowWriteError({ path: relativePath, cause })),
        );
      yield* notifyChanged(input.projectId);
      return toDocument(relativePath, content);
    });

    const update: ClankerWorkflowService["Service"]["update"] = Effect.fn(
      "ClankerWorkflowService.update",
    )(function* (input) {
      const workspaceRoot = yield* workspaceRootFor(input.projectId);
      if (workspaceRoot === null) {
        return yield* new ClankerWorkflowNotFoundError({ path: input.path });
      }
      const resolved = yield* resolveWorkflowPath(workspaceRoot, input.path);
      const stat = yield* fileSystem.stat(resolved.absolutePath).pipe(
        Effect.catchIf(isMissingEntry, () => Effect.succeed(null)),
        Effect.mapError(
          (cause) => new ClankerWorkflowReadError({ path: resolved.relativePath, cause }),
        ),
      );
      // New files are created through `create`; `update` only rewrites
      // existing ones so a stray path cannot land files outside the listing.
      if (stat === null || stat.type !== "File") {
        return yield* new ClankerWorkflowNotFoundError({ path: resolved.relativePath });
      }
      yield* fileSystem
        .writeFileString(resolved.absolutePath, input.content)
        .pipe(
          Effect.mapError(
            (cause) => new ClankerWorkflowWriteError({ path: resolved.relativePath, cause }),
          ),
        );
      yield* notifyChanged(input.projectId);
      return toDocument(resolved.relativePath, input.content);
    });

    const deleteWorkflow: ClankerWorkflowService["Service"]["delete"] = Effect.fn(
      "ClankerWorkflowService.delete",
    )(function* (input) {
      const workspaceRoot = yield* workspaceRootFor(input.projectId);
      if (workspaceRoot === null) {
        return yield* new ClankerWorkflowNotFoundError({ path: input.path });
      }
      const resolved = yield* resolveWorkflowPath(workspaceRoot, input.path);
      const stat = yield* fileSystem.stat(resolved.absolutePath).pipe(
        Effect.catchIf(isMissingEntry, () => Effect.succeed(null)),
        Effect.mapError(
          (cause) => new ClankerWorkflowReadError({ path: resolved.relativePath, cause }),
        ),
      );
      if (stat === null || stat.type !== "File") {
        return yield* new ClankerWorkflowNotFoundError({ path: resolved.relativePath });
      }
      yield* fileSystem
        .remove(resolved.absolutePath)
        .pipe(
          Effect.mapError(
            (cause) => new ClankerWorkflowWriteError({ path: resolved.relativePath, cause }),
          ),
        );
      yield* notifyChanged(input.projectId);
    });

    return ClankerWorkflowService.of({
      list,
      get,
      create,
      update,
      delete: deleteWorkflow,
      subscribe,
    });
  }),
);
