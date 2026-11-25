# beepos: product

What beepos is, who it is for, and what it refuses to be. Read this before changing what the app does. [DESIGN.md](DESIGN.md) covers how it looks and moves; [README.md](README.md) covers how it works and how to run it.

## What it is

A point of sale terminal in a browser tab. A shopkeeper types an amount, the customer pays a Lightning invoice, the register beeps and says **Paid**. The money arrives as Cashu ecash and stays in the register until the owner cashes out.

It should be the easiest way to start accepting bitcoin, and it should look good enough that using it feels like handling future money. Both halves matter. A till that is easy but looks like a form is not beepos, and neither is a beautiful one that needs a manual.

## Who it is for

- **The owner:** someone starting to accept bitcoin at a counter, a market stall or a meetup table. They may never have run a node or a wallet. They have a phone, tablet or laptop with a passkey.
- **The customer:** anyone with a Lightning wallet. They see the screen for a few seconds, scan a code and leave. They never sign in to anything.
- **Whoever is standing nearby.** The screen faces the room. Treat everyone who can see it as a stranger.

Today the real users are the owner of this repository and one or two friends who accept the risk. beepos is an alpha built for [Nut November](https://nutnovember.org/) 2026, and it moves real money.

## How it works, in product terms

| | |
| --- | --- |
| **One credential** | A passkey. No email, no password, no account form. The passkey's secret becomes the wallet seed, so the passkey alone restores the money on any device it syncs to, as long as the browser and the passkey provider there both support the WebAuthn PRF extension. Syncing the passkey is not enough by itself; without PRF the register cannot be opened and the 12 words are the way back. |
| **Money in** | Lightning invoices, one per sale. |
| **Money held** | Cashu ecash at one mint, chosen for the owner (Minibits by default). |
| **Money out** | Cash out by paying a Lightning invoice or Lightning address, or to a Cashu token. BOLT12 offers work on mints that support them (Minibits does not yet). |
| **Amounts** | [BIP-177](https://github.com/bitcoin/bips/blob/master/bip-0177.mediawiki): whole bitcoin with the ₿ sign. ₿2,100 is what used to be called 2,100 sats. The keypad can take a fiat currency instead (US dollars by default, set per register in Settings, or off); it shows the ₿ amount beside it and the invoice is always for the ₿ amount. |
| **Backup** | Automatic. The register is encrypted in the browser and stored as one blob the server cannot read. A 12-word seed is there as a last resort. |

## Principles

1. **Frictionless.** From opening the app to a paid sale there is one passkey prompt and no setup. There is no mint to pick, no channel to open and no seed to write down first. Every new feature has to keep the path "unlock, type, Charge" exactly as short as it is now.
2. **One credential.** The passkey is the only key. Nothing else is asked for and nothing else needs backing up. Anything that moves money out or reveals a secret asks for the passkey again (#6).
3. **The customer-facing screen shows nothing private.** The keypad, the invoice and the Paid screen show the sale in front of you and nothing else: no drawer total, no sales history, no seed words. Private things live behind a deliberate tap by the owner (#5).
4. **The server knows as little as possible.** It stores a public key and ciphertext. New settings and saved data go inside the encrypted register blob, not in new server records.
5. **Say what happened in plain words.** "Paid", "Invoice expired. Nobody paid it in time. Nothing was charged." No jargon the owner has to look up, and never a message that leaves them unsure whether money moved.
6. **It should feel like future money.** The look is part of the product, not decoration on top of it. See DESIGN.md.

## Non-goals

- **Not a wallet.** There is no send screen, no contacts and no general balance management. Money comes in through sales and leaves through cash out.
- **Not a place to keep savings.** Ecash is custodial: the mint holds the bitcoin. The register is a cash drawer, meant to be emptied regularly.
- **No inventory, tax, receipts, staff accounts or reporting.** Saved memo presets (#9) are as far as "products" go.
- **No multiple mints, no mint picker.** One mint, set by the deployment.
- **No on-chain payments** and no card payments.
- **No customer accounts and no customer data.** The only thing recorded about a sale is its amount, time and the memo the owner typed.
- **Not built for scale yet.** No rate limits, no migrations plan, no uptime promise. Alpha means the owner and friends.

## Words we use

| Say | Not |
| --- | --- |
| register, drawer | wallet, vault, account |
| sale | transaction, payment request |
| Charge | Request, Receive |
| Cash out | Withdraw, Send |
| passkey | login, password, key |
| ₿2,100 | 2,100 sats, 0.000021 BTC |
| Lock | Log out, Sign out |

"Ecash", "token" and "mint" appear only where the owner has to act on them (cash out and backup).
