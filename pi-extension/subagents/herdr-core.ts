import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const REQUIRED_METHODS = ["terminal.run", "terminal.get", "terminal.list", "terminal.read", "terminal.keys", "terminal.kill", "terminal.rm"];
const MAX_REPLY_BYTES = 1024 * 1024;

export class CoreRpcError extends Error {
  readonly method: string;
  readonly kind: string;
  requestSent = false;
  constructor(method: string, kind: string, message: string) {
    super(`Herdr Core ${method}: ${message}`);
    this.method = method;
    this.kind = kind;
  }
}

export interface CoreTerminal {
  address: string;
  state: "live" | "finished";
  pid: number | null;
  argv: string[];
  labels: Record<string, string>;
  parent: string | null;
  exit_code: number | null;
  signal: number | null;
  reason: string | null;
}

export interface CoreContext {
  endpoint: string;
  parent: string;
  coreId: string;
  parentTerminal: CoreTerminal;
}

function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

export async function coreRpcCall(endpoint: string, method: string, params: Record<string, unknown>, timeout = 5000, beforeWrite?: () => void): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = connect({ path: endpoint });
    socket.setEncoding("utf8");
    let buffer = "";
    let bytes = 0;
    let settled = false;
    let sent = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        if (error instanceof CoreRpcError) error.requestSent = sent;
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new CoreRpcError(method, "timeout", `request exceeded ${timeout}ms`)), timeout);
    socket.on("connect", () => {
      try { beforeWrite?.(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }
      sent = true;
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    socket.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REPLY_BYTES) return finish(new CoreRpcError(method, "invalid_reply", "reply exceeds 1 MiB"));
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = object(JSON.parse(buffer.slice(0, end)));
        if (!reply || reply.jsonrpc !== "2.0" || reply.id !== id) throw new Error("uncorrelated JSON-RPC reply");
        if (reply.error) {
          const kind = typeof reply.error.data?.kind === "string" ? reply.error.data.kind : "rpc_error";
          return finish(new CoreRpcError(method, kind, String(reply.error.message ?? "request failed").slice(0, 500)));
        }
        if (!("result" in reply)) throw new Error("reply has no result");
        finish(undefined, reply.result);
      } catch (error) {
        finish(new CoreRpcError(method, "invalid_reply", error instanceof Error ? error.message : String(error)));
      }
    });
    socket.on("error", error => finish(new CoreRpcError(method, "transport", error.message)));
    socket.on("close", () => { if (!settled) finish(new CoreRpcError(method, "transport", "connection closed before a complete reply")); });
  });
}

function terminal(value: unknown, method: string): CoreTerminal {
  const record = object(value);
  if (!record || typeof record.address !== "string" || !/^t[0-9a-z]+$/.test(record.address)
    || !["live", "finished"].includes(record.state) || !Array.isArray(record.argv) || !record.argv.every((arg: unknown) => typeof arg === "string")
    || !object(record.labels) || !Object.values(record.labels).every(value => typeof value === "string")
    || (record.pid != null && (!Number.isSafeInteger(record.pid) || record.pid <= 0))
    || (record.parent != null && typeof record.parent !== "string")
    || (record.exit_code != null && !Number.isSafeInteger(record.exit_code))
    || (record.signal != null && !Number.isSafeInteger(record.signal))) {
    throw new CoreRpcError(method, "invalid_reply", "invalid terminal record");
  }
  return { address: record.address, state: record.state, pid: record.pid ?? null, argv: [...record.argv], labels: { ...record.labels },
    parent: record.parent ?? null, exit_code: record.exit_code ?? null, signal: record.signal ?? null, reason: record.reason ?? null };
}

async function handshake(endpoint: string, timeout = 5000): Promise<string> {
  const result = object(await coreRpcCall(endpoint, "hello", { generation: 1 }, timeout));
  if (result?.generation !== 1 || typeof result.core?.id !== "string" || !Array.isArray(result.methods)
    || REQUIRED_METHODS.some(method => !result.methods.includes(method))) {
    throw new CoreRpcError("hello", "unsupported", "generation 1 and terminal run/get/list/read/keys/kill/rm are required");
  }
  return result.core.id;
}

export async function resolveCoreContext(env: NodeJS.ProcessEnv = process.env): Promise<CoreContext> {
  const endpoint = env.HC_TERMINAL_SOCKET;
  const parent = env.HC_TERMINAL_ID;
  if (!endpoint || !parent || !/^t[0-9a-z]+$/.test(parent)) {
    throw new CoreRpcError("hello", "unsupported", "run Pi in a local Core terminal (HC_TERMINAL_SOCKET and HC_TERMINAL_ID required)");
  }
  const coreId = await handshake(endpoint);
  const parentTerminal = terminal(await coreRpcCall(endpoint, "terminal.get", { terminal: parent }), "terminal.get");
  if (parentTerminal.address !== parent || parentTerminal.state !== "live") {
    throw new CoreRpcError("terminal.get", "unsupported", "the inherited parent terminal is not live");
  }
  return { endpoint, parent, coreId, parentTerminal };
}

export interface CoreHostRef {
  kind: "herdr-core";
  endpoint: string;
  parent: string;
  coreId: string;
  address: string;
  runId: string;
  scriptPath: string;
  wrapperStartFile: string;
  wrapperPid?: number;
  runtime?: { node: string; script: string; version: string };
}

export interface CoreRunSpec {
  name: string;
  runId: string;
  scriptPath: string;
  wrapperStartFile: string;
  cwd: string;
  env: Record<string, string>;
  labels: Record<string, string>;
}

export class CoreLaunchUnconfirmed extends Error {
  readonly context: Pick<CoreContext, "endpoint" | "parent" | "coreId">;
  readonly runId: string;
  readonly scriptPath: string;
  readonly wrapperStartFile: string;
  constructor(context: CoreContext, spec: CoreRunSpec, cause: unknown) {
    super(`Core launch ${spec.runId} is unconfirmed; reconcile its run label before retrying`, { cause });
    this.context = { endpoint: context.endpoint, parent: context.parent, coreId: context.coreId };
    this.runId = spec.runId;
    this.scriptPath = spec.scriptPath;
    this.wrapperStartFile = spec.wrapperStartFile;
  }
}

export const CORE_AMBIENT_CLEAR_KEYS = [
  "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_ENV", "CMUX_SOCKET_PATH", "CMUX_SURFACE_ID",
  "TMUX", "TMUX_PANE", "ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID", "WEZTERM_UNIX_SOCKET", "WEZTERM_PANE",
  "PI_SUBAGENT_ID", "PI_SUBAGENT_NAME", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE",
  "PI_SUBAGENT_COMPLETION_FILE", "PI_SUBAGENT_ACTIVITY_FILE", "PI_SUBAGENT_AUTO_EXIT", "PI_DENY_TOOLS",
  "PI_SUBAGENT_LAUNCH_POLICY", "PI_SUBAGENT_RESTORE_POLICY", "PI_SESSION_FILE", "PI_SESSION_ID",
] as const;

async function verifyCore(context: Pick<CoreContext, "endpoint" | "coreId">, timeout = 5000): Promise<void> {
  if (await handshake(context.endpoint, timeout) !== context.coreId) {
    throw new CoreRpcError("hello", "owner_mismatch", "the endpoint now belongs to a different Core");
  }
}

export async function getCoreLayoutDocument(context: Pick<CoreContext, "endpoint" | "coreId">, timeout = 5000): Promise<unknown> {
  const deadline = Date.now() + timeout;
  await verifyCore(context, timeout);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CoreRpcError("doc.get", "timeout", "layout request deadline exceeded");
  // No `on`: this is the captured Core's machine-owned local document, not a merged multi-machine view.
  return coreRpcCall(context.endpoint, "doc.get", { name: "herdr-app" }, remaining);
}

function hostRef(context: CoreContext, spec: CoreRunSpec, record: CoreTerminal): CoreHostRef {
  if (record.parent !== context.parent || record.labels["pi.subagent.run"] !== spec.runId
    || record.argv.length !== 2 || record.argv[0] !== "/bin/bash" || record.argv[1] !== spec.scriptPath) {
    throw new CoreRpcError("terminal.run", "owner_mismatch", "returned terminal does not match the owned wrapper");
  }
  return { kind: "herdr-core", endpoint: context.endpoint, parent: context.parent, coreId: context.coreId,
    address: record.address, runId: spec.runId, scriptPath: spec.scriptPath, wrapperStartFile: spec.wrapperStartFile,
    ...(record.pid === null ? {} : { wrapperPid: record.pid }) };
}

export async function startCoreRun(context: CoreContext, spec: CoreRunSpec): Promise<CoreHostRef> {
  if (!isAbsolute(spec.scriptPath) || !isAbsolute(spec.wrapperStartFile) || !isAbsolute(spec.cwd)
    || !/^[a-z0-9_-]{1,32}$/.test(spec.name) || !/^[A-Za-z0-9._-]{1,128}$/.test(spec.runId)
    || Object.keys(spec.env).some(key => key.startsWith("HC_"))) {
    throw new CoreRpcError("terminal.run", "invalid_params", "absolute paths, a valid name/run ID and Core-assigned HC_* identity are required");
  }
  await verifyCore(context);
  const env = { ...spec.env, ...Object.fromEntries(CORE_AMBIENT_CLEAR_KEYS.map(key => [key, ""])), PI_SUBAGENT_MUX: "herdr-core" };
  try {
    return hostRef(context, spec, terminal(await coreRpcCall(context.endpoint, "terminal.run", {
      argv: ["/bin/bash", spec.scriptPath], name: spec.name, cwd: spec.cwd, env,
      parent: context.parent, caller: context.parent, labels: { ...spec.labels, "pi.subagent.run": spec.runId },
      wait: false, no_notify: true, keep: true, rm: false, outlive_parent: false,
    }, 15000), "terminal.run"));
  } catch (error) {
    try {
      await verifyCore(context);
      const listed = object(await coreRpcCall(context.endpoint, "terminal.list", { all: true, labels: { "pi.subagent.run": spec.runId } }));
      if (!Array.isArray(listed?.terminals)) throw new Error("invalid reconciliation listing");
      const matches = listed.terminals.map((value: unknown) => terminal(value, "terminal.list"))
        .filter((record: CoreTerminal) => record.parent === context.parent && record.labels["pi.subagent.run"] === spec.runId
          && record.argv.length === 2 && record.argv[0] === "/bin/bash" && record.argv[1] === spec.scriptPath);
      if (matches.length === 1) {
        const recovered = hostRef(context, spec, matches[0]);
        // Reconciled PID may be a recovery shell; only the startup sidecar proves the original wrapper.
        delete recovered.wrapperPid;
        return recovered;
      }
      if (matches.length === 0 && error instanceof CoreRpcError && ["invalid_params", "name_taken", "not_found"].includes(error.kind)) throw error;
    } catch (reconciliationError) {
      if (reconciliationError === error) throw error;
    }
    throw new CoreLaunchUnconfirmed(context, spec, error);
  }
}

export async function reconcileCoreRun(launch: Pick<CoreLaunchUnconfirmed, "context" | "runId" | "scriptPath" | "wrapperStartFile">): Promise<CoreHostRef | undefined> {
  await verifyCore(launch.context);
  const listed = object(await coreRpcCall(launch.context.endpoint, "terminal.list", { all: true, labels: { "pi.subagent.run": launch.runId } }));
  if (!Array.isArray(listed?.terminals)) throw new CoreRpcError("terminal.list", "invalid_reply", "invalid reconciliation listing");
  const candidates = listed.terminals.map((value: unknown) => terminal(value, "terminal.list"))
    .filter((record: CoreTerminal) => record.labels["pi.subagent.run"] === launch.runId);
  if (candidates.some((record: CoreTerminal) => record.parent !== launch.context.parent || record.argv.length !== 2
    || record.argv[0] !== "/bin/bash" || record.argv[1] !== launch.scriptPath)) {
    throw new CoreRpcError("terminal.list", "owner_mismatch", "run label no longer matches the original parent/wrapper");
  }
  if (candidates.length > 1) throw new CoreRpcError("terminal.list", "ambiguous", "multiple terminals match the owned run; cleanup remains unconfirmed");
  if (candidates.length === 0) return undefined;
  return { kind: "herdr-core", ...launch.context, address: candidates[0].address, runId: launch.runId,
    scriptPath: launch.scriptPath, wrapperStartFile: launch.wrapperStartFile };
}

export async function getCoreTerminal(host: CoreHostRef, options: { beforeRead?: () => void } = {}): Promise<CoreTerminal> {
  await verifyCore(host);
  options.beforeRead?.();
  const record = terminal(await coreRpcCall(host.endpoint, "terminal.get", { terminal: host.address }, 5000, options.beforeRead), "terminal.get");
  if (record.address !== host.address || record.parent !== host.parent || record.labels["pi.subagent.run"] !== host.runId) {
    throw new CoreRpcError("terminal.get", "owner_mismatch", "terminal ownership no longer matches this run");
  }
  return record;
}

export async function readCoreScreen(host: CoreHostRef, lines = 50): Promise<{ text: string; complete: boolean; why?: string }> {
  await getCoreTerminal(host);
  const result = object(await coreRpcCall(host.endpoint, "terminal.read", { terminal: host.address, lines }));
  if (typeof result?.text !== "string" || typeof result.complete !== "boolean") {
    throw new CoreRpcError("terminal.read", "invalid_reply", "text and completeness are required");
  }
  return { text: result.text, complete: result.complete, ...(typeof result.why === "string" ? { why: result.why } : {}) };
}

export async function sendCoreEscape(host: CoreHostRef): Promise<void> {
  await getCoreTerminal(host);
  const result = object(await coreRpcCall(host.endpoint, "terminal.keys", { terminal: host.address, keys: ["esc"] }, 15000));
  if (!Number.isSafeInteger(result?.turn) || result!.turn < 0) {
    throw new CoreRpcError("terminal.keys", "invalid_reply", "key submission was not acknowledged");
  }
}

export async function killCoreTerminal(host: CoreHostRef, options: { skipFinished?: boolean; beforeSend?: () => void } = {}): Promise<CoreTerminal> {
  const current = await getCoreTerminal(host);
  if (options.skipFinished && current.state === "finished") return current;
  options.beforeSend?.();
  const reply = await coreRpcCall(host.endpoint, "terminal.kill", { terminal: host.address }, 15000, options.beforeSend);
  try {
    const result = terminal(reply, "terminal.kill");
    if (result.address !== host.address || result.parent !== host.parent || result.labels["pi.subagent.run"] !== host.runId) {
      throw new CoreRpcError("terminal.kill", "owner_mismatch", "exit of the owned terminal was not confirmed");
    }
    return result;
  } catch (error) {
    if (error instanceof CoreRpcError) error.requestSent = true;
    throw error;
  }
}

export async function removeCoreTerminal(host: CoreHostRef): Promise<void> {
  try {
    const record = await getCoreTerminal(host);
    if (record.state !== "finished") throw new CoreRpcError("terminal.rm", "live", "process exit must be observed before removal");
  } catch (error) {
    if (error instanceof CoreRpcError && error.method === "terminal.get" && error.kind === "not_found") return;
    throw error;
  }
  const result = object(await coreRpcCall(host.endpoint, "terminal.rm", { terminal: host.address }));
  if (result?.removed !== host.address) throw new CoreRpcError("terminal.rm", "invalid_reply", "removal of the owned record was not confirmed");
}
