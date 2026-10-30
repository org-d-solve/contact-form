# contact-form

Form-to-mail backend for static sites on Cloudflare Pages. A plain HTML form
posts to a Pages Function; the function checks a honeypot, Cloudflare
Turnstile and the configured fields, then sends the submission through the
Zoho Mail API. Contact forms, feedback forms, sign-ups: any form whose result
is one mail.

Recipient and sender come from the configuration, never from the form, so the
endpoint cannot be used to send mail to third parties. That also means there
is no auto-reply to the person who filled in the form.

## Use

```bash
npm install github:org-d-solve/contact-form#v1.0.0
```

One file per form under `functions/`; the file path is the URL.

```ts
// functions/api/contact.ts  →  POST /api/contact
import { createFormHandler } from "contact-form";

export const onRequestPost = createFormHandler({
  to: "contact@example.com",
  fields: {
    name: { label: "Name", required: true, maxLength: 200 },
    email: { label: "E-Mail", required: true, type: "email" },
    message: { label: "Nachricht", required: true },
    privacy: { required: true, equals: "yes" },
  },
  subject: { de: "Anfrage: {name} <{email}>", en: "Enquiry: {name} <{email}>" },
  redirect: { de: "/thank-you/", en: "/en/thank-you/" },
  errorText: {
    de: "Ihre Nachricht konnte nicht gesendet werden. Bitte schreiben Sie an contact@example.com.",
    en: "Your message could not be sent. Please write to contact@example.com.",
  },
});
```

```ts
// functions/api/feedback.ts  →  POST /api/feedback
import { createFormHandler } from "contact-form";

export const onRequestPost = createFormHandler({
  to: "feedback@example.com",
  fields: { message: { label: "Feedback", required: true }, page: { label: "Seite" } },
  subject: "Feedback zu {page}",
  successText: "Danke für Ihr Feedback.",
});
```

The form:

```html
<form action="/api/contact" method="POST">
  <input type="hidden" name="lang" value="de" />
  <input type="text" name="_honey" tabindex="-1" autocomplete="off" hidden />
  <!-- your fields, named like the keys in `fields` -->
  <div class="cf-turnstile" data-sitekey="<site key>"></div>
  <button type="submit">Senden</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `fields` | required | Field name → rule: `label`, `required`, `type: "email"`, `equals` (e.g. `"yes"` for a checkbox), `maxLength` (10,000). Order = order in the mail. Other form fields are ignored. |
| `to` | env `CONTACT_TO` | Recipient. Any address. |
| `from` | env `CONTACT_TO` | Sender. Must be the Zoho mailbox's address or one of its aliases. |
| `subject` | `Form submission via {host}` | `{field}` is replaced by the field's value, `{host}` by the site's host. |
| `redirect` | — | Same-origin path after success. Other values are ignored. |
| `successText` | `Thank you, your message has been sent.` | Plain-text answer after success when there is no `redirect`. |
| `errorText` | `Your message could not be sent. Please write to <to>.` | Plain-text answer on failure; the failed step is appended, e.g. `(400: turnstile invalid-input-secret)`. |
| `languageField` | `lang` | Form field that picks the language for all texts. |
| `honeypotField` | `_honey` | Hidden field only bots fill in; they get the normal success answer. |
| `testSubject` | `Testmail form logic` | Fixed subject in test mode. |
| `zohoDomain` | `zoho.eu` | Zoho data centre (`zoho.com`, `zoho.in`, …). |

`subject`, `redirect`, `successText` and `errorText` take a string or one
string per language, `{ de: "…", en: "…" }`; the first entry is the fallback.

## Environment of the Pages project

Set for Production and Preview under Settings → Variables and Secrets; they
apply from the next deploy on. All forms of a site share them.

| Name | Type | Value |
|---|---|---|
| `TURNSTILE_SECRET` | Secret | secret key of the site's Turnstile widget |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | Secret | Zoho Self Client |
| `ZOHO_REFRESH_TOKEN` | Secret | refresh token with scope `ZohoMail.messages.CREATE` |
| `ZOHO_ACCOUNT_ID` | Text | the Zoho mail account ID |
| `CONTACT_TO` | Text | default recipient and sender |
| `FORM_TEST_TOKEN` | Secret | optional, random (`openssl rand -hex 32`); enables test mode |

Binding (Settings → Bindings → KV namespace), optional: `ZOHO_TOKEN_CACHE`, a
KV namespace per site. Zoho issues only about ten access tokens per refresh
token in ten minutes; with the binding one token is reused for its hour.

## Setup per site

1. **Turnstile:** Cloudflare dashboard → Turnstile → Add widget, mode
   "Managed", hostnames: the domain, `pages.dev` (previews), `localhost`,
   `127.0.0.1`. Site key into the form, secret key into `TURNSTILE_SECRET`.
2. **Zoho refresh token:** <https://api-console.zoho.eu> → Self Client (one
   per Zoho account). "Generate Code" with scope `ZohoMail.messages.CREATE`,
   then within its lifetime:

   ```bash
   curl -s -X POST https://accounts.zoho.eu/oauth/v2/token \
     -d grant_type=authorization_code -d code=<CODE> \
     -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET>
   ```

   Use a separate refresh token per site, so one can be revoked alone. It
   does not expire until revoked.
3. **KV:** Workers & Pages → KV → Create namespace, bind it as
   `ZOHO_TOKEN_CACHE`.
4. **Environment** as in the table above.

## Testing

`npm test` in this repository: the handler with Zoho, Turnstile and KV faked.

Live check of a deployed form: a request with header
`X-Form-Test: <FORM_TEST_TOKEN>` skips Turnstile (a script cannot solve it)
and gets the fixed `testSubject`; a Zoho mail rule moves it into a test
folder. The bundled command sends one such request and waits for the mail:

```bash
npx contact-form-check https://example.com [--endpoint /api/feedback] [--data "message=Hi"]
```

It reads `FORM_TEST_TOKEN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
`ZOHO_READ_REFRESH_TOKEN` (a second refresh token with scope
`ZohoMail.messages.READ`), `ZOHO_ACCOUNT_ID` and `FORM_CHECK_FOLDER_ID` from
the environment and exits 1 if no mail arrives within 90 s. `--data` must
satisfy the form's required fields.

Previews behind Cloudflare Access cannot be reached by the script.

## When it breaks

The answer ends with the failed step. Details: Pages project → Deployments →
the deployment → Functions → Real-time logs (live only).

| Step | Cause |
|---|---|
| `400: field <name>` | field missing or invalid |
| `400: turnstile missing-input-secret` | `TURNSTILE_SECRET` not set in this environment |
| `400: turnstile invalid-input-secret` | secret belongs to another widget, or the site key was pasted |
| `502: Zoho-Token: …` | refresh token revoked or client wrong: new refresh token |
| `502: Zoho-Mail: 4xx` | account ID, `from` not an alias of the mailbox, or scope missing |

## Changing this package

Change, `npm test`, raise `version` in `package.json`, tag `vX.Y.Z`, push the
tag. Sites move to the new version by changing the tag in their dependency.
