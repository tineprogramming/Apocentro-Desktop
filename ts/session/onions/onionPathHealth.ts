/**
 * Apocentro: onion path connection health watchdog — desktop port of the
 * Android `PathManager` watchdog (apocentro-android PR #6).
 *
 * The action-panel path light is green only with >= 2 built onion paths.
 * Before this, nothing actively recovered a stuck yellow/red light: rebuilds
 * only happened as a side effect of request traffic, and they kept drawing
 * from the same cached snode pool / guard nodes even when those were dead.
 *
 * This watchdog checks every few seconds. If we stay non-green longer than the
 * grace period while the app believes it is online, it forces a reconnect:
 * drop all paths and rebuild. From the second consecutive failed attempt it
 * also drops the guard nodes and refreshes the snode pool (seed fallback), so
 * we stop recycling dead cached nodes. Attempts back off exponentially (10s
 * doubling, capped at 5 min), each backoff is followed by a fresh grace
 * period, and the escalation only resets once we have stayed green for
 * STABLE_HEALTHY_RESET_MS (Android V5.6 / iOS 5d0ffcf20): a flapping
 * connection that is briefly green after each forced rebuild must keep
 * climbing towards a pool reseed instead of retrying attempt #1 forever.
 *
 * Desktop analogue of the iOS "grace expired while asleep" bug: timers stop
 * while the computer sleeps, but Date.now() keeps moving. A tick gap much
 * longer than CHECK_INTERVAL_MS means we slept, so the clocks restart instead
 * of treating the whole sleep as unhealthy time.
 *
 * It also keeps a small event timeline and can render a diagnostics report for
 * the "Connection details" panel on the onion path dialog, so users can send
 * us what their client actually did.
 */

import { isEqual } from 'lodash';

import { OnionPaths } from '.';
import { Data } from '../../data/data';
import { SnodePool } from '../apis/snode_api/snodePool';
import { updateOnionPaths } from '../../state/ducks/onions';

const logPrefix = '[onionPathHealth]';

const CHECK_INTERVAL_MS = 5_000;
// How long we may stay non-green before the watchdog forces a reconnect
const UNHEALTHY_GRACE_MS = 15_000;
// From this consecutive attempt onwards, also drop guards + refresh the snode pool
const POOL_RESEED_FROM_ATTEMPT = 2;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_DEBUG_EVENTS = 40;
// How long we must stay green before the escalation ladder resets
const STABLE_HEALTHY_RESET_MS = 60_000;
// A gap between ticks longer than this means the computer slept / the process was paused
const SLEEP_GAP_MS = 3 * CHECK_INTERVAL_MS;

let watchdogStarted = false;
let unhealthySince: number | null = null;
let healthySince: number | null = null;
let lastTickAt: number | null = null;
let recoveryAttempts = 0;
let lastAttemptAt = 0;
let reconnectInFlight = false;
let statusSince = Date.now();
let lastHealthy: boolean | null = null;
const debugEvents: Array<string> = [];

function timeStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function logDebugEvent(message: string): void {
  debugEvents.push(`${timeStamp()} ${message}`);
  while (debugEvents.length > MAX_DEBUG_EVENTS) {
    debugEvents.shift();
  }
  window?.log?.info(`${logPrefix} ${message}`);
}

function isOnline(): boolean {
  return Boolean(window.isOnline);
}

/** Same rule as the action-panel light: green needs >= 2 built paths. */
export function isPathHealthy(): boolean {
  return isOnline() && OnionPaths.onionPaths.length >= 2;
}

function backoffForAttempt(attempt: number): number {
  const capped = Math.min(Math.max(attempt - 1, 0), 5);
  return Math.min(BACKOFF_BASE_MS * 2 ** capped, BACKOFF_MAX_MS);
}

/** Mirror of what getOnionPath() dispatches, so the light updates without traffic. */
function syncOnionPathsToRedux(): void {
  const ipsOnly = OnionPaths.onionPaths
    .filter(m => m.filter(c => c.ip))
    .map(m => m.map(c => ({ ip: c.ip })));
  if (!isEqual(window.inboxStore?.getState().onionPaths.snodePaths, ipsOnly)) {
    window.inboxStore?.dispatch(updateOnionPaths(ipsOnly));
  }
}

/**
 * Force a reconnect with fresh nodes. Used by the watchdog and by the manual
 * Retry button on the onion path dialog. Escalates exactly like Android:
 * attempt 1 rebuilds with what we have; attempt >= POOL_RESEED_FROM_ATTEMPT
 * drops the guard nodes too and refreshes the snode pool (snodes, then seed).
 */
export async function forceOnionReconnect(source: 'watchdog' | 'manual'): Promise<void> {
  if (reconnectInFlight) {
    return;
  }
  reconnectInFlight = true;
  try {
    recoveryAttempts += 1;
    lastAttemptAt = Date.now();
    const reseed = recoveryAttempts >= POOL_RESEED_FROM_ATTEMPT;
    logDebugEvent(
      `reconnect #${recoveryAttempts} (${source}): new nodes${reseed ? ' + fresh guards/pool' : ''}`
    );

    await OnionPaths.dropAllPathsForReconnect(reseed);
    if (reseed) {
      try {
        await SnodePool.forceRefreshRandomSnodePool();
      } catch (e) {
        logDebugEvent(`pool refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await OnionPaths.buildNewOnionPathsOneAtATime();
    logDebugEvent(`paths rebuilt (count=${OnionPaths.onionPaths.length})`);
    syncOnionPathsToRedux();
  } catch (e) {
    logDebugEvent(`reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    reconnectInFlight = false;
  }
}

async function checkHealthTick(): Promise<void> {
  const tickAt = Date.now();
  if (lastTickAt !== null && tickAt - lastTickAt > SLEEP_GAP_MS) {
    logDebugEvent(
      `woke after ${Math.round((tickAt - lastTickAt) / 1000)}s pause, restarting clocks`
    );
    unhealthySince = null;
    healthySince = null;
  }
  lastTickAt = tickAt;

  const healthy = isPathHealthy();
  if (healthy !== lastHealthy) {
    lastHealthy = healthy;
    statusSince = Date.now();
    logDebugEvent(
      `status → ${healthy ? 'green' : 'not green'} (paths=${OnionPaths.onionPaths.length}, online=${isOnline()})`
    );
  }
  const now = Date.now();
  if (healthy) {
    unhealthySince = null;
    if (healthySince === null) {
      healthySince = now;
    }
    if (recoveryAttempts > 0 && now - healthySince >= STABLE_HEALTHY_RESET_MS) {
      logDebugEvent(
        `stable green for ${STABLE_HEALTHY_RESET_MS / 1000}s, reset after ${recoveryAttempts} attempt(s)`
      );
      recoveryAttempts = 0;
    }
    return;
  }
  healthySince = null;
  if (!isOnline()) {
    // Don't burn attempts while offline; the clock restarts when we're back
    unhealthySince = null;
    return;
  }
  if (recoveryAttempts > 0 && now - lastAttemptAt < backoffForAttempt(recoveryAttempts)) {
    // Still backing off: the grace period only starts once the backoff is over
    unhealthySince = null;
    return;
  }
  if (unhealthySince === null) {
    unhealthySince = now;
    return;
  }
  if (now - unhealthySince < UNHEALTHY_GRACE_MS) {
    return;
  }
  logDebugEvent(`not green for ${Math.round((now - unhealthySince) / 1000)}s`);
  unhealthySince = null;
  await forceOnionReconnect('watchdog');
}

/** Start the periodic health check. Safe to call more than once. */
export function startOnionPathHealthWatchdog(): void {
  if (watchdogStarted) {
    return;
  }
  watchdogStarted = true;
  logDebugEvent('watchdog started');
  setInterval(() => {
    void checkHealthTick().catch(e => {
      window?.log?.warn(
        `${logPrefix} health tick failed (ignored): ${e instanceof Error ? e.message : String(e)}`
      );
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Human-readable snapshot for the "Connection details" panel on the onion path
 * dialog. English on purpose — it's a diagnostic artifact for the developers.
 */
export async function buildOnionDebugReport(): Promise<string> {
  const now = Date.now();
  const paths = OnionPaths.onionPaths;
  const guards = OnionPaths.guardNodes;
  let poolSize = -1;
  try {
    poolSize = (await Data.getSnodePoolFromDb())?.length ?? 0;
  } catch {
    // leave as unknown
  }

  const lines: Array<string> = [];
  lines.push('Apocentro connection debug (desktop)');
  lines.push(`time: ${new Date(now).toISOString()}`);
  lines.push(
    `status: ${isPathHealthy() ? 'green' : isOnline() ? 'not green' : 'offline'} (for ${Math.floor((now - statusSince) / 1000)}s)`
  );
  lines.push(`online: ${isOnline()}`);
  lines.push(`paths: ${paths.length} (green needs 2)`);
  paths.forEach((path, i) => {
    lines.push(`  path ${i + 1}: ${path.map(s => `${s.ip}:${s.port}`).join(' → ')}`);
  });
  lines.push(`guard nodes: ${guards.length}`);
  lines.push(`snode pool: ${poolSize === -1 ? 'unknown' : `${poolSize} nodes`}`);
  lines.push(
    `recovery attempts since last stable green (${STABLE_HEALTHY_RESET_MS / 1000}s): ${recoveryAttempts}`
  );
  lines.push('recent events:');
  if (debugEvents.length === 0) {
    lines.push('  (none)');
  }
  debugEvents.forEach(e => lines.push(`  ${e}`));
  return lines.join('\n');
}
