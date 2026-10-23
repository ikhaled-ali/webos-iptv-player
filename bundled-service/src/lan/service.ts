/**
 * LAN feature — webOS service integration. Owns the shared HTTP server's
 * lifecycle (bind/rebind/teardown) and the Luna methods the in-app client
 * drives (start/stop/heartbeat) plus the serviceEvents push channel. The pure
 * HTTP routing lives in lan/server.ts; setup and upload state live in their
 * respective modules.
 */

import * as http from 'http';
import { SetupActionStore } from '../setup/actions';
import { SetupStateStore } from '../setup/state';
import { startServer, type ServiceChangeEvent } from './server';

// Minimal shape of the webos-service Service object this module uses.
interface LunaService {
  register(method: string, handler: (msg: LunaMsg) => void): void;
  activityManager: {
    create(name: string, cb: () => void): void;
    complete(name: string, cb: () => void): void;
  };
}

type LunaMsg = {
  sender?: string;
  payload?: { encryptionKey?: unknown };
  respond: (r: unknown) => void;
  isSubscription?: boolean;
  // Per webos-service: msg is an EventEmitter; clients dropping their end
  // surface as a 'cancel' event on the msg. We use this for subscription
  // cleanup. (msg.cancel() exists too but is a *server-side* trigger taking
  // no arguments, not a callback-registering API.)
  on?: (event: 'cancel', listener: () => void) => void;
};

// Non-webOS fallback (e.g. local testing): start the HTTP server directly with
// no Luna bus. There are no push subscribers off-device, so onChange is a no-op.
export function startLanStandalone(dataDir: string): void {
  startServer(0, dataDir, () => { /* no serviceEvents subscribers off-device */ })
    .catch((err) => console.error('[lan] startServer failed:', err));
}

// Wire the shared LAN feature onto the Luna service.
export function registerLanService(service: LunaService, dataDir: string, appId: string): void {
  let server: http.Server | null = null;
  let actualPort: number | null = null;
  let localToken: string | null = null;
  let unlockUploads: ((key: string) => void) | null = null;

  function authorized(msg: LunaMsg): boolean {
    if (msg.sender === appId) return true;
    msg.respond({ returnValue: false, errorText: 'Local access only' });
    return false;
  }
  // Buffer for `start` messages that arrive before the HTTP server has finished
  // binding. We respond synchronously once the bind resolves to avoid using
  // `await` inside the Luna handler — async handlers break the message/activity
  // scoping in webos-service and cause the service process to exit after the
  // first respond().
  const pendingStarts: LunaMsg[] = [];
  // Subscribers to the `serviceEvents` push channel. Each entry is a Luna msg
  // retained from a subscribe request; the service calls msg.respond() to push.
  const subscribers: LunaMsg[] = [];
  const setupActions = new SetupActionStore();
  const setupState = new SetupStateStore();
  // The HTTP server is bound eagerly at wire-up AND lazily on `start` after a
  // `stop`, since the service process stays alive across the cycle (webos-service
  // holds the Luna bus connection, keeping Node's event loop running even after
  // we close the HTTP server and complete the keepAlive activity).
  let keepAliveCreated = false;
  let bindInProgress = false;

  function broadcastChange(event: ServiceChangeEvent): void {
    if (subscribers.length === 0) return;
    console.log('[lan] broadcasting ' + event + ' to ' + subscribers.length + ' subscriber(s)');
    for (let i = 0; i < subscribers.length;) {
      const sub = subscribers[i];
      try {
        sub.respond({ event });
        i++;
      } catch (e) {
        console.warn('[lan] subscriber respond failed, dropping:', e);
        subscribers.splice(i, 1);
      }
    }
  }

  function ensureServer(): void {
    if (server || bindInProgress) return;
    bindInProgress = true;
    console.log('[lan] (re)binding HTTP server');
    startServer(0, dataDir, broadcastChange, setupActions, setupState, true).then((r) => {
      bindInProgress = false;
      server = r.server;
      actualPort = r.port;
      localToken = r.localToken;
      unlockUploads = r.unlockUploads;
      console.log('[lan] HTTP server ready on port ' + actualPort);
      if (!keepAliveCreated) {
        service.activityManager.create('keepAlive', () => { /* keep service alive */ });
        keepAliveCreated = true;
      }
      // Drain any `start` calls that arrived before this bind finished.
      for (const m of pendingStarts) respondStarted(m);
      pendingStarts.length = 0;
    }).catch((err) => {
      bindInProgress = false;
      console.error('[lan] startServer failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      for (const m of pendingStarts) m.respond({ running: false, error: msg });
      pendingStarts.length = 0;
    });
  }

  // Eager bind at wire-up — keeps cold-start latency low for the first
  // `start` call (most common case).
  ensureServer();

  function respondStarted(msg: LunaMsg): void {
    try {
      const key = msg.payload && msg.payload.encryptionKey;
      if (typeof key !== 'string' || !unlockUploads) throw new Error('Upload storage locked');
      unlockUploads(key);
      msg.respond({ running: true, port: actualPort, localToken });
    } catch {
      msg.respond({ returnValue: false, running: false, errorText: 'Protected upload storage unavailable' });
    }
  }

  service.register('start', (msg) => {
    if (!authorized(msg)) return;
    console.log('[lan] start method invoked');
    if (actualPort !== null) {
      respondStarted(msg);
    } else {
      // Server still binding (or was torn down by stop and needs a fresh
      // bind) — queue this msg and kick a bind if one isn't already in
      // flight. The queue drains as soon as the bind resolves.
      pendingStarts.push(msg);
      ensureServer();
    }
  });

  service.register('heartbeat', (msg) => {
    if (!authorized(msg)) return;
    msg.respond({ running: !!server, port: actualPort });
  });

  // Graceful shutdown. The app calls this when it is backgrounded
  // (visibility → hidden) so the LAN HTTP port is released. The Node
  // process stays alive (Luna connection keeps the event loop running) so
  // a subsequent `start` rebinds via ensureServer() — Luna does NOT need
  // to respawn us.
  service.register('stop', (msg) => {
    if (!authorized(msg)) return;
    console.log('[lan] stop method invoked');
    // Drop all push subscribers — their connections are scoped to this
    // service lifetime and would be stale after a restart anyway.
    const droppedSubs = subscribers.length;
    subscribers.length = 0;
    try {
      service.activityManager.complete('keepAlive', () => {
        console.log('[lan] keepAlive activity completed');
      });
    } catch (e) {
      console.warn('[lan] activityManager.complete failed (ignoring):', e);
    }
    keepAliveCreated = false;
    const wasRunning = !!server;
    if (server) {
      const s = server;
      server = null;
      actualPort = null;
      localToken = null;
      s.close((err) => {
        if (err) console.warn('[lan] server.close error:', err);
        else console.log('[lan] HTTP server closed');
      });
    }
    msg.respond({ stopped: wasRunning, droppedSubscribers: droppedSubs });
  });

  // Push channel: clients subscribe once and the service calls
  // msg.respond({event}) whenever uploads mutate or a setup action is queued.
  service.register('serviceEvents', (msg) => {
    if (!authorized(msg)) return;
    if (msg.isSubscription) {
      if (subscribers.indexOf(msg) < 0) subscribers.push(msg);
      console.log('[lan] serviceEvents subscriber added, total=' + subscribers.length);
      // Per webos-service API: clients drop themselves by closing their end,
      // which the lib surfaces as a 'cancel' event on the msg. msg.cancel()
      // (no-arg) is a server-side trigger that we never need to call.
      if (typeof msg.on === 'function') {
        msg.on('cancel', () => {
          const index = subscribers.indexOf(msg);
          if (index >= 0) subscribers.splice(index, 1);
          console.log('[lan] serviceEvents subscriber cancelled, total=' + subscribers.length);
        });
      }
    }
    msg.respond({ subscribed: !!msg.isSubscription });
  });
}
