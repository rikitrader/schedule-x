// WCPR email layout: the one wrapper every WCPR email uses (transactional, notifications, cadences, invites).
// Table-based, inline styles, Arial, 600px, PNG logo from a stable absolute URL (email clients block SVG).
// Copy-free use: import { wcprEmail } from "<public dir>/brand/email/layout"; keep the app's own subject/body logic.

export const WCPR_EMAIL = {
  logoUrl: "https://wcpr.pro/brand/logo/wcpr-logo-black-480w.png",
  logoWidth: 200,
  logoHeight: 36,
  red: "#C8102E",
  ink: "#222222",
  muted: "#555555",
  line: "#DDDDDD",
  bg: "#F4F1EE",
  font: "Arial, Helvetica, sans-serif",
  legal: "La Crescenta Roofing Inc. dba West Coast Precision Roofing · CSLB #454338 (C-39) · Family owned since 1982",
  address: "2517 Honolulu Ave, Montrose, CA 91020",
  phone: "(626) 797-8536",
  email: "office@wcpr.pro",
  site: "wcpr.pro",
} as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type WcprEmailInput = {
  title: string;            // big heading inside the card (plain text, escaped)
  preheader?: string;       // inbox preview line (plain text, escaped)
  bodyHtml: string;         // already-escaped body HTML from the app (use wcprP / wcprTable helpers or your own)
  cta?: { label: string; url: string };
  footerNote?: string;      // plain text, e.g. "You get this because you booked an appointment."
};

/** Paragraph with the house body style. Text is escaped. */
export const wcprP = (text: string) =>
  `<p style="margin:0 0 16px;font-family:${WCPR_EMAIL.font};font-size:15px;line-height:1.5;color:${WCPR_EMAIL.ink}">${esc(text)}</p>`;

/** Two-column label/value table (e.g. appointment details). Values are escaped. */
export const wcprTable = (rows: [string, string][]) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">${rows
    .map(([k, v]) => `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid ${WCPR_EMAIL.line};font-family:${WCPR_EMAIL.font};font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;color:${WCPR_EMAIL.muted};white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid ${WCPR_EMAIL.line};font-family:${WCPR_EMAIL.font};font-size:15px;color:${WCPR_EMAIL.ink}">${esc(v)}</td></tr>`)
    .join("")}</table>`;

/** Full HTML document. */
export function wcprEmail(i: WcprEmailInput): string {
  const E = WCPR_EMAIL;
  const cta = i.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${E.red}"><a href="${esc(i.cta.url)}" style="display:inline-block;padding:13px 24px;font-family:${E.font};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">${esc(i.cta.label)}</a></td></tr></table>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(i.title)}</title></head>
<body style="margin:0;padding:0;background:${E.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(i.preheader ?? "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${E.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-top:4px solid ${E.red};border-radius:4px">
<tr><td style="padding:24px 32px 8px"><a href="https://${E.site}"><img src="${E.logoUrl}" width="${E.logoWidth}" height="${E.logoHeight}" alt="West Coast Precision Roofing" style="display:block;border:0;width:${E.logoWidth}px;max-width:100%;height:auto"></a></td></tr>
<tr><td style="padding:16px 32px 8px"><h1 style="margin:0 0 16px;font-family:${E.font};font-size:22px;line-height:1.3;color:${E.red}">${esc(i.title)}</h1>${i.bodyHtml}${cta}</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid ${E.line};font-family:${E.font};font-size:12px;line-height:1.5;color:${E.muted}">${i.footerNote ? `${esc(i.footerNote)}<br><br>` : ""}${esc(E.legal)}<br>${esc(E.address)} · ${esc(E.phone)} · <a href="mailto:${E.email}" style="color:${E.muted}">${E.email}</a> · <a href="https://${E.site}" style="color:${E.muted}">${E.site}</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** Plain-text footer for the text/plain part. */
export const wcprTextFooter = () => `\n--\n${WCPR_EMAIL.legal}\n${WCPR_EMAIL.address} · ${WCPR_EMAIL.phone} · ${WCPR_EMAIL.email} · ${WCPR_EMAIL.site}\n`;
