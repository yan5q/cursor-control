import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const SERVER_PID_PATH = path.join(homedir(), ".cursor-browser", "server.pid");

export function isCursorBrowserCommand(command: string): boolean {
  return /[/\\]server[/\\]dist[/\\]index\.js\b/.test(command);
}

export async function releaseStaleListener(port: number, pidPath = SERVER_PID_PATH): Promise<boolean> {
  const pids = new Set<number>();
  const recorded = await readPid(pidPath);
  if (recorded != null) pids.add(recorded);
  for (const pid of await listeners(port)) pids.add(pid);

  let released = false;
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const command = await processCommand(pid);
    if (!command || !isCursorBrowserCommand(command)) continue;
    if (stopProcess(pid)) released = true;
  }
  if (!released) return false;

  const started = Date.now();
  while (Date.now() - started < 1_000) {
    const still = await listeners(port);
    if (still.every((pid) => pid === process.pid)) return true;
    await delay(50);
  }
  return true;
}

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(pidPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function listeners(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(lsofBinary(), ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      );
    });
  });
}

function processCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}

function stopProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function lsofBinary(): string {
  return process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
