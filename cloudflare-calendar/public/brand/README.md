# WCPR brand kit (vendored copy)

Do not edit files here. Source: ~/projects/wcpr-brand. Update with `~/projects/wcpr-brand/scripts/sync.sh <public dir>`.

## Head tags (every page)
```html
<link rel="stylesheet" href="/brand/tokens.css">
<link rel="icon" href="/brand/app-icons/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/app-icons/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/brand/app-icons/apple-touch-icon.png">
<meta name="theme-color" content="#c8102e">
```

## Manifest icons
`/brand/app-icons/icon-192.png` (192), `/brand/app-icons/icon-512.png` (512), `/brand/app-icons/icon-maskable-512.png` (512, purpose maskable).

## Header logo
```html
<a class="wcpr-logo" href="/"><img class="wcpr-logo-full" src="/brand/logo/wcpr-logo-black.svg" alt="West Coast Precision Roofing"><img class="wcpr-logo-mark" src="/brand/logo/wcpr-mark-black.svg" alt=""></a>
```
Use the `-white.svg` files on dark or red backgrounds. PNG fallbacks for email/PDF: `logo/wcpr-logo-black-480w.png`.

## Icons
`<svg class="wcpr-icon" aria-hidden="true"><use href="/brand/icons.svg#i-NAME"/></svg>`. Names are the `<symbol id="i-…">` entries in icons.svg.

## Spacing
Only `--wcpr-space-*` for padding, margin and gap; `--wcpr-gutter` for page side padding; `--wcpr-tap` (44px) as the minimum touch target.
