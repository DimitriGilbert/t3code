import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ClankerWorkflowPath, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";

import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ClankerWorkflowService from "./ClankerWorkflowService.ts";

const projectId = ProjectId.make("project-1");
const workflowPath = (name: string) => ClankerWorkflowPath.make(`.clanker/workflows/${name}`);

let workspaceRoot: string | null = null;

const shellFor = (root: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Project",
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(ClankerWorkflowService.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () =>
        Effect.succeed(
          workspaceRoot === null ? Option.none() : Option.some(shellFor(workspaceRoot)),
        ),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const useWorkspace = Effect.fn("useWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-clanker-workflows-",
  });
  return workspaceRoot;
});

it.layer(layerTest)("ClankerWorkflowService", (it) => {
  describe("list", () => {
    it.effect("returns an empty list when the workflows directory does not exist", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        expect(yield* service.list({ projectId })).toEqual([]);
      }),
    );

    it.effect("returns an empty list when the project does not exist", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        workspaceRoot = null;

        expect(yield* service.list({ projectId })).toEqual([]);
      }),
    );
  });

  describe("create", () => {
    it.effect("writes a scaffold file that lists and parses cleanly", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        const document = yield* service.create({ projectId, name: "My Flow" });
        expect(document.path).toBe(".clanker/workflows/my-flow.yaml");
        expect(document.diagnostics).toEqual([]);
        expect(document.waves).toEqual([["plan"], ["implement"]]);
        expect(document.content).toContain("name: my-flow");

        const listed = yield* service.list({ projectId });
        expect(listed).toHaveLength(1);
        const summary = listed[0];
        expect(summary?.path).toBe(".clanker/workflows/my-flow.yaml");
        expect(summary?.name).toBe("my-flow");
        expect(summary?.version).toBe("1.0.0");
        expect(summary?.stepCount).toBe(2);
        expect(summary?.issueCount).toBe(0);
        expect(summary?.modifiedAt).not.toBeNull();
      }),
    );

    it.effect("suffixes the filename when the name is taken", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        const first = yield* service.create({ projectId, name: "dup" });
        const second = yield* service.create({ projectId, name: "dup" });

        expect(first.path).toBe(".clanker/workflows/dup.yaml");
        expect(second.path).toBe(".clanker/workflows/dup-2.yaml");
        expect(yield* service.list({ projectId })).toHaveLength(2);
      }),
    );

    it.effect("rejects names that cannot form a slug", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        const error = yield* service.create({ projectId, name: "!!!" }).pipe(Effect.flip);
        expect(error._tag).toBe("ClankerWorkflowInvalidNameError");
      }),
    );

    it.effect("fails when the project does not exist", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        workspaceRoot = null;

        const error = yield* service.create({ projectId, name: "ghost" }).pipe(Effect.flip);
        expect(error._tag).toBe("ClankerWorkflowWriteError");
      }),
    );
  });

  describe("get", () => {
    it.effect("returns the document with merged parse and wave diagnostics", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        const root = yield* useWorkspace();
        const fileSystem = yield* FileSystem.FileSystem;
        const content = [
          "name: cyclic",
          'version: "1.0.0"',
          "steps:",
          "  - name: a",
          "    depends_on: [b]",
          "    prompts:",
          "      - text: first",
          "  - name: b",
          "    depends_on: [a]",
          "    prompts:",
          "      - text: second",
        ].join("\n");
        yield* fileSystem.makeDirectory(`${root}/.clanker/workflows`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/.clanker/workflows/cyclic.yaml`, content);

        const document = yield* service.get({ projectId, path: workflowPath("cyclic.yaml") });
        expect(document.content).toBe(content);
        expect(document.waves).toEqual([]);
        expect(document.diagnostics.some((d) => d.message.includes("Circular dependency"))).toBe(
          true,
        );
      }),
    );

    it.effect("fails with NotFound when the file does not exist", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        const error = yield* service
          .get({ projectId, path: workflowPath("missing.yaml") })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ClankerWorkflowNotFoundError");
      }),
    );

    it.effect("rejects paths outside the workflows directory", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        for (const path of [
          "../x.yaml",
          "/etc/passwd",
          ".clanker/workflows/../secret.yaml",
          "x.yaml",
          ".clanker/other.yaml",
        ]) {
          const error = yield* service
            .get({ projectId, path: ClankerWorkflowPath.make(path) })
            .pipe(Effect.flip);
          expect(error._tag).toBe("ClankerWorkflowOutsideRootError");
        }
      }),
    );
  });

  describe("update", () => {
    it.effect("writes new content and reports diagnostics for it", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();
        const created = yield* service.create({ projectId, name: "edit" });

        const updated = yield* service.update({
          projectId,
          path: created.path,
          content: "not: [a workflow",
        });
        expect(updated.content).toBe("not: [a workflow");
        expect(updated.diagnostics.length).toBeGreaterThan(0);
        expect(yield* service.get({ projectId, path: created.path })).toMatchObject({
          content: "not: [a workflow",
        });
      }),
    );

    it.effect("refuses to create a new file", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        const error = yield* service
          .update({ projectId, path: workflowPath("new.yaml"), content: "name: x" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ClankerWorkflowNotFoundError");
      }),
    );
  });

  describe("delete", () => {
    it.effect("removes the file", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();
        const created = yield* service.create({ projectId, name: "gone" });

        yield* service.delete({ projectId, path: created.path });
        expect(yield* service.list({ projectId })).toEqual([]);
        const error = yield* service.get({ projectId, path: created.path }).pipe(Effect.flip);
        expect(error._tag).toBe("ClankerWorkflowNotFoundError");
      }),
    );
  });

  describe("subscribe", () => {
    it.effect("emits the snapshot then re-lists when a mutation lands", () =>
      Effect.gen(function* () {
        const service = yield* ClankerWorkflowService.ClankerWorkflowService;
        yield* useWorkspace();

        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(service.subscribe({ projectId }));
            const snapshot = yield* pull;
            expect(snapshot[0]).toEqual([]);

            yield* service.create({ projectId, name: "alpha" });
            const resnapshot = yield* pull;
            const latest = resnapshot.at(-1);
            expect(latest).toHaveLength(1);
            expect(latest?.[0]?.name).toBe("alpha");
          }),
        );
      }),
    );
  });
});
