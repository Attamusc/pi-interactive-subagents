import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import * as mux from "../pi-extension/subagents/cmux.ts";

it("publishes a guarded harness-plus-task label through Herdr's presentation-only RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-task-label-"));
  const saved = { ...process.env };
  const requests: any[] = [];
  let rejectMetadata = false;
  let rejectClose = false;
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      const request = JSON.parse(data);
      requests.push(request);
      socket.end(JSON.stringify(request.method === "pane.report_metadata" && rejectMetadata
        ? { id: request.id, error: { code: "invalid_metadata", message: "metadata rejected" } }
        : request.method === "pane.close" && rejectClose
          ? { id: request.id, error: { code: "close_failed", message: "close rejected" } }
          : { id: request.id, result: request.method === "pane.split"
            ? { type: "pane_split", pane: { pane_id: "w1:pCHILD" } } : { type: "ok" } }) + "\n");
    });
  });
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "herdr"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.PI_SUBAGENT_MUX = "herdr";
    process.env.HERDR_SOCKET_PATH = join(dir, "api.sock");
    server.listen(process.env.HERDR_SOCKET_PATH);
    await once(server, "listening");
    await (mux as any).setTaskLabel("w1:pTEST", "Claude", "UX check");
    assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [{
      method: "pane.report_metadata",
      params: {
        pane_id: "w1:pTEST", source: "pi:subagent-task", agent: "claude",
        title: "UX check", display_agent: "Claude | UX check",
      },
    }]);
    await (mux as any).setTaskLabel("w1:pTEST", "Pi", "Plan\n\u001b]52;c;SECRET\u0007\u202e task");
    assert.deepEqual(requests[1].params, {
      pane_id: "w1:pTEST", source: "pi:subagent-task", agent: "pi",
      title: "Plan task", display_agent: "Pi | Plan task",
    });
    await (mux as any).setTaskLabel("w1:pTEST", "Claude", "☃".repeat(100));
    assert.equal(Array.from(requests[2].params.title).length, 80);
    assert.equal(Array.from(requests[2].params.display_agent).length, 80);
    assert.ok(requests[2].params.display_agent.startsWith("Claude | ☃"));
    await assert.rejects((mux as any).setTaskLabel("w1:pTEST", "Pi", "\u001b[31m\u0000"), /empty after sanitization/);
    assert.equal(requests.length, 3);
    rejectMetadata = true;
    await assert.rejects((mux as any).setTaskLabel("w1:pTEST", "Pi", "Rejected"), /metadata rejected/);
    assert.ok(requests.every(({ method }) => method === "pane.report_metadata"));
    process.env.HERDR_PANE_ID = "w1:pCALLER";
    const before = requests.length;
    await assert.rejects(mux.createTaskSurface("Resume", "Pi"), /metadata rejected/);
    assert.deepEqual(requests.slice(before).map(({ method }) => method), [
      "pane.split", "pane.rename", "pane.report_metadata", "pane.close",
    ]);
    assert.equal(requests.at(-1).params.pane_id, "w1:pCHILD");
    rejectClose = true;
    await assert.rejects(mux.createTaskSurface("Review", "Claude"), /pane w1:pCHILD could not be closed/);
    rejectClose = false;
    rejectMetadata = false;
    assert.equal(await mux.createTaskSurface("Resume", "Pi"), "w1:pCHILD");
    assert.equal(requests.at(-1).params.display_agent, "Pi | Resume");
  } finally {
    process.env = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
