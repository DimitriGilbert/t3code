import type { WatchGalleryTemplate } from "@t3tools/contracts";

/**
 * Starter gallery: page skeletons instantiated into real rows on use, never
 * seeded rows — deleting an instantiated page and re-instantiating is safe.
 * Every binding is repointable; nothing is bound harder than `kind: threads`.
 */
export const WATCH_GALLERY_TEMPLATES: ReadonlyArray<WatchGalleryTemplate> = [
  {
    id: "starter-watch",
    name: "Watch",
    description: "Running work, what needs you, a quick task starter, and recent activity.",
    scope: "global",
    widgets: [
      {
        kind: "active-work",
        config: { source: { kind: "threads" } },
        placement: { x: 0, y: 0, w: 7, h: 4 },
      },
      {
        kind: "needs-attention",
        config: { source: { kind: "threads" } },
        placement: { x: 7, y: 0, w: 5, h: 4 },
      },
      {
        kind: "task-starter",
        config: { source: { kind: "threads" } },
        placement: { x: 0, y: 4, w: 4, h: 3 },
      },
      {
        kind: "recent-activity",
        config: { source: { kind: "threads" } },
        placement: { x: 4, y: 4, w: 8, h: 3 },
      },
      {
        kind: "connector-status",
        config: { source: { kind: "static" } },
        placement: { x: 0, y: 7, w: 12, h: 2 },
      },
    ],
  },
];
