/**
 * Keeps module processes alive without letting a broken one take the bot with it.
 *
 * Two failure modes are handled: a module that exits, and a module that stays alive but
 * stops answering. Both are treated as the same kind of fault for restart accounting, so a
 * module that hangs in a loop cannot dodge the auto-disable limit by never crashing.
 */
import { spawnSandbox, type SandboxHandle, type SandboxMessage } from './spawn.ts';

export interface SupervisorOptions {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** How long a module gets to finish booting and report ready before it counts as failed. */
  startupTimeoutMs?: number;
  /** Failures tolerated inside `restartWindowMs` before the module is auto-disabled. */
  maxRestarts?: number;
  restartWindowMs?: number;
  backoffBaseMs?: number;
  maxOldSpaceMb?: number;
}

export interface StartOptions {
  moduleId: string;
  bundlePath: string;
}

export type AutoDisabledListener = (moduleId: string, reason: string) => void;
export type ModuleMessageListener = (moduleId: string, message: unknown) => void;

type FailureKind = 'crashed' | 'unresponsive';

interface Entry {
  moduleId: string;
  bundlePath: string;
  handle: SandboxHandle | null;
  running: boolean;
  /** Set when the module reports ready. Heartbeats do not start before this. */
  ready: boolean;
  stopped: boolean;
  disabled: boolean;
  restarts: number;
  failureTimes: number[];
  pendingFailureKind: FailureKind;
  heartbeatTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  startupTimer: NodeJS.Timeout | null;
  awaitingPongSince: number | null;
  nextPingId: number;
}

const DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  startupTimeoutMs: 30_000,
  maxRestarts: 3,
  restartWindowMs: 5 * 60_000,
  backoffBaseMs: 500,
  maxOldSpaceMb: 128,
};

export class Supervisor {
  readonly #options: Required<SupervisorOptions>;
  readonly #entries = new Map<string, Entry>();
  readonly #autoDisabledListeners: AutoDisabledListener[] = [];
  readonly #messageListeners: ModuleMessageListener[] = [];

  constructor(options: SupervisorOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  onAutoDisabled(listener: AutoDisabledListener): void {
    this.#autoDisabledListeners.push(listener);
  }

  /** Every message from every supervised module, tagged with which module sent it. */
  onMessage(listener: ModuleMessageListener): void {
    this.#messageListeners.push(listener);
  }

  async start(options: StartOptions): Promise<void> {
    const existing = this.#entries.get(options.moduleId);
    if (existing && existing.running) return;

    const entry: Entry = existing ?? {
      moduleId: options.moduleId,
      bundlePath: options.bundlePath,
      handle: null,
      running: false,
      ready: false,
      stopped: false,
      disabled: false,
      restarts: 0,
      failureTimes: [],
      pendingFailureKind: 'crashed',
      heartbeatTimer: null,
      restartTimer: null,
      startupTimer: null,
      awaitingPongSince: null,
      nextPingId: 0,
    };

    entry.bundlePath = options.bundlePath;
    entry.stopped = false;
    entry.disabled = false;
    this.#entries.set(entry.moduleId, entry);

    this.#spawn(entry);
  }

  isRunning(moduleId: string): boolean {
    return this.#entries.get(moduleId)?.running ?? false;
  }

  restartCount(moduleId: string): number {
    return this.#entries.get(moduleId)?.restarts ?? 0;
  }

  /** Sends a message into a running module. No-ops if it is not running. */
  send(moduleId: string, message: SandboxMessage): void {
    this.#entries.get(moduleId)?.handle?.send(message);
  }

  async stop(moduleId: string): Promise<void> {
    const entry = this.#entries.get(moduleId);
    if (!entry) return;

    entry.stopped = true;
    this.#clearTimers(entry);

    const handle = entry.handle;
    entry.handle = null;
    entry.running = false;

    if (handle) {
      handle.kill();
      await handle.exited;
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((moduleId) => this.stop(moduleId)));
  }

  #spawn(entry: Entry): void {
    const handle = spawnSandbox({
      bundlePath: entry.bundlePath,
      maxOldSpaceMb: this.#options.maxOldSpaceMb,
    });

    entry.handle = handle;
    entry.running = true;
    entry.ready = false;
    entry.awaitingPongSince = null;
    entry.pendingFailureKind = 'crashed';

    handle.onMessage((message) => {
      if (isPong(message)) {
        entry.awaitingPongSince = null;
        return;
      }

      // Heartbeats cannot start before the module is listening, or the first ping lands in
      // the gap between spawn and the module registering its handler and is lost.
      if (!entry.ready && isReady(message)) {
        entry.ready = true;
        this.#clearStartupTimer(entry);
        this.#startHeartbeat(entry);
      }

      for (const listener of this.#messageListeners) listener(entry.moduleId, message);
    });

    entry.startupTimer = setTimeout(() => {
      if (entry.ready || entry.handle !== handle) return;
      entry.pendingFailureKind = 'unresponsive';
      handle.kill();
    }, this.#options.startupTimeoutMs);

    entry.startupTimer.unref?.();

    void handle.exited.then(() => {
      // A stale handle from a module we already replaced or stopped must not trigger
      // restart accounting for the current one.
      if (entry.handle !== handle) return;
      entry.running = false;
      entry.handle = null;
      this.#onFailure(entry, entry.pendingFailureKind);
    });
  }

  #startHeartbeat(entry: Entry): void {
    this.#clearHeartbeat(entry);

    entry.heartbeatTimer = setInterval(() => {
      const handle = entry.handle;
      if (!handle) return;

      if (
        entry.awaitingPongSince !== null &&
        Date.now() - entry.awaitingPongSince > this.#options.heartbeatTimeoutMs
      ) {
        // Killing it routes through the normal exit path, which handles the accounting.
        entry.pendingFailureKind = 'unresponsive';
        handle.kill();
        return;
      }

      if (entry.awaitingPongSince === null) {
        entry.awaitingPongSince = Date.now();
        handle.send({ type: 'ping', id: entry.nextPingId++ });
      }
    }, this.#options.heartbeatIntervalMs);

    entry.heartbeatTimer.unref?.();
  }

  #onFailure(entry: Entry, kind: FailureKind): void {
    if (entry.stopped || entry.disabled) return;

    this.#clearHeartbeat(entry);
    this.#clearStartupTimer(entry);

    const now = Date.now();
    entry.failureTimes.push(now);
    entry.failureTimes = entry.failureTimes.filter(
      (at) => now - at <= this.#options.restartWindowMs,
    );

    if (entry.failureTimes.length > this.#options.maxRestarts) {
      const seconds = Math.round(this.#options.restartWindowMs / 1000);
      const reason =
        kind === 'unresponsive'
          ? `Module stopped responding and crashed ${entry.failureTimes.length} times within ${seconds}s.`
          : `Module crashed ${entry.failureTimes.length} times within ${seconds}s.`;
      this.#disable(entry, reason);
      return;
    }

    const delay = this.#options.backoffBaseMs * 2 ** entry.restarts;
    entry.restarts += 1;

    entry.restartTimer = setTimeout(() => {
      if (entry.stopped || entry.disabled) return;
      this.#spawn(entry);
    }, delay);

    entry.restartTimer.unref?.();
  }

  #disable(entry: Entry, reason: string): void {
    entry.disabled = true;
    entry.running = false;
    this.#clearTimers(entry);
    entry.handle?.kill();
    entry.handle = null;

    for (const listener of this.#autoDisabledListeners) listener(entry.moduleId, reason);
  }

  #clearHeartbeat(entry: Entry): void {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }

  #clearStartupTimer(entry: Entry): void {
    if (entry.startupTimer) clearTimeout(entry.startupTimer);
    entry.startupTimer = null;
  }

  #clearTimers(entry: Entry): void {
    this.#clearHeartbeat(entry);
    this.#clearStartupTimer(entry);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
}

function isReady(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready';
}

function isPong(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'pong';
}
