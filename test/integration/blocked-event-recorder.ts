import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function blockedEventRecorder(pi: ExtensionAPI) {
  const outputFile = process.env.PI_TEST_BLOCKED_EVENT_FILE;
  if (!outputFile) return;

  pi.events.on("herdr:blocked", (data) => {
    appendFileSync(outputFile, `${JSON.stringify(data)}\n`);
  });
}
