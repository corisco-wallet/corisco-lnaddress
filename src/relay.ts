import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import WebSocket from "ws";
import { type NostrEvent, type NostrKeys, signEvent } from "./nostr";
import { type RelayPolicy, isPrivateAddress } from "./zaps";

const AUTH_KIND = 22242;

export interface PublishOptions {
  keys: NostrKeys;
  policy: RelayPolicy;
  timeoutMs?: number;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Refuses to connect when a relay's hostname resolves to a private address, so payer-chosen URLs can't reach internal hosts. */
export function publicOnlyLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (addresses.length === 0) return callback(Object.assign(new Error(`relay ${hostname} has no address`), { code: "ENOTFOUND" }), []);
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked) return callback(Object.assign(new Error(`relay ${hostname} resolves to a private address`), { code: "EPRIVATE" }), []);
    if ((options as { all?: boolean }).all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Resolves once the relay accepts `event`; rejects if it refuses, times out or can't be reached. */
export function publishToRelay(url: string, event: NostrEvent, { keys, policy, timeoutMs = 10_000 }: PublishOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      maxPayload: 1024 * 1024,
      followRedirects: false,
      ...(policy.allowPrivate ? {} : { lookup: publicOnlyLookup }),
    });
    let authEventId: string | null = null;
    let authAccepted = false;
    let resendAfterAuth = false;
    let retried = false;

    const finish = (err?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`relay ${url} timed out`)), timeoutMs);
    const sendEvent = () => socket.send(JSON.stringify(["EVENT", event]));

    socket.on("open", sendEvent);
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error(`relay ${url} closed the connection`)));
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      const [type, ...rest] = message;

      if (type === "AUTH" && typeof rest[0] === "string" && authEventId === null) {
        const auth = signEvent(
          { kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["relay", url], ["challenge", rest[0]]] },
          keys,
        );
        authEventId = auth.id;
        socket.send(JSON.stringify(["AUTH", auth]));
        return;
      }
      if (type !== "OK") return;
      const [id, accepted, reason] = rest as [string, boolean, string | undefined];

      if (id === authEventId) {
        authAccepted = accepted;
        if (!resendAfterAuth) return;
        if (!accepted) return finish(new Error(`relay ${url} rejected AUTH: ${reason ?? ""}`));
        resendAfterAuth = false;
        sendEvent();
        return;
      }
      if (id !== event.id) return;
      if (accepted || reason?.startsWith("duplicate:")) return finish();
      if (reason?.startsWith("auth-required:") && !retried) {
        retried = true;
        // The relay may ask for AUTH before or after refusing the event; resend once it has accepted it.
        if (authAccepted) sendEvent();
        else resendAfterAuth = true;
        return;
      }
      finish(new Error(`relay ${url} rejected the event: ${reason ?? ""}`));
    });
  });
}

/** Publishes to every relay at once; returns how many accepted the event. */
export async function publishToRelays(relays: string[], event: NostrEvent, options: PublishOptions): Promise<number> {
  const results = await Promise.allSettled(relays.map((url) => publishToRelay(url, event, options)));
  return results.filter((result) => result.status === "fulfilled").length;
}
