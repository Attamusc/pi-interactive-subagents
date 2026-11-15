import { stripVTControlCharacters } from "node:util";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { resolveCoreContext, getCoreLayoutDocument, startCoreRun, killCoreTerminal, removeCoreTerminal, type CoreContext, type CoreHostRef } from "./herdr-core.ts";

export function resolveParentPiRuntime() {
  const unsupported = () => new Error("Herdr Core requires an identifiable Node-hosted Pi CLI package entrypoint");
  if (process.release.name !== "node" || !process.argv[1]) throw unsupported();
  let script: string;
  try { script = realpathSync(process.argv[1]); } catch { throw unsupported(); }
  if (![".js", ".mjs", ".cjs"].includes(extname(script))) throw unsupported();
  for (let dir = dirname(script); ; dir = dirname(dir)) {
    let manifest: any;
    try { manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch {}
    if (manifest?.name === "@earendil-works/pi-coding-agent") {
      const bin = manifest.bin?.pi;
      try {
        if (typeof manifest.version === "string" && typeof bin === "string" && realpathSync(resolve(dir, bin)) === script) {
          return { node: process.execPath, script, version: manifest.version };
        }
      } catch {}
      throw unsupported();
    }
    if (dirname(dir) === dir) break;
  }
  throw unsupported();
}

interface Placement { space: string; tab: string; pane: string }
export interface PreparedCoreLaunch {
  context: CoreContext; runtime: ReturnType<typeof resolveParentPiRuntime>; env: NodeJS.ProcessEnv;
  placement?: Placement; title: string;
}

function layoutPlacements(document: unknown, address: string): Placement[] {
  const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
  const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const invalid = () => { throw new Error("Unsupported or malformed Core layout document"); };
  if (!object(document) || !Number.isInteger(document.version) || document.version < 0 || document.version >= 2 ** 64
    || !object(document.value) || !Array.isArray(document.value.spaces)) return invalid();
  const matches: Placement[] = [];
  const spaces = new Set<string>();
  const tabs = new Set<string>();
  const panes = new Set<string>();
  for (const space of document.value.spaces) {
    if (!object(space) || !id(space.id) || spaces.has(space.id) || !Array.isArray(space.tabs)) return invalid();
    spaces.add(space.id);
    for (const tab of space.tabs) {
      if (!object(tab) || !id(tab.id) || tabs.has(tab.id)) return invalid();
      tabs.add(tab.id);
      const visit = (node: any): void => {
        if (!object(node) || (node.id !== undefined && typeof node.id !== "string")) return invalid();
        if (id(node.id)) {
          if (panes.has(node.id)) return invalid();
          panes.add(node.id);
        }
        if (node.type === "block") {
          const content = node.content;
          if (!object(content)) return invalid();
          // Only the tagged block's content is authoritative; metadata and mod props are not layout nodes.
          const kinds = ["terminal", "mod", "tab", "context", "agent"].filter(key => key in content);
          if (kinds.length !== 1 || !id(content[kinds[0]])) return invalid();
          if (kinds[0] === "terminal") {
            if (!id(node.id)) return invalid();
            if (content.terminal === address) matches.push({ space: space.id, tab: tab.id, pane: node.id });
          }
        } else if (["row", "column", "stack"].includes(node.type)) {
          if (!Array.isArray(node.children)) return invalid();
          for (const child of node.children) visit(child);
        } else return invalid();
      };
      visit(tab.root);
    }
  }
  return matches;
}

export async function prepareCoreLaunch(name: string, interactive: boolean): Promise<PreparedCoreLaunch> {
  const title = Array.from(stripVTControlCharacters(name)
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim()).slice(0, 80).join("");
  if (!title) throw new Error("Core task title is empty after sanitization");
  const runtime = resolveParentPiRuntime();
  const context = await resolveCoreContext();
  const env = { ...process.env };
  if (!interactive) return { context, runtime, title, env };
  const matches = layoutPlacements(await getCoreLayoutDocument(context), context.parent);
  if (matches.length !== 1) throw new Error("Core parent placement is missing or ambiguous in the layout document");
  const placement = matches[0];
  for (const [label, expected] of [["herdr.space", placement.space], ["herdr.tab", placement.tab]]) {
    const hint = context.parentTerminal.labels[label];
    if (hint !== undefined && hint !== expected) throw new Error(`Core parent ${label} label does not match its layout placement`);
  }
  return { context, runtime, title, env, placement };
}

async function adoptCoreRun(prepared: PreparedCoreLaunch, host: CoreHostRef): Promise<void> {
  if (!prepared.placement) return;
  const { space, tab, pane } = prepared.placement;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Core child adoption timed out");
    const document = await getCoreLayoutDocument(host, Math.min(5000, remaining));
    const matches = layoutPlacements(document, host.address);
    if (matches.length > 1) throw new Error("Ambiguous Core child adoption");
    if (matches.length === 1) {
      const child = matches[0];
      if (child.space !== space || child.tab !== tab || child.pane === pane) {
        throw new Error("Core child was not adopted into a distinct pane in the parent tab");
      }
      return;
    }
    if (Date.now() >= deadline) throw new Error("Core child adoption timed out");
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
}

export class CoreSetupCleanupFailure extends Error {
  readonly coreHost: CoreHostRef;
  readonly stage: "kill" | "remove";
  readonly killAccepted: boolean;
  constructor(coreHost: CoreHostRef, stage: "kill" | "remove", killAccepted: boolean, cause: unknown) {
    super(`Core visibility setup failed for ${coreHost.address}; owned ${stage} cleanup unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.coreHost = coreHost;
    this.stage = stage;
    this.killAccepted = killAccepted;
  }
}

export async function launchPreparedCoreRun(prepared: PreparedCoreLaunch, spec: {
  runId: string; scriptPath: string; wrapperStartFile: string; command: string; cwd: string; agentDir: string;
}): Promise<CoreHostRef> {
  mkdirSync(dirname(spec.scriptPath), { recursive: true });
  writeFileSync(spec.scriptPath, `#!/bin/bash\n${spec.command}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(spec.scriptPath, 0o600);
  const titlePrefix = prepared.title.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "pi-subagent";
  const name = `${titlePrefix.slice(0, 32 - spec.runId.length - 1)}-${spec.runId}`;
  const host = await startCoreRun(prepared.context, {
    name, runId: spec.runId, scriptPath: spec.scriptPath,
    wrapperStartFile: spec.wrapperStartFile, cwd: spec.cwd,
    env: { PATH: prepared.env.PATH ?? "", PI_CODING_AGENT_DIR: spec.agentDir },
    labels: prepared.placement ? { "herdr.space": prepared.placement.space, "herdr.tab": prepared.placement.tab } : {},
  });
  host.runtime = { ...prepared.runtime };
  try { await adoptCoreRun(prepared, host); }
  catch (error) {
    let killAccepted = false;
    try {
      await killCoreTerminal(host);
      killAccepted = true;
      await removeCoreTerminal(host);
    } catch (failure) {
      throw new CoreSetupCleanupFailure(host, killAccepted ? "remove" : "kill", killAccepted, failure);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Core visibility setup failed for ${host.address}: ${reason}`, { cause: error });
  }
  return host;
}
