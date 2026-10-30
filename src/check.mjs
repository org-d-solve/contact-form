#!/usr/bin/env node
/**
 * Live check of a deployed form: sends one submission in test mode and waits
 * until the mail is in the Zoho folder that a mail rule on the test subject
 * moves it to.
 *
 *   contact-form-check https://example.com
 *   contact-form-check https://example.com --endpoint /api/feedback --data "message=Hi&email=a@b.de"
 *
 * Environment: FORM_TEST_TOKEN (same as the site's), ZOHO_CLIENT_ID,
 * ZOHO_CLIENT_SECRET, ZOHO_READ_REFRESH_TOKEN (scope ZohoMail.messages.READ),
 * ZOHO_ACCOUNT_ID, FORM_CHECK_FOLDER_ID (the test folder). Optional:
 * FORM_CHECK_URL instead of the first argument, ZOHO_DOMAIN (default zoho.eu).
 * Exits 1 on failure.
 */
import { parseArgs } from "node:util";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    endpoint: { type: "string", default: "/api/contact" },
    // Must satisfy the form's required fields. Default fits a contact form.
    data: { type: "string", default: "name=Form check&email=form-check@example.com&message=Automated check&privacy=yes" },
    timeout: { type: "string", default: "90" },
  },
});
const base = positionals[0] ?? process.env.FORM_CHECK_URL;
const zoho = process.env.ZOHO_DOMAIN ?? "zoho.eu";
const required = ["FORM_TEST_TOKEN", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_READ_REFRESH_TOKEN", "ZOHO_ACCOUNT_ID", "FORM_CHECK_FOLDER_ID"];
const missing = required.filter((n) => !process.env[n]);
if (!base) fail("no URL: pass it as the first argument or set FORM_CHECK_URL");
if (missing.length) fail(`missing in the environment: ${missing.join(", ")}`);

// Unique per run, so an old test mail never counts as success.
const id = `form-check-${Date.now()}`;
const start = Date.now();

const response = await fetch(new URL(opts.endpoint, base), {
  method: "POST",
  body: new URLSearchParams(opts.data),
  headers: { "X-Form-Test": process.env.FORM_TEST_TOKEN, "X-Form-Test-Id": id },
  redirect: "manual",
});
if (response.status !== 303 && response.status !== 200) {
  fail(`form answered ${response.status} ${response.headers.get("Location") ?? (await response.text())}`);
}
console.log(`✓ form accepted (${response.status}${response.headers.get("Location") ? ` → ${response.headers.get("Location")}` : ""})`);

const token = await readToken();
while (Date.now() - start < Number(opts.timeout) * 1000) {
  await new Promise((r) => setTimeout(r, 5_000));
  const list = await fetch(
    `https://mail.${zoho}/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages/view?folderId=${process.env.FORM_CHECK_FOLDER_ID}&limit=20`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  ).then((r) => r.json());
  if (!Array.isArray(list.data)) fail(`Zoho list: ${JSON.stringify(list.status ?? list)}`);
  if (list.data.some((m) => m.summary?.includes(id))) {
    console.log(`✓ mail in the test folder after ${Math.round((Date.now() - start) / 1000)} s`);
    process.exit(0);
  }
}
fail(`no mail with ${id} in the test folder after ${opts.timeout} s`);

async function readToken() {
  const r = await fetch(`https://accounts.${zoho}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      refresh_token: process.env.ZOHO_READ_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  }).then((r) => r.json());
  if (!r.access_token) fail(`Zoho token: ${r.error ?? "unknown"}`);
  return r.access_token;
}

function fail(text) {
  console.error(`✖ form check: ${text}`);
  process.exit(1);
}
