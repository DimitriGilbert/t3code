import { watchWidgetExportFileName } from "@t3tools/client-runtime/state/watch-transfer";
import type { WatchWidgetExportDocument } from "@t3tools/contracts";

/** Downloads a widget export document as a `t3-widget-<slug>.json` file. */
export function downloadWatchWidgetJson(doc: WatchWidgetExportDocument): void {
  const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = watchWidgetExportFileName(doc);
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
