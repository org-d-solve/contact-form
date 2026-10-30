// Zoho, Turnstile and KV are faked; nothing goes to the network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFormHandler } from "../src/index.ts";

let calls, turnstileOk, mailStatus, rejectedToken, tokenNo;

beforeEach(() => {
  calls = { turnstile: 0, token: 0, mails: [] };
  turnstileOk = true;
  mailStatus = 200;
  rejectedToken = "";
  tokenNo = 0;
  globalThis.fetch = async (url, init) => {
    if (url.includes("siteverify")) {
      calls.turnstile++;
      return Response.json(turnstileOk ? { success: true } : { success: false, "error-codes": ["invalid-input-secret"] });
    }
    if (url.includes("oauth")) {
      calls.token++;
      return Response.json({ access_token: `tok${++tokenNo}`, expires_in: 3600 });
    }
    const token = init.headers.Authorization.split(" ")[1];
    calls.mails.push({ url, token, ...JSON.parse(init.body) });
    return new Response("", { status: token === rejectedToken ? 401 : mailStatus });
  };
});

const ENV = {
  TURNSTILE_SECRET: "s",
  ZOHO_CLIENT_ID: "c",
  ZOHO_CLIENT_SECRET: "c",
  ZOHO_REFRESH_TOKEN: "r",
  ZOHO_ACCOUNT_ID: "1",
  CONTACT_TO: "contact@example.com",
  FORM_TEST_TOKEN: "secret",
};

const CONTACT = {
  fields: {
    name: { label: "Name", required: true, maxLength: 200 },
    email: { label: "E-Mail", required: true, type: "email" },
    message: { label: "Nachricht", required: true },
    privacy: { required: true, equals: "yes" },
  },
  subject: { de: "Anfrage: {name} <{email}>", en: "Enquiry: {name} <{email}>" },
  redirect: { de: "/thank-you/", en: "/en/thank-you/" },
  errorText: { de: "Fehler, bitte direkt schreiben.", en: "Error, please write directly." },
};

const VALID = { name: "Max", email: "max@example.com", message: "Hallo", privacy: "yes", "cf-turnstile-response": "t" };

function send(config, fields = {}, { env = ENV, headers = {} } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...VALID, ...fields })) if (v !== undefined) form.set(k, v);
  const request = new Request("https://example.com/api/contact", { method: "POST", body: form, headers });
  return createFormHandler(config)({ request, env });
}

function kv() {
  const data = new Map();
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

test("valid submission: mail to CONTACT_TO, redirect to the configured page", async () => {
  const res = await send(CONTACT);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "https://example.com/thank-you/");
  assert.equal(calls.mails.length, 1);
  const mail = calls.mails[0];
  assert.equal(mail.toAddress, "contact@example.com");
  assert.equal(mail.fromAddress, "contact@example.com");
  assert.equal(mail.subject, "Anfrage: Max <max@example.com>");
  assert.equal(mail.content, "Name: Max\nE-Mail: max@example.com\nNachricht: Hallo\nprivacy: yes");
});

test("the address typed into the form is never the recipient", async () => {
  await send(CONTACT, { email: "victim@example.org" });
  assert.ok(calls.mails.every((m) => m.toAddress === ENV.CONTACT_TO));
});

test("to and from from the config override CONTACT_TO; the error text names the recipient", async () => {
  const feedback = { fields: { message: { required: true } }, to: "feedback@example.com", from: "noreply@example.com" };
  await send(feedback);
  assert.equal(calls.mails[0].toAddress, "feedback@example.com");
  assert.equal(calls.mails[0].fromAddress, "noreply@example.com");
  mailStatus = 500;
  assert.match(await (await send(feedback)).text(), /feedback@example\.com/);
});

test("two forms on one site send to their own recipients", async () => {
  await send({ fields: { message: {} }, to: "contact@example.com" });
  await send({ fields: { message: {} }, to: "feedback@example.com" });
  assert.deepEqual(calls.mails.map((m) => m.toAddress), ["contact@example.com", "feedback@example.com"]);
});

test("language field selects subject and redirect; unknown language falls back to the first entry", async () => {
  const en = await send(CONTACT, { lang: "en" });
  assert.equal(en.headers.get("Location"), "https://example.com/en/thank-you/");
  assert.equal(calls.mails[0].subject, "Enquiry: Max <max@example.com>");
  const fr = await send(CONTACT, { lang: "fr" });
  assert.equal(fr.headers.get("Location"), "https://example.com/thank-you/");
});

test("defaults without texts: subject and error text name the host and CONTACT_TO, success as text", async () => {
  const config = { fields: { message: { required: true } } };
  const ok = await send(config);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Thank you/);
  assert.equal(calls.mails[0].subject, "Form submission via example.com");
  turnstileOk = false;
  assert.match(await (await send(config)).text(), /contact@example\.com/);
});

test("successText instead of a redirect", async () => {
  const res = await send({ fields: { message: {} }, successText: "Danke für Ihr Feedback." });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "Danke für Ihr Feedback.");
});

test("a redirect that is not a same-origin path is ignored", async () => {
  for (const redirect of ["https://evil.example/", "//evil.example/"]) {
    const res = await send({ fields: { message: {} }, redirect });
    assert.equal(res.status, 200);
  }
});

test("only configured fields reach the mail; multi-line values start on their own line", async () => {
  await send({ fields: { message: { label: "Feedback" } } }, { message: "a\nb", extra: "ignored" });
  assert.equal(calls.mails[0].content, "Feedback:\na\nb");
});

test("line breaks in a field do not break the subject", async () => {
  await send({ ...CONTACT, subject: "From {name}" }, { name: "Max\nBcc: x" });
  assert.equal(calls.mails[0].subject, "From Max Bcc: x");
});

test("honeypot: success answer, but no mail and no Turnstile call", async () => {
  const res = await send(CONTACT, { _honey: "bot" });
  assert.equal(res.status, 303);
  assert.equal(calls.mails.length, 0);
  assert.equal(calls.turnstile, 0);
});

for (const [name, fields] of [
  ["required field empty", { name: "" }],
  ["invalid email", { email: "no-at" }],
  ["whitespace only", { message: " " }],
  ["consent missing", { privacy: undefined }],
]) {
  test(`invalid (${name}): 400 with the configured error text, no mail`, async () => {
    const res = await send(CONTACT, fields);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /^Fehler, bitte direkt schreiben\.\n\n\(400: field \w+\)$/);
    assert.equal(calls.mails.length, 0);
  });
}

test("optional fields may stay empty, but are checked when filled", async () => {
  const config = { fields: { message: { required: true }, email: { type: "email" }, newsletter: { equals: "yes" } } };
  assert.equal((await send(config, { email: undefined, newsletter: undefined })).status, 200);
  assert.equal((await send(config, { email: "bad" })).status, 400);
  assert.equal((await send(config, { newsletter: "maybe" })).status, 400);
});

test("long input is cut to maxLength", async () => {
  await send(CONTACT, { name: "x".repeat(500) });
  assert.match(calls.mails[0].content, /^Name: x{200}\n/);
});

test("Turnstile rejected: 400 with the error code, no mail", async () => {
  turnstileOk = false;
  const res = await send(CONTACT);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /\(400: turnstile invalid-input-secret\)$/);
  assert.equal(calls.mails.length, 0);
});

test("Zoho error: 502 with the step, without Zoho's answer", async () => {
  mailStatus = 500;
  const res = await send(CONTACT);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /\(502: Zoho-Mail: 500\)$/);
});

test("test mode: right header skips Turnstile, fixed subject, test id as first line", async () => {
  turnstileOk = false;
  const res = await send(CONTACT, {}, { headers: { "X-Form-Test": "secret", "X-Form-Test-Id": "run-1" } });
  assert.equal(res.status, 303);
  assert.equal(calls.turnstile, 0);
  assert.equal(calls.mails[0].subject, "Testmail form logic");
  assert.match(calls.mails[0].content, /^Test-ID: run-1\n/);
});

test("test mode: wrong header or no token configured changes nothing", async () => {
  turnstileOk = false;
  assert.equal((await send(CONTACT, {}, { headers: { "X-Form-Test": "wrong" } })).status, 400);
  const { FORM_TEST_TOKEN, ...withoutToken } = ENV;
  assert.equal((await send(CONTACT, {}, { env: withoutToken, headers: { "X-Form-Test": "" } })).status, 400);
  assert.equal(calls.mails.length, 0);
});

test("zohoDomain selects the data centre", async () => {
  await send({ ...CONTACT, zohoDomain: "zoho.com" });
  assert.match(calls.mails[0].url, /^https:\/\/mail\.zoho\.com\//);
});

test("without KV: one token per submission", async () => {
  await send(CONTACT);
  await send(CONTACT);
  assert.equal(calls.token, 2);
});

test("with KV: one token for several submissions", async () => {
  const cache = kv();
  const env = { ...ENV, ZOHO_TOKEN_CACHE: cache };
  for (let i = 0; i < 3; i++) assert.equal((await send(CONTACT, {}, { env })).status, 303);
  assert.equal(calls.token, 1);
  assert.equal(cache.data.get("zoho_access_token"), "tok1");
});

test("with KV: a revoked token is replaced once", async () => {
  const cache = kv();
  const env = { ...ENV, ZOHO_TOKEN_CACHE: cache };
  await send(CONTACT, {}, { env });
  rejectedToken = "tok1";
  assert.equal((await send(CONTACT, {}, { env })).status, 303);
  assert.equal(cache.data.get("zoho_access_token"), "tok2");
  assert.deepEqual(calls.mails.map((m) => m.token), ["tok1", "tok1", "tok2"]);
});
