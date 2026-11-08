import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { type NostrEvent, parseSignedEvent } from "../src/nostr";

export interface FakeRelayOptions {
  /** Reply to EVENT with this OK; defaults to accepting. */
  respond?: (event: NostrEvent) => [accepted: boolean, reason: string] | null;
  /** Requires NIP-42 AUTH before accepting events. */
  requireAuth?: boolean;
}

/** A minimal Nostr relay on localhost that records what it receives. */
export async function startFakeRelay({ respond, requireAuth = false }: FakeRelayOptions = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const received: NostrEvent[] = [];
  const auths: NostrEvent[] = [];
  const url = `ws://localhost:${(server.address() as AddressInfo).port}`;

  server.on("connection", (socket) => {
    const challenge = "challenge-" + Math.random().toString(36).slice(2);
    let authed = false;
    if (requireAuth) socket.send(JSON.stringify(["AUTH", challenge]));
    socket.on("message", (data) => {
      const [type, payload] = JSON.parse(data.toString()) as [string, NostrEvent];
      const event = parseSignedEvent(JSON.stringify(payload));
      if (!event) return socket.send(JSON.stringify(["NOTICE", "invalid event"]));
      if (type === "AUTH") {
        authed = event.kind === 22242 && event.tags.some((t) => t[0] === "challenge" && t[1] === challenge);
        auths.push(event);
        return socket.send(JSON.stringify(["OK", event.id, authed, authed ? "" : "invalid: bad auth"]));
      }
      if (requireAuth && !authed) return socket.send(JSON.stringify(["OK", event.id, false, "auth-required: sign in first"]));
      received.push(event);
      const reply = respond ? respond(event) : [true, ""];
      if (reply) socket.send(JSON.stringify(["OK", event.id, ...reply]));
    });
  });

  return {
    url,
    received,
    auths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
