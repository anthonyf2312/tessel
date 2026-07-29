/**
 * Sandbox hardening bootstrap.
 *
 * Loaded with `--import` so it runs to completion BEFORE any module code is evaluated.
 * This is the in-process half of the boundary; the other half is Node's `--permission`
 * flag applied by spawn.ts. Neither is trusted alone — an escape has to defeat both.
 *
 * Order matters here:
 *   1. deny dangerous builtins at resolution time
 *   2. capture the IPC channel, then take it away from module code
 *   3. remove ambient network globals
 *   4. freeze intrinsics last, so nothing above can be undone
 */
import { registerHooks } from 'node:module';

/**
 * Builtins module code may never import.
 *
 * `path`, `url`, `util`, `buffer`, `events`, `stream`, `crypto`, `zlib`, `assert`, `timers`
 * and `string_decoder` are deliberately NOT denied: they are pure/local and module authors
 * genuinely need them. Everything that touches the network, the filesystem, other processes,
 * or the runtime's own internals is denied.
 */
const DENIED_BUILTINS = new Set([
  'fs',
  'net',
  'http',
  'https',
  'http2',
  'dgram',
  'dns',
  'tls',
  'child_process',
  'worker_threads',
  'cluster',
  'vm',
  'inspector',
  'module',
  'process',
  'os',
  'v8',
  'repl',
  'readline',
  'tty',
  'async_hooks',
  'diagnostics_channel',
  'trace_events',
  'perf_hooks',
  'wasi',
  'sea',
  'sqlite',
  'test',
]);

/** `node:fs/promises` and `fs` both normalise to `fs`. */
function normaliseSpecifier(specifier) {
  const withoutScheme = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return withoutScheme.split('/')[0];
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (DENIED_BUILTINS.has(normaliseSpecifier(specifier))) {
      const error = new Error(
        `'${specifier}' is not available inside the module sandbox. ` +
          `If your module needs this capability, request it through @tessel/sdk instead.`,
      );
      error.code = 'ERR_MODULE_SANDBOX_DENIED';
      throw error;
    }
    return nextResolve(specifier, context);
  },
});

// --- 2. Capture IPC, then remove it from module code's reach ------------------------------

const rawSend = typeof process.send === 'function' ? process.send.bind(process) : null;

const inboundListeners = [];

/**
 * This listener MUST be attached before `process.channel` is deleted below.
 *
 * Node starts reading the IPC channel lazily, when the first 'message' listener is added.
 * Attaching ours here means the channel is already live and owned by us; module code then
 * subscribes to this fan-out instead of touching `process` at all.
 */
process.on('message', (message) => {
  for (const listener of inboundListeners) {
    try {
      listener(message);
    } catch {
      // A throwing module handler must not tear down the channel for the rest of the module.
    }
  }
});

/**
 * The module's ONLY capability. Everything a module can do in Discord goes through here and
 * is validated, permission-checked and guild-scoped by core on the other side.
 */
const channel = Object.freeze({
  send(message) {
    if (!rawSend) throw new Error('Sandbox IPC channel is not available.');
    rawSend(message);
  },
  onMessage(listener) {
    inboundListeners.push(listener);
  },
});

Object.defineProperty(globalThis, '__tessel', {
  value: channel,
  writable: false,
  configurable: false,
  enumerable: false,
});

delete process.send;
delete process.binding;
delete process.dlopen;

// `process.channel` is deliberately NOT deleted. Deleting it stops Node delivering inbound
// IPC entirely, which silently breaks every command dispatch while leaving the module
// looking healthy. Keeping it costs nothing security-wise: the boundary has never depended
// on hiding the transport — core validates, permission-checks and guild-scopes every single
// message that arrives, and a module can already send over the brokered channel anyway.
// See the 'receives messages sent to it by core' test, which fails if this is removed.

// Spawned with env:{}, so this is already empty — replaced anyway so that a future spawn bug
// cannot turn into a token leak.
Object.defineProperty(process, 'env', {
  value: Object.freeze(Object.create(null)),
  writable: false,
  configurable: false,
});

// --- 3. Remove ambient egress ------------------------------------------------------------
// Outbound HTTP is an SDK call brokered by core against the manifest's host allowlist.
// These globals are the only un-brokered egress paths, so they go.

for (const name of [
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'Request',
  'Response',
  'Headers',
  'FormData',
  'navigator',
]) {
  delete globalThis[name];
}

// --- 4. Freeze intrinsics ----------------------------------------------------------------
// Stops module code from re-patching the prototypes the SDK and core rely on, and closes
// prototype-pollution as a route to influencing core's behaviour through returned objects.

for (const intrinsic of [
  Object,
  Array,
  Function,
  String,
  Number,
  Boolean,
  Symbol,
  Error,
  TypeError,
  RangeError,
  Promise,
  RegExp,
  Date,
  Map,
  Set,
  WeakMap,
  WeakSet,
]) {
  Object.freeze(intrinsic.prototype);
  Object.freeze(intrinsic);
}

Object.freeze(JSON);
Object.freeze(Math);
Object.freeze(Reflect);
