/**
 * Spawns a module into an isolated child process.
 *
 * This is the out-of-process half of the security boundary. Core keeps the token, the
 * database and the discord.js client; the child gets a bundle, an IPC channel and nothing
 * else. See bootstrap.mjs for the in-process hardening that runs before module code.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BOOTSTRAP_PATH = fileURLToPath(new URL('../bootstrap.mjs', import.meta.url));

/**
 * Anything crossing the sandbox boundary is structured-cloneable data — never a function,
 * a class instance or a handle. That restriction is deliberate: it means core can never
 * accidentally hand a module a live object with methods on it.
 */
export type SandboxJson =
  | string
  | number
  | boolean
  | null
  | SandboxJson[]
  | { [key: string]: SandboxJson };

/** Every message is an object envelope, so a bare value can never be mistaken for one. */
export type SandboxMessage = { [key: string]: SandboxJson };

export interface SpawnSandboxOptions {
  /** Absolute path to the esbuild-produced single-file bundle. */
  bundlePath: string;
  /** Heap cap for the module process. */
  maxOldSpaceMb?: number;
}

export interface SandboxExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SandboxHandle {
  readonly pid: number | undefined;
  /** Resolves with the next message the module sends over the brokered channel. */
  nextMessage<T = unknown>(timeoutMs?: number): Promise<T>;
  /** Subscribes to every message the module sends. */
  onMessage(listener: (message: unknown) => void): void;
  /** Sends a message into the module. No-ops once the child is gone. */
  send(message: SandboxMessage): void;
  kill(): void;
  readonly exited: Promise<SandboxExit>;
}

/**
 * Node needs a few non-secret environment variables to start at all on Windows. This is an
 * explicit allowlist rather than a denylist: anything not named here — the bot token above
 * all — simply does not exist inside the sandbox.
 */
function sandboxEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const env: NodeJS.ProcessEnv = {};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

export function spawnSandbox(options: SpawnSandboxOptions): SandboxHandle {
  const { bundlePath, maxOldSpaceMb = 128 } = options;
  const bundleDir = dirname(bundlePath);

  const child = spawn(
    process.execPath,
    [
      // Layer 1: the kernel of the boundary. Denies child processes, worker threads, native
      // addons and every filesystem write; grants read only where the code actually lives.
      '--permission',
      `--allow-fs-read=${bundleDir}`,
      `--allow-fs-read=${BOOTSTRAP_PATH}`,
      // Removes eval / new Function, closing a broad class of dynamic-code escapes.
      '--disallow-code-generation-from-strings',
      `--max-old-space-size=${maxOldSpaceMb}`,
      // Layer 2: runs to completion before the bundle is evaluated.
      '--import',
      pathToFileURL(BOOTSTRAP_PATH).href,
      bundlePath,
    ],
    {
      env: sandboxEnv(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );

  const queued: unknown[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  let waiting: ((message: unknown) => void) | null = null;
  let stderr = '';
  let exit: SandboxExit | null = null;

  child.on('message', (message) => {
    for (const listener of listeners) listener(message);

    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(message);
    } else {
      queued.push(message);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<SandboxExit>((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });

  return {
    get pid() {
      return child.pid;
    },
    exited,
    nextMessage<T>(timeoutMs = 10_000): Promise<T> {
      const queuedMessage = queued.shift();
      if (queuedMessage !== undefined) return Promise.resolve(queuedMessage as T);

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error(`Sandbox sent no message within ${timeoutMs}ms. stderr:\n${stderr}`));
        }, timeoutMs);

        waiting = (message) => {
          clearTimeout(timer);
          resolve(message as T);
        };

        // A module that dies before reporting should fail fast and loudly, not hang.
        void exited.then(() => {
          if (!waiting) return;
          clearTimeout(timer);
          waiting = null;
          reject(
            new Error(
              `Sandbox exited (code ${exit?.code}, signal ${exit?.signal}) before sending a message.` +
                `\nstderr:\n${stderr}`,
            ),
          );
        });
      });
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    send(message) {
      // A module that has already died is a normal race, not an error worth throwing over.
      if (child.connected) child.send(message);
    },
    kill() {
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}
