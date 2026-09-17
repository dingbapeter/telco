import type pg from "pg";
import { describeSize, listBundles, parseSizeMb, sizeFromName, upsertBundle, validityFromName, type Bundle } from "../bundles.ts";
import { withActor } from "../db.ts";
import { UserFacingError } from "../errors.ts";
import { railFromEnv } from "../rails/rail.ts";
import { NETWORK_CODES, type NetworkCode } from "../settings.ts";
import { html, notice, page, type Html } from "../web/html.ts";
import type { App, Request } from "../web/http.ts";
import { actor, csrf, money, nairaField, requiredField } from "./shared.ts";

async function bundlesPage(req: Request, db: pg.Pool, message?: Html, status = 200): Promise<{ kind: "html"; status: number; body: string }> {
  const bundles = await listBundles(db);
  const rail = railFromEnv();
  const body = html`<h1>Data bundles</h1>${message ?? ""}
    <p class="muted">Every bundle we deliver, sell or accept as a gift is here with its price. Value moves at that price. "Giftable" means a sender can gift that bundle to our SIM on that network and we will value it at the price shown. A provider code lets the provider deliver it without a person.</p>
    ${rail
      ? html`<form method="post" action="/admin/bundles/fetch" class="panel">${csrf(req)}
          <p><strong>Fetch the provider's list.</strong> Adds every data bundle ${rail.name} sells, with its price and code. Bundles you have edited by hand keep your price and name; only their provider code is filled in.</p>
          <div class="row"><div><label for="fnet">Network</label><select id="fnet" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
          <div><label>&nbsp;</label><button type="submit" class="secondary">Fetch from ${rail.name}</button></div></div></form>`
      : html`<p class="muted">With the provider's keys on the server, this page can fetch its bundle list. Until then, add bundles by hand below.</p>`}
    <div class="scroll"><table>
      <tr><th>Network</th><th>Code</th><th>Name</th><th class="num">Size</th><th>Validity</th><th class="num">Price</th><th>Provider code</th><th>Giftable</th><th>Active</th><th>Source</th><th></th></tr>
      ${bundles.map(
        (b) => html`<tr><td>${b.network_code}</td><td><code>${b.code}</code></td><td>${b.name}</td><td class="num">${describeSize(b.size_mb)}</td><td>${b.validity_days ? `${b.validity_days} days` : ""}</td>
          <td class="num">${money(b.price_kobo)}</td><td>${b.provider_variation_code ?? html`<span class="muted">none</span>`}</td><td>${b.giftable ? "yes" : "no"}</td><td>${b.active ? "yes" : "no"}</td><td>${b.source}</td>
          <td class="actions"><form method="post" action="/admin/bundles/${b.id}/toggle/active" class="inline">${csrf(req)}<button type="submit" class="secondary">${b.active ? "Pause" : "Activate"}</button></form>
            <form method="post" action="/admin/bundles/${b.id}/toggle/giftable" class="inline">${csrf(req)}<button type="submit" class="secondary">${b.giftable ? "Not giftable" : "Giftable"}</button></form></td></tr>`,
      )}
      ${bundles.length === 0 ? html`<tr><td colspan="11" class="muted">No bundles yet.</td></tr>` : ""}
    </table></div>
    <h2>Add or update a bundle by hand</h2>
    <form method="post" action="/admin/bundles" class="panel">${csrf(req)}
      <div class="row">
        <div><label for="network">Network</label><select id="network" name="network">${NETWORK_CODES.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
        <div><label for="code">Code <span class="hint">short and unique per network, like mtn-1gb-30d</span></label><input id="code" name="code" type="text" required></div>
      </div>
      <div class="row">
        <div><label for="name">Name as the sender sees it</label><input id="name" name="name" type="text" required></div>
        <div><label for="size">Size <span class="hint">like 1GB or 500MB</span></label><input id="size" name="size" type="text" required></div>
      </div>
      <div class="row">
        <div><label for="validity">Validity in days <span class="hint">empty if unknown</span></label><input id="validity" name="validity" type="text" inputmode="numeric"></div>
        <div><label for="price">Price in naira</label><input id="price" name="price" type="text" inputmode="decimal" required></div>
      </div>
      <div class="row">
        <div><label for="variation">Provider code <span class="hint">empty if the provider does not sell it</span></label><input id="variation" name="variation" type="text"></div>
        <div><label for="giftable">Giftable to our SIM</label><select id="giftable" name="giftable"><option value="no">No</option><option value="yes">Yes</option></select></div>
      </div>
      <button type="submit">Save bundle</button>
    </form>`;
  return { kind: "html", status, body: page({ title: "Data bundles", admin: req.admin, current: "/admin/bundles", body }) };
}

export function registerBundles(app: App): void {
  app.get("/admin/bundles", (req, db) => bundlesPage(req, db));

  app.post("/admin/bundles", async (req, db) => {
    try {
      const sizeMb = parseSizeMb(requiredField(req.form, "size", "Size"));
      if (!sizeMb) throw new UserFacingError("bundle_size", "Write the size like 1GB or 500MB.");
      const validityText = (req.form.get("validity") ?? "").trim();
      const validity = validityText === "" ? null : Number(validityText);
      if (validity !== null && (!Number.isInteger(validity) || validity <= 0)) throw new UserFacingError("bundle_validity", "Validity should be a whole number of days, or empty.");
      const b = await withActor(actor(req.admin), (c) =>
        upsertBundle(c, {
          network: requiredField(req.form, "network", "Network"),
          code: requiredField(req.form, "code", "Code"),
          name: requiredField(req.form, "name", "Name"),
          sizeMb,
          validityDays: validity,
          priceKobo: nairaField(req.form, "price", "Price"),
          providerVariationCode: (req.form.get("variation") ?? "").trim() || null,
          giftable: req.form.get("giftable") === "yes",
        }),
        db,
      );
      return bundlesPage(req, db, notice("ok", `${b.name} on ${b.network_code} is saved at ${money(b.price_kobo)}.`));
    } catch (err) {
      if (err instanceof UserFacingError) return bundlesPage(req, db, notice("problem", err.message), 400);
      throw err;
    }
  });

  app.post("/admin/bundles/:id/toggle/:field", async (req, db) => {
    const field = req.query.get("field") === "giftable" ? "giftable" : "active";
    const { rows } = await withActor(actor(req.admin), (c) => c.query<Bundle>(`UPDATE data_bundles SET ${field} = NOT ${field}, updated_at = now() WHERE id = $1 RETURNING *`, [Number(req.query.get("id"))]), db);
    if (!rows[0]) return bundlesPage(req, db, notice("problem", "That bundle is not in the list."), 404);
    const b = rows[0];
    return bundlesPage(req, db, notice("ok", field === "active" ? `${b.name} is now ${b.active ? "active" : "paused"}.` : `${b.name} is now ${b.giftable ? "giftable" : "not giftable"}.`));
  });

  // A real call to the provider, whose list becomes catalogue entries.
  app.post("/admin/bundles/fetch", async (req, db) => {
    const rail = railFromEnv();
    if (!rail) return bundlesPage(req, db, notice("problem", "The provider's keys are not on the server, so there is nothing to fetch from."), 400);
    const network = requiredField(req.form, "network", "Network").toUpperCase() as NetworkCode;
    if (!(NETWORK_CODES as readonly string[]).includes(network)) return bundlesPage(req, db, notice("problem", "Choose a network."), 400);
    let list;
    try {
      list = await rail.listDataBundles(network);
    } catch (err) {
      return bundlesPage(req, db, notice("problem", `${(err as Error).message} Check the launch checklist for the provider's state.`), 502);
    }
    let added = 0;
    let skipped = 0;
    await withActor(actor(req.admin), async (c) => {
      for (const v of list) {
        const sizeMb = sizeFromName(v.name);
        if (!sizeMb) {
          skipped += 1;
          continue;
        }
        await upsertBundle(c, { network, code: v.variationCode, name: v.name, sizeMb, validityDays: validityFromName(v.name), priceKobo: v.priceKobo, providerVariationCode: v.variationCode, source: "vtpass" });
        added += 1;
      }
    }, db);
    return bundlesPage(req, db, notice("ok", `${rail.name} lists ${list.length} ${network} bundle(s): ${added} saved${skipped > 0 ? `, ${skipped} skipped because no size could be read from their names` : ""}.`));
  });
}
