// Process confinement for the external agent (TB-058). goose, and every process it starts (its extension relay), runs
// inside an OS sandbox whose only routes out are the episode's own adapter socket and the model proxy's port:
//   - macOS: sandbox-exec (Seatbelt) with a generated deny-by-default network profile;
//   - Linux: Landlock (src/external/bin/landlock-exec.py), unprivileged, so it also works in the service container.
// Network: no TCP except the listed loopback ports, no other Unix socket, no bind. Files: writes only inside the episode
// folder; no reads of the harness's files (repository, tool databases, session files, keys), the user's home or other
// episodes. Configuration: configs/external-agents.yaml `sandbox`. If the platform cannot confine, runGooseAgent refuses
// to start unless the caller explicitly opts out (tests that only exercise the adapter).
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

export interface ConfineSpec {
  /** The episode folder: the only place the confined processes may write. */
  sandbox: string;
  /** Loopback TCP ports the confined processes may connect to (the model proxy). */
  tcpPorts: number[];
  /** Unix socket paths they may connect to (the episode's adapter or gateway socket). */
  unixSockets: string[];
  /** Extra paths they may read and execute (the goose binary's folder, the relay). */
  readPaths: string[];
  /** Linux system paths readable by every confined process (configs/external-agents.yaml sandbox.linux_system_paths). */
  systemPaths: string[];
}

export type Confinement = { kind: "sandbox-exec" | "landlock"; command: string; args: string[] } | { kind: "none"; reason: string };

const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const quote = (p: string) => { if (/["\\\n]/.test(p)) throw new Error(`path not allowed in a sandbox profile: ${p}`); return `"${p}"`; };

/** The Seatbelt profile: later rules win, so each deny is followed by its narrow allows. */
export function darwinProfile(spec: ConfineSpec, sandboxRoot: string): string {
  const sb = real(spec.sandbox);
  const denyRead = [os.homedir(), root, "/Volumes", real(sandboxRoot), "/private/tmp", real(os.tmpdir()), "/private/var/folders"].map(real);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...spec.tcpPorts.map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
    ...spec.unixSockets.map((s) => `(allow network-outbound (remote unix-socket (path-literal ${quote(real(path.dirname(s)) + "/" + path.basename(s))})))`),
    `(deny file-read-data ${denyRead.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
    `(allow file-read-data ${[...spec.readPaths.map(real), sb].map((p) => `(subpath ${quote(p)})`).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(sb)}) (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))`,
  ].join("\n");
}

/** Wraps a command so it runs confined. Returns kind "none" (with the reason) when this platform cannot confine. */
export function confine(command: string, args: string[], spec: ConfineSpec, sandboxRoot: string): Confinement {
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) return { kind: "none", reason: "sandbox-exec is not available" };
    return { kind: "sandbox-exec", command: "/usr/bin/sandbox-exec", args: ["-p", darwinProfile(spec, sandboxRoot), command, ...args] };
  }
  if (process.platform === "linux") {
    const python = [path.join(root, ".venv-tools/bin/python"), "/usr/bin/python3"].find(existsSync);
    if (!python) return { kind: "none", reason: "no Python to run the Landlock launcher" };
    const ro = [...spec.systemPaths, ...spec.readPaths];
    const rw = [spec.sandbox, "/dev/null"];
    return { kind: "landlock", command: python, args: ["-I", path.join(root, "src/external/bin/landlock-exec.py"),
      ...ro.flatMap((p) => ["--ro", p]), ...rw.flatMap((p) => ["--rw", p]), ...spec.tcpPorts.flatMap((p) => ["--tcp-connect", String(p)]), "--", command, ...args] };
  }
  return { kind: "none", reason: `no confinement for platform ${process.platform}` };
}
