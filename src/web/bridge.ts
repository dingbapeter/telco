import { deviceFromToken, heartbeat, ingestMessage, receivingNumberFor, type IncomingMessage, type MessageResult } from "../bridge.ts";
import { withActor } from "../db.ts";
import { fetchCommands, reportResult } from "../sendingphone.ts";
import type { App, Request } from "./http.ts";

// What the phone app talks to. Every request carries the device token as a
// bearer token; a wrong token gets the same answer as no token.
function bearer(req: Request): string | undefined {
  const h = req.raw.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

const MAX_BATCH = 100;

export function registerBridge(app: App): void {
  app.post(
    "/bridge/messages",
    async (req, db) => {
      const device = await deviceFromToken(db, bearer(req));
      if (!device) return { kind: "json", status: 401, body: { error: "This phone's token is not recognised. Create the phone again in the command centre under Phone bridge and enter the new token." } };
      let messages: IncomingMessage[];
      try {
        const raw = req.form.get("messages");
        messages = raw ? (JSON.parse(raw) as IncomingMessage[]) : [];
        if (!Array.isArray(messages)) throw new Error("not a list");
        for (const m of messages) {
          if (typeof m.from !== "string" || typeof m.body !== "string") throw new Error("each message needs from and body");
        }
      } catch (err) {
        return { kind: "json", status: 400, body: { error: `The request body was not understood: ${(err as Error).message}.` } };
      }
      if (messages.length > MAX_BATCH) return { kind: "json", status: 400, body: { error: `Send at most ${MAX_BATCH} messages per request.` } };
      const flag = (name: string): boolean | undefined => (req.form.has(name) ? req.form.get(name) === "true" : undefined);
      const status = {
        appVersion: req.form.get("appVersion") ?? undefined,
        battery: Number(req.form.get("battery")),
        queueSize: Number(req.form.get("queueSize")),
        canSend: flag("canSend"),
        pinSet: flag("pinSet"),
      };
      const results: MessageResult[] = [];
      // Each message in its own transaction so one bad message cannot take
      // the others down with it, and a phone can safely resend the batch.
      for (const m of messages) {
        results.push(await withActor(`bridge:${device.label}`, async (c) => ingestMessage(c, device, await receivingNumberFor(c, device), m), db));
      }
      await withActor(`bridge:${device.label}`, (c) => heartbeat(c, device.id, status), db);
      const pending = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM phone_commands WHERE device_id = $1 AND state = 'queued'", [device.id])).rows[0]!.n;
      return { kind: "json", body: { ok: true, results, pendingCommands: pending } };
    },
    false,
  );

  // The phone asks for things to dial. Each command is handed out once and
  // carries the code with {pin} left for the phone to fill in.
  app.post(
    "/bridge/commands/fetch",
    async (req, db) => {
      const device = await deviceFromToken(db, bearer(req));
      if (!device) return { kind: "json", status: 401, body: { error: "This phone's token is not recognised." } };
      const commands = await withActor(`bridge:${device.label}`, (c) => fetchCommands(c, device.id), db);
      return { kind: "json", body: { ok: true, commands: commands.map((c) => ({ id: c.id, kind: c.kind, code: c.code, number: c.number, amountKobo: c.amount_kobo })) } };
    },
    false,
  );

  app.post(
    "/bridge/commands/:id/result",
    async (req, db) => {
      const device = await deviceFromToken(db, bearer(req));
      if (!device) return { kind: "json", status: 401, body: { error: "This phone's token is not recognised." } };
      const id = Number(req.query.get("id"));
      const ok = req.form.get("ok") === "true";
      const c = await withActor(`bridge:${device.label}`, (c) => reportResult(c, device.id, id, { ok, response: req.form.get("response") ?? undefined, failure: req.form.get("failure") ?? undefined }), db);
      if (!c) return { kind: "json", status: 404, body: { error: "No such command for this phone." } };
      return { kind: "json", body: { ok: true, state: c.state } };
    },
    false,
  );
}
