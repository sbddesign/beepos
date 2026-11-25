# beepos: design

The Glass direction, written down from the code that shipped in PR #3. Build every UI change to this. If the code and this file disagree, one of them is a bug: fix it in the same PR.

Sources: `app/globals.css` (materials, tokens, layout), `app/fx/shader.ts` (the liquid), `app/fx/liquid.tsx` (moods, ripples, frame loop), `app/fx/motion.ts` (tilt, pointer, drift), `app/layout.tsx` (type). [PRODUCT.md](PRODUCT.md) says what the product is for.

## The idea

**Glass over liquid light.** The money is a slow liquid, deep ink and teal with threads of amber light moving through it. The till is a set of glass slabs resting on top. You never touch the liquid; you press glass and the liquid answers.

Three rules follow from that:

1. **One light source.** Every highlight on every slab comes from the same point, and that point moves with the phone's tilt or the pointer. Never add a highlight that ignores it.
2. **The liquid answers the till.** It ripples under a pressed key, breathes while an invoice waits, and floods green-gold when it is paid. It never moves for decoration alone.
3. **Amber is scarce.** One warm, solid thing per screen: the primary action. Everything else is clear or frosted.

## The mark

`public/icon.svg` is the only logo file: favicon, home-screen icon (through the manifest) and the lock screen all use it. It is an amber (`#f5b700`) hexagon on an ink (`#04121c`) rounded square, with two ink bars across it. Everything is rounded to sit with the glass: the hexagon's corners have a radius of 4 on the 64 grid and the bars are pills. Do not redraw it with sharp corners, add a gradient, or set it on a colour other than ink.

## Colour

Tokens in `:root` (`app/globals.css`):

| Token | Value | Used for |
| --- | --- | --- |
| `--bg` | `#04121c` | Page base, theme colour, PWA background |
| `--ink` | `4, 18, 28` | The same colour as RGB parts, for `rgba(var(--ink), a)` tints |
| `--text` | `#f3f8f7` | All primary text |
| `--muted` | `#b7c8cb` | Secondary text, placeholders, section headings |
| `--dim-display` | `#d5e1e3` | The amount when it is zero |
| `--accent` | `#f5b700` | Amber: primary button, links, waiting pulse, offline dot |
| `--accent-ink` | `#1a1300` | Text on amber |
| `--good` | `#74e2a8` | Paid amounts, synced dot, the Paid check |
| `--bad` | `#ffab9e` | Errors |
| `--focus` | `#ffe08a` | Focus ring |
| `--line` | `rgba(255,255,255,0.14)` | Slab edges and dividers |

The liquid's own palette lives in the shader, in linear light: ink, deep, teal, amber, coral embers; on Paid, teal turns to moss and amber to gold.

Dark only (`color-scheme: dark`). There is no light theme.

### Contrast is enforced, not hoped for

- The shader clamps the liquid to a relative luminance of **0.2** (`MAX_LUMINANCE` in `app/fx/shader.ts`). `globals.css` depends on that number; change them together.
- **Only large numerals sit straight on the liquid** (the amount, the key digits). White on 0.2 is 3.9:1, which passes for large text only.
- **All small text sits on frosted glass** with an ink tint of at least 60%. That holds the backdrop under 0.07, so `--text` is 8:1 and `--muted` is 5:1.
- A message that has to appear over open liquid brings its own glass (see `.hint[role='alert']`).

## Type

One family: **Manrope**, self-hosted through `next/font` with the `latin` and `latin-ext` subsets. It contains the ₿ sign (U+20BF), so amounts never fall back to another face. Body is 500 weight, 16px, line height 1.4.

| Role | Size | Weight | Notes |
| --- | --- | --- | --- |
| Amount (keypad) | `clamp(2.8rem, 14vw, 4.6rem)` | 300 (200 when zero) | tracking -0.045em, tabular numerals, soft amber glow |
| Amount (invoice, paid, register) | 2.6rem | 300 | `.amount.small` |
| Key digit | 1.75rem | 300 | |
| Lock title | 2.2rem | 300 | tracking -0.03em |
| `h2` | 1.4rem | 600 | |
| Charge button | 1.15rem | 700 | |
| Brand in the bar | 1.15rem | 700 | tracking -0.03em, lower case |
| `h3` section label | 0.8rem | bold | upper case, tracking 0.08em, `--muted` |
| Hint, sync line | 0.9rem | | |

Big numbers are thin; small labels are heavy. Every amount uses `font-variant-numeric: tabular-nums`. Monospace (`ui-monospace, Menlo`) is only for things the owner copies: tokens, the 12 words, the mint URL.

## Materials

There are four. Pick one; do not invent a fifth.

| Material | Where | Recipe |
| --- | --- | --- |
| **Frosted glass** | Bar, lock card, invoice and Paid cards, memo field | `--frost` (62% ink tint under a faint white gradient) with `--frost-filter` (`blur(22px) saturate(1.25)`), `--line` border, `--bevel` |
| **Deep frost** | The register drawer | 70% ink tint, `blur(30px) saturate(1.25)` |
| **Clear glass** | The twelve keys, secondary buttons | No blur. Keys: 22% ink tint, bright top bevel, drop shadow. Buttons: 4% white |
| **Amber glass** | Primary button only | Amber gradient at 0.9 to 0.96 alpha, bright rim, amber glow underneath, `--accent-ink` text |

Shared parts:

- **Specular highlight.** Every slab has a radial gradient centred on `var(--spec-x) var(--spec-y)`. Those are derived from `--tilt-x` / `--tilt-y` and move *against* the tilt, which is what makes the glass look thick.
- **Bevel** (`--bevel`): a light inner line on top, a dark one underneath.
- **Wells.** Inputs inside a frosted sheet are cut into it: 62% ink, inset shadow, no blur. The memo field stands alone on the liquid, so it frosts itself.
- **Keys stay clear on purpose.** No backdrop blur means ripples stay sharp through them and twelve keys cost nothing to composite. Do not blur them.

Blur is expensive over a moving canvas. Only large, few surfaces get `backdrop-filter`.

Radii: 30px cards, 20px keys and the Charge button, 16px buttons and fields, 12px the QR, full pill for the hint and header button.

Sizes: buttons and fields are at least 48px tall, the Charge button 60px, header button and `summary` 44px.

## The liquid

One `<canvas class="liquid">` fixed behind everything, drawn by a single fragment shader in raw WebGL (no library). It is mounted once in `app/layout.tsx`.

- A domain-warped noise field in ink and teal. Two ridged noise fields cross to make a net of thin amber threads, with coral embers where the warp gathers. A vignette darkens the edges.
- Drawn at **0.66 of CSS resolution**, device pixel ratio capped at 1.5. It is soft and under glass, so nobody can tell.
- Capped at luminance 0.2 (see Contrast) and dithered to hide banding.
- Paused while the tab is hidden.

### Moods

`setMood()` in `app/fx/liquid.tsx`, set from the current screen in `app/pos.tsx`:

| Mood | Screen | What the liquid does |
| --- | --- | --- |
| `idle` | Lock, keypad | Slow drift |
| `waiting` | Invoice | Breathes: a gentle zoom and a brightening around the centre, about one cycle every 5.7 s |
| `paid` | Paid | **The Paid wash.** A bright gold front spreads from the centre over a few seconds. Behind it the liquid turns calmer and greener (teal to moss, amber to gold, embers out, threads dimmer) and stays that way until the next sale |

Breath and calm ease in and out; they never snap.

### If there is no WebGL

No context, a failed compile or a lost context adds `.no-liquid` to `<html>`, hides the canvas, and shows a still CSS gradient in the same colours (three radial gradients over `--bg`). Everything else is unchanged.

## Motion

| What | Driven by | Detail |
| --- | --- | --- |
| **Tilt** | `deviceorientation` on phones | However the phone is held becomes level, and that baseline follows slowly. About 25° is full deflection. Corrected for screen rotation |
| **Pointer** | Mouse position on desktops | Screen position mapped to -1..1 |
| **Idle drift** | Nothing | After 2.5 s without input the light starts to wander on slow sine curves, fully by 5 s. A till on a counter is never frozen |
| **Key press ripple** | Pointer down on any `.key` or `.btn`, or a digit / Backspace on a keyboard | A ring spreads through the liquid from the centre of the control, lasting 2.6 s. Up to 8 at once |
| **Key press, the slab** | `:active` | Sinks 3px, scales to 0.985, rim turns amber, instantly. Released over 90 ms. Keys also `navigator.vibrate(8)` where supported |
| **Waiting pulse** | Invoice screen | Amber dot, 1.2 s opacity pulse |
| **Drawer** | Opening the register | Slides in from the right, 240 ms, while the scrim fades in. Closing is immediate |
| **Paid check** | Paid screen | Green glass disc scales up from 0.6 with a slight overshoot, 0.7 s |
| **Amount parallax** | Tilt | The keypad amount shifts up to 3px with the tilt |

Tilt is smoothed (exponential, rate 6/s) and written to `--tilt-x` / `--tilt-y` on `<html>` **once per frame, and only when it has moved**. Everything in CSS reads those two variables. Do not add per-element JavaScript animation; add CSS that reads the variables.

On iPhone, tilt needs the system motion prompt. It is requested on the first tap *inside the till* (`.app`), never on the lock screen, where a tap opens the passkey sheet. A refusal just means no tilt.

A paid sale also plays a two-note beep (880 Hz then 1320 Hz).

### Reduced motion

With `prefers-reduced-motion: reduce`:

- The liquid is **one still frame**. No drift, no tilt (both variables are held at 0), no ripples, no breathing.
- Paid is a plain change of colour to the calm green state, with no wave.
- The waiting pulse and the check animation are off, the drawer appears without sliding, and buttons and keys have no transitions.
- Nothing is hidden or removed. Every state is still told apart by text.

## The QR code rule

**A QR code is plain black on white, always.** No tint, no gradient, no logo in the middle, no rounded modules. The glass is only the frame around it: a white square with a 12px radius and a quiet zone, ringed by a translucent border. Scanning must work first time on a bad phone camera in a dark shop; nothing about the look is worth a failed scan.

## Layout

The app is a full-height column (`100dvh`) with safe-area padding: a frosted **bar** on top, one **pane** below. The layout is the same at every width; there are no breakpoints.

- **Bar:** the name on the left, one button on the right. Nothing else.
- **Keypad** (`.keypad-view`): at most 26rem wide and 46rem tall, centred in both directions. Top to bottom: amount, the converted amount (only when a fiat currency is set), hint line, saved items (only when there are some), memo, the 3×4 key grid, Charge. With a fiat currency the big amount is the fiat one and the pill under it (`.convert`, its own ink glass because it is small text over the liquid) gives the ₿ amount and the age of the price; with no current price the pill says so and the keypad takes bitcoin. The amount is pushed down toward the keys so the thumb zone holds everything that is pressed. The grid is between 15rem and 24rem tall.
- **Invoice and Paid** (`.center-view`): a frosted card, at most 26rem wide, centred in both directions.
- **Lock** (`.lock-card`): a frosted card, at most 22rem wide, centred.

### The home shows the sale and nothing else

The keypad, invoice and Paid screens show only the sale in front of you. The drawer total, the activity list and the seed words are **not in the page** until the owner opens the register: not hidden with CSS, not in an accessible label, not in a tooltip. Any new screen that a customer can see follows the same rule.

### The about page

`/about` is the one public page: the product video and the way in. It is a single frost card (`.about-card`, at most 46rem wide) centred on the liquid: mark and name, one headline, the video at 16:9 with native controls and a poster, two lines of copy, an amber **Get started** that goes home, and one fine-print line. It opens no register and shows nothing private. The video never plays by itself.

The lock screen links to it with "What is beepos?" as a quiet link (`.quiet-link`: muted, underlined, 44px tall), so the amber passkey button stays the only loud thing there.

The video files live at `public/video/beepos.webm`, `beepos.mp4` and `beepos-poster.jpg`.

### The register drawer

The header button (`.till-btn`) is a pill of clear glass holding the sync dot and a till icon. Its label is "Open the register". It never shows or reads out an amount.

Tapping it opens the **drawer** (`.drawer`), a modal `<dialog>` in deep frost that slides in from the right over 240 ms:

| Width | Drawer |
| --- | --- |
| Up to 26rem | The whole screen |
| Wider | A 26rem column on the right edge; the till beside it is dimmed by a 50% ink scrim |

The drawer is a set of views, one at a time. A long sales history never pushes anything else down.

**The menu** is what the drawer opens on: the **Register** title and **Done**, the total, the sync line, then five tiles.

| Tile | Leads to |
| --- | --- |
| Activity | Sales and cash-outs, newest first |
| Saved items | The list of saved items: a row each (name, price, Change, Remove), then **Add an item**, with a small form that opens in place. A register keeps at most 12 |
| Settings | One row per setting, label on the left and value or control on the right: Currency (a native `<select>`), Mint, and Backup, which opens the Backup view |
| Cash out | The cash-out form. The one amber tile; disabled when the register is empty |
| Lock | Locks the register |

**Tiles** (`.tile`) are clear glass, two across, at least 6.25rem tall, with a 28px line icon top left and the label bottom left in 1.05rem semibold. Lock (`.tile.wide`) runs the full width as a 60px row. Icons are 24-unit line drawings with a 1.7 stroke, the same hand as the till icon in the header, and always sit beside a text label.

**Every other view** replaces the menu. Its header is a square back button (chevron, labelled "Back"), the view's title, and Done. Back goes up one level: Activity, Saved items and Settings to the menu, Backup to Settings. Cash out keeps its own Back and Done buttons, because where they lead depends on the step. The total shows on the menu and in Cash out only.

Leaving a view by any route (Back, Done, Escape, another tile) withdraws a passkey prompt that is still open and clears anything secret that view was showing. A new setting gets a row in Settings; do not add explainer paragraphs under a row.

### Saved items on the keypad

A single row of pills (`.presets`) above the memo that scrolls sideways and never wraps, so the keys do not move however many there are. Each pill (`.preset`) is ink glass at 68% with no blur, at least 44px tall, with the name in `--text` and the price in `--muted`. A tap fills the amount and the memo and does not charge; the pill whose price and name are showing has an amber rim. The row only holds items priced in the unit the keypad is taking at that moment. An item's price is never converted, and never read as another unit.

The drawer closes with Done, Escape, or a tap on the scrim, and focus returns to the header button. It is closed when the register is unlocked and whenever a sale starts. While it is open the till behind it cannot be pressed and the keyboard does not type into the keypad. Closing it removes it from the page, so it always reopens on the menu.

## Controls and states

- **Focus:** a 3px `--focus` outline, offset 2px, on every interactive element. Never remove it.
- **Disabled:** 45% opacity, no press effect, no ripple.
- **Sync dot:** grey while saving, green and glowing when backed up, amber when offline or kept on this device only. It always carries a text label for screen readers and as a tooltip.
- **Errors** are `--bad` text with `role="alert"`. Status changes use `role="status"`. The amount is an `<output>` with `aria-live="polite"`.
- A desktop keyboard works as the keypad: digits, Backspace, Enter to charge.

## Wording and tone

Short, plain and calm. The till talks like a good shop assistant.

- **Sentence case** everywhere. The name is always lower case: beepos.
- **Buttons are verbs or plain nouns:** Charge, Cash out, Backup, Lock, New sale, Done, Back, Cancel.
- **Say what happened and what it means for the money:** "Invoice expired. Nobody paid it in time. Nothing was charged."
- **Busy states name the work,** with an ellipsis: "Making invoice…", "Opening the register…", "Checking the mint…".
- **Warn once, plainly:** "Anyone with these words can take the money. Keep them offline."
- **Fiat amounts** are always `formatFiat()` from `lib/fiat.ts`, and never appear without the ₿ amount next to them. The one exception is the price label on a saved item; tapping it puts the ₿ amount on screen.
- **Amounts** are always `formatBitcoin()` from `lib/format.ts`: the ₿ sign, then a whole number with thousands separators. Never "sats", never decimals of a bitcoin. Money in is prefixed `+` in `--good`; money out is prefixed `−`.
- No exclamation marks, no emoji, no "Oops".

See the word list in PRODUCT.md for which nouns to use.

## Checklist for a UI change

- [ ] Small text is on frosted glass, not on open liquid.
- [ ] New surfaces use one of the four materials and the shared highlight variables.
- [ ] At most one amber control on the screen.
- [ ] Nothing new animates from JavaScript per element; reduced motion still gives a still, complete screen.
- [ ] Any QR code is untouched black on white.
- [ ] No private amount or history is visible without a deliberate tap by the owner.
- [ ] This file still matches the code.
