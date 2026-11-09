import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { resolveCoreContext, startCoreRun, killCoreTerminal, removeCoreTerminal, type CoreContext, type CoreHostRef } from "./herdr-core.ts";

const exec = promisify(execFile);

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

interface AppContext { env: NodeJS.ProcessEnv; space: string; parentTab: string; existingTabs: Set<string> }
export interface PreparedCoreLaunch { context: CoreContext; runtime: ReturnType<typeof resolveParentPiRuntime>; app: AppContext; title: string }

async function appCall(env: NodeJS.ProcessEnv, args: string[], timeout = 5000): Promise<any> {
  const { stdout } = await exec("herdr-app", args, { env, timeout, maxBuffer: 1024 * 1024, encoding: "utf8" });
  const result = JSON.parse(stdout);
  if (!result || typeof result !== "object" || Array.isArray(result) || result.error) throw new Error("Invalid herdr-app response");
  return result;
}

function localSpace(list: any, id: string): any {
  const matches = Array.isArray(list.spaces) ? list.spaces.filter((space: any) => space?.id === id) : [];
  if (matches.length !== 1 || matches[0].machine !== null || !Array.isArray(matches[0].tabs)) {
    throw new Error("Herdr app parent space is missing, ambiguous or nonlocal");
  }
  return matches[0];
}

function addressMatches(space: any, address: string): { tab: any; terminal: any }[] {
  return space.tabs.flatMap((tab: any) => {
    if (typeof tab?.id !== "string" || !Array.isArray(tab.terminals)) throw new Error("Invalid herdr-app tab listing");
    return tab.terminals.filter((terminal: any) => terminal?.terminal === address).map((terminal: any) => ({ tab, terminal }));
  });
}

export async function prepareCoreLaunch(name: string): Promise<PreparedCoreLaunch> {
  const title = Array.from(stripVTControlCharacters(name)
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim()).slice(0, 80).join("");
  if (!title) throw new Error("Core task title is empty after sanitization");
  const runtime = resolveParentPiRuntime();
  const context = await resolveCoreContext();
  const spaceId = context.parentTerminal.labels["herdr.space"];
  const parentTab = context.parentTerminal.labels["herdr.tab"];
  if (!spaceId || !parentTab) throw new Error("Core parent must be adopted by herdr-app with space/tab labels");
  const env = { ...process.env };
  const listing = await appCall(env, ["ls"]);
  const status = await appCall(env, ["status"]);
  if (typeof status.space !== "string" || typeof status.tab !== "string") throw new Error("Invalid herdr-app status");
  const space = localSpace(listing, spaceId);
  const matches = addressMatches(space, context.parent);
  if (matches.length !== 1 || matches[0].tab.id !== parentTab || typeof matches[0].terminal.pane !== "string") {
    throw new Error("Herdr app parent address does not match its labeled tab");
  }
  return { context, runtime, title, app: { env, space: spaceId, parentTab, existingTabs: new Set(space.tabs.map((tab: any) => tab.id)) } };
}

async function adoptCoreRun(prepared: PreparedCoreLaunch, host: CoreHostRef): Promise<void> {
  const { app } = prepared;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Core child adoption timed out");
    const listing = await appCall(app.env, ["ls"], Math.min(5000, remaining));
    const matches = addressMatches(localSpace(listing, app.space), host.address);
    if (matches.length > 1) throw new Error("Ambiguous Core child adoption");
    if (matches.length === 1) {
      const tab = matches[0].tab;
      if (app.existingTabs.has(tab.id) || tab.id === app.parentTab) throw new Error("Core child was not adopted into a new tab");
      const reply = await appCall(app.env, ["do", "tab.rename", JSON.stringify({ id: tab.id, name: prepared.title })]);
      if (reply.ok !== true) throw new Error("Herdr app tab rename was not acknowledged");
      const confirmed = addressMatches(localSpace(await appCall(app.env, ["ls"]), app.space), host.address);
      if (confirmed.length !== 1 || confirmed[0].tab.id !== tab.id || confirmed[0].tab.name !== prepared.title) throw new Error("Core child tab rename was not confirmed");
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
  const host = await startCoreRun(prepared.context, {
    name: `pi-${spec.runId}`.slice(0, 32), runId: spec.runId, scriptPath: spec.scriptPath,
    wrapperStartFile: spec.wrapperStartFile, cwd: spec.cwd,
    env: { PATH: prepared.app.env.PATH ?? "", PI_CODING_AGENT_DIR: spec.agentDir,
      ...(prepared.app.env.HERDR_APP_HOME === undefined ? {} : { HERDR_APP_HOME: prepared.app.env.HERDR_APP_HOME }) },
    labels: { "herdr.space": prepared.app.space },
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
