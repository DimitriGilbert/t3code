// @vitest-environment jsdom
import { WATCH_APP_PRELUDE } from "@t3tools/client-runtime/watch-app-bridge";
import { describe, expect, it } from "vite-plus/test";

/**
 * The prelude is the same string that runs in the sandboxed widget document;
 * evaluating it here exercises the real DOM path `T3.render` takes in a
 * widget frame. It only needs `window`/`document`, both real under jsdom.
 */
interface T3PreludeGlobal {
  readonly h: (
    type: string,
    props?: Record<string, unknown> | null,
    ...children: ReadonlyArray<unknown>
  ) => Node;
  readonly render: (component: unknown) => void;
}

function mountPrelude(): T3PreludeGlobal {
  document.body.innerHTML = '<div id="root"></div>';
  // The prelude is an IIFE meant to run as a <script> in the frame's global
  // scope; a Function body is the closest test-side equivalent.
  new Function(WATCH_APP_PRELUDE)();
  const T3 = (globalThis as { T3?: T3PreludeGlobal }).T3;
  if (T3 === undefined) throw new Error("The prelude did not define globalThis.T3");
  return T3;
}

describe("WATCH_APP_PRELUDE render", () => {
  it("mounts the element itself, not a stringified node", () => {
    const T3 = mountPrelude();
    T3.render(T3.h("div", { className: "widget-body" }, "hello"));

    const root = document.getElementById("root");
    expect(root?.firstElementChild?.tagName).toBe("DIV");
    expect(root?.textContent).toBe("hello");
    // The regression: replaceChildren([node]) stringified the array and the
    // widget body rendered the literal text "[object HTMLDivElement]".
    expect(root?.textContent).not.toContain("[object");
  });

  it("mounts a component function's return and replaces children on re-render", () => {
    const T3 = mountPrelude();
    T3.render(() => T3.h("p", null, "first"));
    T3.render(T3.h("p", null, "second"));

    const root = document.getElementById("root");
    expect(root?.childElementCount).toBe(1);
    expect(root?.textContent).toBe("second");
  });

  it("clears the root when the component renders null", () => {
    const T3 = mountPrelude();
    T3.render(T3.h("div", null, "content"));
    T3.render(null);
    expect(document.getElementById("root")?.childElementCount).toBe(0);
  });
});
