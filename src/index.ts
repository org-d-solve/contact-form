// Form-to-mail backend for a Cloudflare Pages Function: checks honeypot,
// Turnstile and the configured fields, then sends the submission through the
// Zoho Mail API. Recipient and sender come from the configuration, never from
// the form, so the endpoint cannot relay spam to addresses typed into it.
//
// One file per form; each form has its own fields, texts and recipient:
//
//   // functions/api/contact.ts  →  POST /api/contact
//   import { createFormHandler } from "contact-form";
//   export const onRequestPost = createFormHandler({ fields: { ... }, to: "contact@example.com" });
//
//   // functions/api/feedback.ts  →  POST /api/feedback
//   export const onRequestPost = createFormHandler({ fields: { ... }, to: "feedback@example.com" });

/** A text, or one text per language keyed by the value of the language field.
 *  The first entry is the fallback for unknown languages. */
export type Localized = string | Record<string, string>;

export interface FieldRule {
  /** Shown in the mail in front of the value. Default: the field name. */
  label?: string;
  required?: boolean;
  /** "email" checks the format. */
  type?: "text" | "email";
  /** Value must be exactly this, e.g. "yes" for a consent checkbox. */
  equals?: string;
  /** Longer input is cut off. Default 10,000. */
  maxLength?: number;
}

export interface FormConfig {
  /** Fields in the order they appear in the mail. Other form fields are ignored. */
  fields: Record<string, FieldRule>;
  /** Recipient of the mail. Default: env CONTACT_TO. */
  to?: string;
  /** Sender; must be the Zoho mailbox's address or one of its aliases. Default: env CONTACT_TO. */
  from?: string;
  /** Mail subject; {field} is replaced by that field's value, {host} by the site's host.
   *  Default: "Form submission via {host}". */
  subject?: Localized;
  /** Same-origin path to redirect to after success, e.g. "/thank-you/".
   *  Without it the response is successText. */
  redirect?: Localized;
  /** Plain-text answer after success when there is no redirect. */
  successText?: Localized;
  /** Plain-text answer when sending fails. Default names CONTACT_TO. */
  errorText?: Localized;
  /** Form field that selects the language of all Localized texts. Default "lang". */
  languageField?: string;
  /** Hidden field that only bots fill in. Default "_honey". */
  honeypotField?: string;
  /** Fixed subject in test mode, for a mail rule. Default "Testmail form logic". */
  testSubject?: string;
  /** Zoho data centre domain. Default "zoho.eu". */
  zohoDomain?: string;
}

export interface FormEnv {
  TURNSTILE_SECRET: string;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REFRESH_TOKEN: string;
  ZOHO_ACCOUNT_ID: string;
  /** Default sender and recipient when the form config sets no to/from;
   *  must be an address or alias of the Zoho mailbox. */
  CONTACT_TO: string;
  /** Enables test mode: header X-Form-Test with this value skips Turnstile. */
  FORM_TEST_TOKEN?: string;
  /** Optional KV binding; without it a new access token is fetched per submission. */
  ZOHO_TOKEN_CACHE?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_KEY = "zoho_access_token";

export function createFormHandler(config: FormConfig) {
  const languageField = config.languageField ?? "lang";
  const honeypotField = config.honeypotField ?? "_honey";
  const zoho = config.zohoDomain ?? "zoho.eu";

  return async ({ request, env }: { request: Request; env: FormEnv }) => {
    const form = await request.formData();
    // Browsers send line breaks in form data as CRLF.
    const field = (name: string) => String(form.get(name) ?? "").replace(/\r\n?/g, "\n").trim();
    const pick = (text: Localized | undefined) => localized(text, field(languageField));
    const host = new URL(request.url).host;
    const to = config.to ?? env.CONTACT_TO;
    const from = config.from ?? env.CONTACT_TO;
    const fail = (status: number, reason: string) =>
      plain(
        `${pick(config.errorText) ?? `Your message could not be sent. Please write to ${to}.`}\n\n(${status}: ${reason})`,
        status,
      );
    const success = () => {
      const path = pick(config.redirect);
      // Same origin only, so a misconfigured path can never redirect elsewhere.
      if (path?.startsWith("/") && !path.startsWith("//")) return Response.redirect(new URL(path, request.url), 303);
      return plain(pick(config.successText) ?? "Thank you, your message has been sent.", 200);
    };

    // Test mode for the live check: a script cannot solve Turnstile, and the
    // fixed subject lets a mail rule file the result away.
    const test = Boolean(env.FORM_TEST_TOKEN) && request.headers.get("X-Form-Test") === env.FORM_TEST_TOKEN;

    // Bots get the normal success answer, so they do not learn what failed.
    if (field(honeypotField)) return success();

    const values: Record<string, string> = {};
    for (const [name, rule] of Object.entries(config.fields)) {
      const value = field(name).slice(0, rule.maxLength ?? 10_000);
      if (rule.required && !value) return fail(400, `field ${name}`);
      if (value && rule.type === "email" && !EMAIL.test(value)) return fail(400, `field ${name}`);
      if (rule.equals !== undefined && value !== rule.equals && (rule.required || value)) return fail(400, `field ${name}`);
      values[name] = value;
    }

    if (!test) {
      const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: field("cf-turnstile-response"),
          remoteip: request.headers.get("CF-Connecting-IP") ?? "",
        }),
      }).then((r) => r.json() as Promise<{ success: boolean; "error-codes"?: string[] }>);
      if (!result.success) {
        console.error("Turnstile rejected:", result["error-codes"]);
        return fail(400, `turnstile ${result["error-codes"]?.join(",") ?? ""}`.trim());
      }
    }

    const subject = test
      ? (config.testSubject ?? "Testmail form logic")
      : fillIn(pick(config.subject) ?? "Form submission via {host}", { ...values, host });
    const lines = Object.entries(values)
      .filter(([, value]) => value)
      .map(([name, value]) => {
        const label = config.fields[name].label ?? name;
        return value.includes("\n") ? `${label}:\n${value}` : `${label}: ${value}`;
      });
    if (test) lines.unshift(`Test-ID: ${request.headers.get("X-Form-Test-Id") ?? "-"}`);

    try {
      await sendMail(env, zoho, { from, to, subject, content: lines.join("\n") });
    } catch (e) {
      console.error(e);
      return fail(502, e instanceof Error ? e.message.split(" ").slice(0, 2).join(" ") : "zoho");
    }
    return success();
  };
}

function localized(text: Localized | undefined, language: string) {
  if (text === undefined || typeof text === "string") return text;
  return text[language] ?? Object.values(text)[0];
}

/** Replaces {name} with the value; line breaks are removed, since the result is a subject. */
function fillIn(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (values[name] ?? "").replace(/\s+/g, " "));
}

function plain(text: string, status: number) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

type Mail = { from: string; to: string; subject: string; content: string };

async function sendMail(env: FormEnv, zoho: string, mail: Mail) {
  let response = await sendWithToken(env, zoho, mail, await accessToken(env, zoho));
  // A cached token can become invalid early (revoked, replaced). Retry once with a fresh one.
  if (response.status === 401) response = await sendWithToken(env, zoho, mail, await accessToken(env, zoho, true));
  if (!response.ok) throw new Error(`Zoho-Mail: ${response.status} ${await response.text()}`);
}

// Zoho issues only about ten access tokens per refresh token in ten minutes.
// A token is valid for an hour, so it is kept in KV and reused.
async function accessToken(env: FormEnv, zoho: string, fresh = false) {
  const cache = env.ZOHO_TOKEN_CACHE;
  if (cache && !fresh) {
    const cached = await cache.get(TOKEN_KEY);
    if (cached) return cached;
  }
  const token = await fetch(`https://accounts.${zoho}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  }).then((r) => r.json() as Promise<{ access_token?: string; expires_in?: number; error?: string }>);
  if (!token.access_token) throw new Error(`Zoho-Token: ${token.error ?? "unknown"}`);
  // Dropped five minutes early, so no token expires in the middle of sending.
  if (cache) await cache.put(TOKEN_KEY, token.access_token, { expirationTtl: (token.expires_in ?? 3600) - 300 });
  return token.access_token;
}

function sendWithToken(env: FormEnv, zoho: string, mail: Mail, token: string) {
  return fetch(`https://mail.${zoho}/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fromAddress: mail.from,
      toAddress: mail.to,
      subject: mail.subject,
      content: mail.content,
      mailFormat: "plaintext",
    }),
  });
}
