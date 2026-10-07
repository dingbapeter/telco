import { randomUUID } from "node:crypto";

// A stand-in for the aggregator: the thing that would be dialling us.
//
// It speaks both of the conventions real aggregators use, because the one we
// end up with is not known yet and the endpoint has to be right either way.
// In cumulative mode it sends the whole keyed history each time, joined with
// stars, as Africa's Talking and several Nigerian aggregators do. In keypress
// mode it sends only the latest key.
export type Screen = { text: string; done: boolean; status: number };

export type DiallerOptions = {
  base: string;
  secret: string;
  style?: "cumulative" | "keypress";
  responseStyle?: "con_end" | "json";
  msisdn?: string;
  serviceCode?: string;
  // Widened to accept an explicit undefined, because one test says "the
  // aggregator told us nothing about the caller's network" and saying that
  // out loud reads better than leaving the key off.
  network?: string | undefined;
  sessionId?: string;
};

export class Dialler {
  readonly sessionId: string;
  readonly msisdn: string;
  private o: Required<Omit<DiallerOptions, "network">> & { network?: string };
  private keyed: string[] = [];
  private lastSent = "";

  constructor(options: DiallerOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.msisdn = options.msisdn ?? "08031234567";
    this.o = {
      base: options.base,
      secret: options.secret,
      style: options.style ?? "cumulative",
      responseStyle: options.responseStyle ?? "con_end",
      msisdn: this.msisdn,
      serviceCode: options.serviceCode ?? "*347*55#",
      sessionId: this.sessionId,
      ...(options.network === undefined ? {} : { network: options.network }),
    };
  }

  // The caller dials the code. Nothing has been keyed yet.
  dial(): Promise<Screen> {
    return this.send("");
  }

  press(key: string): Promise<Screen> {
    this.keyed.push(key);
    return this.send(this.o.style === "cumulative" ? this.keyed.join("*") : key);
  }

  // The aggregator did not hear our answer and asks again with the same
  // keypress. A real network does this on a weak connection.
  retry(): Promise<Screen> {
    return this.send(this.lastSent);
  }

  async send(text: string, options: { secret?: string } = {}): Promise<Screen> {
    this.lastSent = text;
    const body = new URLSearchParams({
      sessionId: this.sessionId,
      phoneNumber: this.msisdn,
      serviceCode: this.o.serviceCode,
      text,
      ...(this.o.network ? { networkCode: this.o.network } : {}),
    });
    const res = await fetch(`${this.o.base}/ussd`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${options.secret ?? this.o.secret}` },
      body: body.toString(),
    });
    return this.read(res);
  }

  // Some aggregators post JSON instead of a form. The endpoint takes either.
  async sendAsJson(text: string): Promise<Screen> {
    this.lastSent = text;
    const res = await fetch(`${this.o.base}/ussd`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.secret}` },
      body: JSON.stringify({ sessionID: this.sessionId, msisdn: this.msisdn, shortCode: this.o.serviceCode, userData: text }),
    });
    return this.read(res);
  }

  private async read(res: Awaited<ReturnType<typeof fetch>>): Promise<Screen> {
    const raw = await res.text();
    if (this.o.responseStyle === "json") {
      try {
        const parsed = JSON.parse(raw) as { message?: string; continueSession?: boolean; error?: string };
        return { text: parsed.message ?? parsed.error ?? raw, done: parsed.continueSession === false, status: res.status };
      } catch {
        return { text: raw, done: true, status: res.status };
      }
    }
    if (raw.startsWith("CON ")) return { text: raw.slice(4), done: false, status: res.status };
    if (raw.startsWith("END ")) return { text: raw.slice(4), done: true, status: res.status };
    return { text: raw, done: true, status: res.status };
  }
}
