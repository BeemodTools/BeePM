/**
 * The few web pages the server shows during login and account linking.
 * They copy the desktop app's look (its MUI theme: #1d1e1f background, #2a2d30 panels,
 * #3a3a3a borders, #2eff7b accent). Every interpolated value goes through html``.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c])

class Html {
    constructor(text) {
        this.text = text
    }
    toString() {
        return this.text
    }
}
const raw = (text) => new Html(text)

/** Tagged template that escapes interpolations (arrays are joined, Html is kept as is). */
export function html(strings, ...values) {
    let out = strings[0]
    values.forEach((value, i) => {
        const render = (v) => (v instanceof Html ? v.text : escape(v))
        out += Array.isArray(value) ? value.map(render).join("") : render(value)
        out += strings[i + 1]
    })
    return raw(out)
}

// 24x24 icon paths: MUI icons (as in the app) and the Discord logo (Simple Icons)
const ICONS = {
    github: "M12 1.27a11 11 0 00-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2 2 0 01.64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 010-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 010 2.93c.83.74 1.2 1.74 1.2 2.94 0 4.21-2.57 5.13-5.04 5.4.45.37.82.92.82 2.02v3.03c0 .27.1.64.73.55A11 11 0 0012 1.27",
    discord:
        "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
    dev: "M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m-9-2V7H4v3H1v2h3v3h2v-3h3v-2zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4",
    success:
        "M16.59 7.58 10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8",
    error: "M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8",
    cancel: "M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2m5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12z",
    login: "M11 7 9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8z",
}

const icon = (name, size = 20) =>
    raw(
        `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${ICONS[name]}"/></svg>`,
    )

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #1d1e1f; color: #c3c7c9;
  font-family: "Roboto", "Helvetica", "Arial", sans-serif; font-size: 1rem; line-height: 1.5;
  -webkit-font-smoothing: antialiased; }
.topbar { height: 56px; display: flex; align-items: center; padding: 0 20px;
  background: #232526; border-bottom: 1px solid #3a3a3a; }
.brand { font-size: 1.5rem; font-weight: 700; line-height: 1; color: #fff; letter-spacing: 0; }
.brand span { color: #2eff7b; }
main { display: flex; justify-content: center; padding: 48px 16px; }
.card { width: 100%; max-width: 460px; background: #2a2d30; border: 1px solid #3a3a3a;
  border-radius: 12px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); overflow: hidden; }
.card-title { padding: 16px 24px; border-bottom: 1px solid #3a3a3a; font-size: 1.25rem;
  font-weight: 600; color: #e0e0e0; }
.card-body { padding: 24px; }
.card-actions { display: flex; justify-content: flex-end; align-items: center; gap: 12px;
  padding: 16px 24px 24px; border-top: 1px solid #3a3a3a; }
.card-actions form { margin: 0; }
p { margin: 0 0 16px; }
.muted { color: #888; font-size: 0.875rem; line-height: 1.43; }
strong { color: #e0e0e0; font-weight: 600; }
.subtitle { margin: 0 0 8px; color: #b0b0b0; font-size: 0.75rem; font-weight: 600;
  letter-spacing: 0.5px; text-transform: uppercase; }
.code { margin: 0 0 8px; padding: 16px; text-align: center; background: #1a1b1c;
  border: 1px solid #3a3a3a; border-radius: 8px; color: #2eff7b; font-weight: 600;
  font-size: 1.75rem; letter-spacing: 3px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
.code-small { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; color: #2eff7b; font-weight: 600; letter-spacing: 1px; }
.stack { display: grid; gap: 12px; margin-top: 24px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px;
  padding: 6px 16px; border-radius: 6px; border: 1px solid transparent; background: transparent;
  font: inherit; font-size: 0.875rem; font-weight: 500; letter-spacing: 0.02857em; line-height: 1.75;
  text-decoration: none; text-transform: none; cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s, box-shadow 0.2s; }
.btn:focus-visible { outline: 2px solid #2eff7b; outline-offset: 2px; }
.btn.contained { background: #2eff7b; color: rgba(0, 0, 0, 0.87); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }
.btn.contained:hover { background: #25cc62; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); }
.btn.text { color: #aaa; }
.btn.text:hover { background: rgba(255, 255, 255, 0.08); }
.btn.provider { width: 100%; min-height: 44px; justify-content: flex-start; padding: 8px 16px;
  border-color: #555; color: #e0e0e0; font-size: 0.9375rem; }
.btn.provider:hover { border-color: #2eff7b; background: rgba(46, 255, 123, 0.08); }
.btn.provider .icon { color: #e0e0e0; }
.who { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 20px;
  background: #1a1b1c; border: 1px solid #3a3a3a; border-radius: 8px; }
.who img, .avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
.avatar { display: grid; place-items: center; background: #3a3a3a; color: #c3c7c9; }
.who .name { color: #fff; font-weight: 600; line-height: 1.3; }
.who .sub { display: flex; align-items: center; gap: 6px; color: #888; font-size: 0.875rem; }
.field { margin-bottom: 8px; }
.input { display: flex; align-items: center; border: 1px solid #555; border-radius: 8px;
  transition: border-color 0.2s; }
.input:hover { border-color: #777; }
.input:focus-within { border-color: #2eff7b; box-shadow: inset 0 0 0 1px #2eff7b; }
.input span { padding-left: 14px; color: #888; }
.input input { flex: 1; min-width: 0; padding: 12px 14px 12px 4px; border: 0; outline: none;
  background: transparent; color: #c3c7c9; font: inherit; }
.input.plain input { padding-left: 14px; }
.alert { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 16px; padding: 10px 14px;
  border-radius: 8px; font-size: 0.875rem; line-height: 1.43; }
.alert .icon { flex-shrink: 0; margin-top: 1px; }
.alert.error { background: rgba(211, 47, 47, 0.12); border: 1px solid rgba(211, 47, 47, 0.4); color: #f4c7c7; }
.alert.error .icon { color: #f44336; }
.alert.info { background: rgba(46, 255, 123, 0.08); border: 1px solid rgba(46, 255, 123, 0.3); color: #c3c7c9; }
.alert.info .icon { color: #2eff7b; }
.status { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 16px 8px 8px; }
.status .circle { width: 80px; height: 80px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 24px; }
.status .circle.success { background: rgba(46, 255, 123, 0.1); color: #2eff7b; }
.status .circle.error { background: rgba(211, 47, 47, 0.1); color: #d32f2f; }
.status .circle.neutral { background: rgba(255, 255, 255, 0.06); color: #888; }
.status h1 { margin: 0 0 8px; color: #fff; font-size: 1.5rem; font-weight: 600; line-height: 1.33; }
.status p { margin: 0 0 8px; color: #888; max-width: 400px; }
.status .btn { margin-top: 16px; min-width: 200px; }
`

/** Wraps page content in the shared layout. */
function layout(title, content) {
    return html`<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <meta name="referrer" content="no-referrer" />
                <title>${title} · BeePM</title>
                <style>
                    ${raw(STYLE)}
                </style>
            </head>
            <body>
                <header class="topbar">
                    <div class="brand">Bee<span>PM</span></div>
                </header>
                <main>${content}</main>
            </body>
        </html>`.text
}

/** A dialog-style card: title bar, body, and an optional action bar. */
export function page(title, body, actions = null) {
    return layout(
        title,
        html`<section class="card">
            <div class="card-title">${title}</div>
            <div class="card-body">${body}</div>
            ${actions ? html`<div class="card-actions">${actions}</div>` : ""}
        </section>`,
    )
}

/** A centered status card like the app's empty/blocked screens. */
function statusPage(title, message, kind, extra = "") {
    const iconName = kind === "success" ? "success" : kind === "error" ? "error" : "cancel"
    return layout(
        title,
        html`<section class="card">
            <div class="card-body">
                <div class="status">
                    <div class="circle ${kind}">${icon(iconName, 40)}</div>
                    <h1>${title}</h1>
                    ${message ? html`<p>${message}</p>` : ""} ${extra}
                </div>
            </div>
        </section>`,
    )
}

/** Security headers for every page: no framing (protects the Allow button), no caching. */
export const PAGE_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}

export const messagePage = (title, message, { error = false } = {}) =>
    statusPage(title, message, error ? "error" : "neutral")

const PROVIDER_ICON = { discord: "discord", github: "github", dev: "dev" }

function codeBlock(session) {
    return html`<div class="subtitle">Confirmation code</div>
        <div class="code">${session.confirm_code}</div>
        <p class="muted">
            Make sure this matches the code shown in <strong>${session.client_name}</strong>.
        </p>`
}

const codeLine = (session) =>
    html`<p class="muted">
        Code <span class="code-small">${session.confirm_code}</span> · ${session.client_name}
    </p>`

function denyForm(session) {
    return html`<form method="post" action="/${session.kind}/${session.id}/deny">
        <input type="hidden" name="csrf" value="${session.csrf}" />
        <button class="btn text" type="submit">Cancel</button>
    </form>`
}

/** Step 1 of login or linking: pick Discord or GitHub. */
export function choosePage(session, providers, { linkingTo = null } = {}) {
    const buttons = providers.map(
        (p) =>
            html`<a class="btn provider" href="${p.href}"
                >${icon(PROVIDER_ICON[p.id] ?? "login")}Continue with
                ${p.id === "dev" ? "a test account" : p.label}</a
            >`,
    )
    const intro = linkingTo
        ? html`<p>Add another way to log in to <strong>@${linkingTo}</strong>.</p>`
        : html`<p>Choose how to log in. BeePM only reads your public profile.</p>`
    const none = providers.length
        ? ""
        : html`<div class="alert error">
              ${icon("error")}
              <div>This account already has every type of login linked.</div>
          </div>`
    return page(
        linkingTo ? "Link an account" : "Log in to BeePM",
        html`${intro}${codeBlock(session)}${none}
            <div class="stack">${buttons}</div>`,
        denyForm(session),
    )
}

function who(profile, providerLabel) {
    const avatar = profile.avatarUrl
        ? html`<img src="${profile.avatarUrl}" alt="" />`
        : html`<div class="avatar">${icon(PROVIDER_ICON[profile.provider] ?? "dev")}</div>`
    return html`<div class="who">
        ${avatar}
        <div>
            <div class="name">${profile.displayName || profile.username}</div>
            <div class="sub">
                ${icon(PROVIDER_ICON[profile.provider] ?? "dev", 14)}${providerLabel}:
                ${profile.username}
            </div>
        </div>
    </div>`
}

/** New account: pick a handle. */
export function claimPage(session, profile, providerLabel, { handle, error = null }) {
    return page(
        "Create your account",
        html`${who(profile, providerLabel)}
            <form id="claim" method="post" action="/${session.kind}/${session.id}/claim">
                <input type="hidden" name="csrf" value="${session.csrf}" />
                <div class="subtitle"><label for="handle">Handle</label></div>
                <div class="field">
                    <div class="input">
                        <span>@</span
                        ><input
                            id="handle"
                            name="handle"
                            type="text"
                            value="${handle}"
                            maxlength="39"
                            autocomplete="off"
                            autocapitalize="none"
                            spellcheck="false"
                            required
                            autofocus
                        />
                    </div>
                </div>
                <p class="muted">
                    Your packages are published as <strong>@handle/package-name</strong>. Use
                    lowercase letters, digits and single hyphens. You can't change it later.
                </p>
                ${
                    error
                        ? html`<div class="alert error">
                              ${icon("error")}
                              <div>${error}</div>
                          </div>`
                        : ""
                }
            </form>
            ${codeLine(session)}`,
        html`${denyForm(session)}<button class="btn contained" type="submit" form="claim">
                Create account
            </button>`,
    )
}

/** Known account: confirm the login. */
export function approvePage(session, profile, providerLabel, user) {
    const legacy = !user.claimed_at
        ? html`<div class="alert info">
              ${icon("success")}
              <div>
                  Welcome to BeePM 2! Your packages from BeePM 1 are already under
                  <strong>@${user.handle}</strong>.
              </div>
          </div>`
        : ""
    return page(
        "Allow access",
        html`${who(profile, providerLabel)}${legacy}
            <p>
                <strong>${session.client_name}</strong> will be able to install, publish and manage
                packages as <strong>@${user.handle}</strong>.
            </p>
            ${codeBlock(session)}`,
        html`${denyForm(session)}
            <form method="post" action="/${session.kind}/${session.id}/approve">
                <input type="hidden" name="csrf" value="${session.csrf}" />
                <button class="btn contained" type="submit">Allow</button>
            </form>`,
    )
}

/** Linking: confirm which BeePM account the provider account is added to. */
export function linkConfirmPage(session, profile, providerLabel, user) {
    return page(
        "Link account",
        html`${who(profile, providerLabel)}
            <p>
                You'll be able to log in to <strong>@${user.handle}</strong> with this
                ${providerLabel} account. Only continue if <strong>@${user.handle}</strong> is your
                BeePM account.
            </p>
            ${codeBlock(session)}`,
        html`${denyForm(session)}
            <form method="post" action="/${session.kind}/${session.id}/approve">
                <input type="hidden" name="csrf" value="${session.csrf}" />
                <button class="btn contained" type="submit">Link to @${user.handle}</button>
            </form>`,
    )
}

/** The stand-in "provider" page for test accounts (local development only). */
export function devLoginPage(state) {
    return page(
        "Test account",
        html`<p>
                This server runs in development mode. Pick any username; it's treated like a Discord
                or GitHub account.
            </p>
            <form id="dev" method="get" action="/oauth/dev/callback">
                <input type="hidden" name="state" value="${state}" />
                <div class="subtitle"><label for="code">Username</label></div>
                <div class="field">
                    <div class="input plain">
                        <input
                            id="code"
                            name="code"
                            type="text"
                            maxlength="39"
                            required
                            autofocus
                        />
                    </div>
                </div>
            </form>`,
        html`<button class="btn contained" type="submit" form="dev">Continue</button>`,
    )
}

export function donePage(session, message) {
    const next =
        session.client_kind === "app"
            ? html`<p>You can close this tab and go back to BeePM.</p>
                  <a class="btn contained" href="beepm://focus">Open BeePM</a>`
            : session.client_kind === "cli"
              ? html`<p>You can close this tab and go back to your terminal.</p>`
              : html`<p>You can close this tab now.</p>`
    return statusPage(message, "", "success", next)
}

/** The page at / */
export const homePage = () =>
    statusPage(
        "BeePM registry",
        "This is the server behind BeePM, the package manager for BEEmod. Use the BeePM app to browse and install packages.",
        "success",
    )
