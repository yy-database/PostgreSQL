import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "server-process.mjs");

function waitForPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /PGPORT=(\d+)/.exec(output);
      if (match === null) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`server process exited before reporting a port (code=${code}, signal=${signal})`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/**
 * Starts a fresh product server in a child process with its own temporary
 * data directory. Resolves once the server reports the port it listens on.
 */
export async function startPgServer(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "postgres-example-"));
  const child = spawn(process.execPath, [serverScript], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PG_HOST: options.host ?? "127.0.0.1",
      PG_PORT: String(options.port ?? 0),
      PG_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });

  const port = await waitForPort(child);

  return {
    host: options.host ?? "127.0.0.1",
    port,
    dataDir,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once("exit", finish);
        if (child.connected) child.send({ type: "close" });
        else child.kill();
        const timer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 3_000);
        timer.unref();
      });
    },
  };
}
