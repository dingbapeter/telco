import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withActor } from "../db.ts";
import { normaliseNigerianNumber } from "../phone.ts";
import { getSettingValue, getSettingValues, NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { advance, fitScreen, MOST_KEYPRESSES, openingScreen, tooLongScreen, type Answers, type Session, type Step } from "../ussd.ts";
import type { App, Request, Response } from "./http.ts";

// What the USSD aggregator talks to.
//
// One address, one shape of answer, and two things that differ between
// aggregators and are therefore configured once rather than guessed at every
// request: how they join up what the caller has keyed, and how they want the
// answer formatted. Both are in the environment file beside the shared secret,
// because they are decided the day the aggregator is chosen and never again.
//
// USSD_INPUT_STYLE=cumulative  the whole keyed history arrives each time,
//                              joined with stars: 1*08021234567*2*500
// USSD_INPUT_STYLE=keypress    only the latest keypress arrives
//
// USSD_RESPONSE_STYLE=con_end  a plain body beginning CON or END
// USSD_RESPONSE_STYLE=json     {"message": "...", "continueSession": true}

export type UssdConfig = { secret: string; inputStyle: "cumulative" | "keypress"; responseStyle: "con_end" | "json" };

export function ussdConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UssdConfig | undefined {
  const secret = env["USSD_SHARED_SECRET"];
  if (!secret) return undefined;
  return {
    secret,
    inputStyle: env["USSD_INPUT_STYLE"] === "keypress" ? "keypress" : "cumulative",
    responseStyle: env["USSD_RESPONSE_STYLE"] === "json" ? "json" : "con_end",
  };
}

// Aggregators each have their own spelling for the same five facts. Reading
// several spellings is cheaper than a adapter per aggregator, and a field we
// do not recognise is better than a session that silently starts again.
function field(req: Request, names: string[]): string {
  for (const n of names) {
    const v = req.form.get(n);
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

const NETWORK_WORDS: Record<string, NetworkCode> = {
  MTN: "MTN",
  MTNNG: "MTN",
  MTNNIGERIA: "MTN",
  AIRTEL: "AIRTEL",
  AIRTELNG: "AIRTEL",
  AIRTELNIGERIA: "AIRTEL",
  GLO: "GLO",
  GLONG: "GLO",
  GLOBACOM: "GLO",
  "9MOBILE": "9MOBILE",
  "9MOBILENG": "9MOBILE",
  // 9mobile was Etisalat Nigeria until 2017 and is still Emerging Markets
  // Telecommunication Services on paper. Aggregators use all three.
  ETISALAT: "9MOBILE",
  ETISALATNG: "9MOBILE",
  EMTS: "9MOBILE",
};

// Aggregators write the same network a dozen ways: MTN-NG, mtn_ng, "Airtel
// NG", Globacom. Everything but letters and digits goes, and what is left is
// looked up. An unknown word is not guessed at: the caller is asked instead.
function networkFrom(word: string): NetworkCode | undefined {
  const key = word.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ((NETWORK_CODES as readonly string[]).includes(key)) return key as NetworkCode;
  return NETWORK_WORDS[key];
}

function sameSecret(sent: string | undefined, expected: string): boolean {
  if (!sent) return false;
  const a = Buffer.from(sent, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function answer(config: UssdConfig, screen: string, done: boolean): Response {
  const text = fitScreen(screen);
  if (config.responseStyle === "json") return { kind: "json", body: { message: text, continueSession: !done } };
  return { kind: "text", body: `${done ? "END" : "CON"} ${text}`, contentType: "text/plain; charset=utf-8" };
}

type Row = {
  id: number;
  session_id: string;
  caller_number: string;
  service_code: string;
  network_code: NetworkCode | null;
  step: Step;
  answers: Answers;
  input_so_far: string;
  last_screen: string;
  keypresses: number;
  reference: string | null;
  ended_at: Date | null;
  last_seen_at: Date;
};

// The keypress this request carries, or that it is a repeat of one we have
// already acted on. A retry is answered with the screen we sent last time:
// the aggregator asked the same question, so it gets the same answer, and
// nothing moves twice.
function keypressFrom(config: UssdConfig, row: Row | undefined, text: string, now: Date): { input: string } | { repeat: true } {
  if (!row) return { input: text };
  if (config.inputStyle === "cumulative") {
    if (text === row.input_so_far) return { repeat: true };
    if (row.input_so_far === "") return { input: text };
    if (text.startsWith(`${row.input_so_far}*`)) return { input: text.slice(row.input_so_far.length + 1) };
    // Neither the same nor a continuation. Something is out of order, and
    // guessing which keypress is new would be guessing with somebody's money.
    return { repeat: true };
  }
  // One keypress at a time gives us nothing to compare, so the only signal is
  // time: the same key, moments apart, is the aggregator trying again.
  const since = now.getTime() - new Date(row.last_seen_at).getTime();
  const last = row.input_so_far.split("*").at(-1) ?? "";
  if (since < 5_000 && text === last) return { repeat: true };
  return { input: text };
}

export function registerUssd(app: App, options: { config?: UssdConfig | undefined } = {}): void {
  const config = options.config ?? ussdConfigFromEnv();

  app.post(
    "/ussd",
    async (req, db) => {
      // With no secret on the server the address does not exist, rather than
      // standing open.
      if (!config) return { kind: "json", status: 404, body: { error: "This address is not in use." } };
      const bearer = (req.raw.headers.authorization ?? "").startsWith("Bearer ") ? (req.raw.headers.authorization ?? "").slice(7).trim() : undefined;
      if (!sameSecret(bearer ?? field(req, ["secret", "sharedSecret"]), config.secret)) {
        return { kind: "json", status: 401, body: { error: "The shared secret does not match." } };
      }

      const sessionId = field(req, ["sessionId", "sessionID", "session_id", "sessionid"]);
      const msisdn = field(req, ["phoneNumber", "msisdn", "MSISDN", "from", "mobile"]);
      const serviceCode = field(req, ["serviceCode", "shortCode", "serviceId", "ussdCode"]);
      const text = field(req, ["text", "userData", "input", "message", "ussdString"]);
      const network = networkFrom(field(req, ["networkCode", "network", "operator", "telco"]));
      if (!sessionId) return { kind: "json", status: 400, body: { error: "The request carries no session id." } };

      const [enabled, ourCode, minutes] = await getSettingValues(db, ["ussd.enabled", "ussd.service_code", "ussd.session_minutes"] as const);
      if (!enabled) return answer(config, "Our dial service is not open at the moment. Please try our website instead.", true);
      // A short code we do not serve is somebody else's traffic, or a test
      // against the wrong address. Either way it is not ours to answer.
      if (ourCode !== "" && serviceCode !== "" && serviceCode.replace(/\s/g, "") !== ourCode.replace(/\s/g, "")) {
        return answer(config, "That code is not ours. Nothing was taken.", true);
      }
      const caller = normaliseNigerianNumber(msisdn);
      if (!caller) return answer(config, "We cannot read the number you are dialling from, so we cannot go on. Nothing was taken.", true);

      return withActor(`ussd:${caller}`, async (c) => {
        const now = new Date();
        // One request at a time per session. Two keypresses racing is normal
        // on a bad line, and this is what stops them interleaving. The lock is
        // on the session id rather than on a row, because the first two
        // requests of a dial race before there is any row to lock.
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ussd:${sessionId}`]);
        const latest = (
          await c.query<Row>("SELECT * FROM ussd_sessions WHERE session_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1", [sessionId])
        ).rows[0];
        // Still the session in front of the caller, rather than one the
        // network dropped and walked away from.
        const live = latest !== undefined && new Date(latest.last_seen_at).getTime() > now.getTime() - minutes * 60_000;

        // A dial that has already finished. The only thing that can arrive on
        // it is the aggregator asking again, so it is given the answer it was
        // given before: the reference and the dial code, not a fresh menu
        // that would lose the caller the thing they rang up for.
        if (latest && live && latest.ended_at) return answer(config, latest.last_screen, true);

        const existing = latest && live && !latest.ended_at ? latest : undefined;
        if (!existing) {
          // A session the network has already dropped, or a brand new one.
          // Either way the caller is at the first screen. A dropped one is
          // closed first, so the open list is the sessions that are really
          // open and the new dial may take the id; what happened in it stays
          // in its own row.
          if (latest && !latest.ended_at) {
            await c.query("UPDATE ussd_sessions SET ended_at = now(), outcome = coalesce(outcome, 'dropped') WHERE id = $1", [latest.id]);
          }
          const screen = openingScreen();
          await c.query(
            `INSERT INTO ussd_sessions (session_id, caller_number, service_code, network_code, step, last_screen, input_so_far, transcript)
             VALUES ($1, $2, $3, $4, 'menu', $5, '', $6::jsonb)`,
            [sessionId, caller, serviceCode, network ?? null, screen, JSON.stringify([{ at: now.toISOString(), screen }])],
          );
          return answer(config, screen, false);
        }

        const read = keypressFrom(config, existing, text, now);
        if ("repeat" in read) {
          // A retry keys nothing, so it is not written into the transcript:
          // an aggregator stuck in a loop would otherwise fill the row with
          // the same line. It is counted, because the ceiling has to be a
          // ceiling on requests, or a loop would hold a session open for ever.
          if (existing.keypresses >= MOST_KEYPRESSES) {
            await c.query("UPDATE ussd_sessions SET last_seen_at = now(), ended_at = now(), outcome = 'too_many_keypresses' WHERE id = $1", [existing.id]);
            return answer(config, tooLongScreen(), true);
          }
          await c.query("UPDATE ussd_sessions SET keypresses = keypresses + 1, last_seen_at = now() WHERE id = $1", [existing.id]);
          return answer(config, existing.last_screen, false);
        }

        const session: Session = {
          session_id: existing.session_id,
          caller_number: existing.caller_number,
          service_code: existing.service_code,
          network_code: existing.network_code ?? network ?? null,
          step: existing.step,
          answers: existing.answers,
          input_so_far: existing.input_so_far,
          last_screen: existing.last_screen,
          keypresses: existing.keypresses,
          reference: existing.reference,
        };
        const result = await advance(c, session, read.input, `ussd:${caller}`);
        const joined = existing.input_so_far === "" ? read.input : `${existing.input_so_far}*${read.input}`;
        await c.query(
          `UPDATE ussd_sessions SET step = $2, answers = $3::jsonb, input_so_far = $4, last_screen = $5, keypresses = keypresses + 1,
             reference = coalesce($6, reference), last_seen_at = now(), ended_at = CASE WHEN $7 THEN now() ELSE NULL END, outcome = $8,
             transcript = transcript || $9::jsonb
           WHERE id = $1`,
          [
            existing.id,
            result.step,
            JSON.stringify(result.answers),
            joined,
            result.screen,
            result.reference ?? null,
            result.done,
            result.outcome ?? null,
            JSON.stringify([{ at: now.toISOString(), keyed: read.input, screen: result.screen }]),
          ],
        );
        return answer(config, result.screen, result.done);
      }, db);
    },
    false,
  );
}

// Sessions the network dropped and never came back to. The window is the same
// setting the endpoint uses to decide whether a session is still the one in
// front of the caller, so a session nobody could carry on with is not left
// looking open in the command centre.
export async function closeIdleUssdSessions(db: pg.Pool): Promise<number> {
  const minutes = await getSettingValue(db, "ussd.session_minutes");
  const { rowCount } = await db.query(
    "UPDATE ussd_sessions SET ended_at = now(), outcome = coalesce(outcome, 'dropped') WHERE ended_at IS NULL AND last_seen_at < now() - make_interval(mins => $1)",
    [minutes],
  );
  return rowCount ?? 0;
}
