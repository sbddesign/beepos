# beepos

A point of sale that takes Lightning and keeps ecash. Your passkey is the only key.

Built for [Nut November](https://nutnovember.org/) 2026. Everything here was written in November 2026.

> Early prototype. It works with real money. Only use amounts you can afford to lose.

## What it does

1. Open the app and unlock with a passkey (Face ID, Touch ID, Windows Hello, a password manager).
2. Type an amount on the keypad, add an optional memo, press **Charge**.
3. The customer pays the Lightning invoice. The register beeps and shows **Paid**.
4. The payment arrives as Cashu ecash in the register. Cash out whenever you like: pay a Lightning invoice or Lightning address from the register, or make a Cashu token for another wallet.

Amounts follow [BIP-177](https://github.com/bitcoin/bips/blob/master/bip-0177.mediawiki): whole bitcoin with the ₿ symbol, so ₿2,100 is what used to be called 2,100 sats.

## How one passkey is enough

Nothing but the passkey needs backing up.

- The passkey's **PRF extension** returns the same 32 secret bytes every time, on every device the passkey syncs to where the browser and passkey provider support PRF. No server takes part in sign-in.
- Those bytes become a 12-word seed. The Cashu wallet makes all its secrets from that seed ([NUT-13](https://github.com/cashubtc/nuts/blob/main/13.md)), so the mint can give the ecash back to anyone who holds the seed ([NUT-09](https://github.com/cashubtc/nuts/blob/main/09.md)).
- Invoices are locked to a key from the same secret ([NUT-20](https://github.com/cashubtc/nuts/blob/main/20.md)), so only this register can mint a paid invoice.
- The register's state (ecash, open invoices, sales history with memos) is encrypted in the browser and stored as one blob per account on the server. The server sees a public key and ciphertext. Requests are signed with a key derived from the passkey.

So there are three ways back to the money, in order of convenience: the local copy, the encrypted server copy, and the mint itself with only the seed. The **Backup** screen shows the 12 words for use in another Cashu wallet if the passkey is ever lost.

## Mint

The register receives to one mint, chosen for you: [Minibits](https://mint.minibits.cash/Bitcoin). It is a widely used public mint, charges no swap fee, and supports every NUT used here. Set `NEXT_PUBLIC_MINT_URL` to use another.

## Things to know

- Ecash is custodial. The mint holds the bitcoin; the register holds claims on it. Cash out regularly.
- A passkey is bound to the site's domain. A register made on one domain cannot be opened on another, except by its 12 words.
- The passkey provider must support PRF: iCloud Keychain (iOS 18, macOS 15), Google Password Manager, 1Password, Bitwarden, and recent Windows Hello do.
- While unlocked, the secret sits in the tab's session storage so a reload does not ask again. **Lock** clears it.
- Cash out over Lightning is paid by the mint. You see the mint's fee reserve before you confirm; what it does not use comes back. The ecash for a payment is set aside and saved before the mint is asked to pay, so a payment that fails or is interrupted returns it to the register.
- A Lightning address is looked up straight from the browser, so the address's host sees your IP address and the amount, and beepos's server sees nothing. Hosts that do not allow browser requests cannot be paid by address; paste an invoice from them instead.
- BOLT12 offers are paid only on a mint that supports them. Minibits does not yet.
- Cash out, showing a cash-out token again, and showing the 12 words each ask for the passkey again, and only the passkey that opened the register passes. This stops someone tapping buttons on an unlocked terminal. It does not stop someone who can run code in the tab (developer tools, a malicious extension): the keys are in memory while the register is open. **Lock** it when you step away.
- With a currency set (US dollars by default; change it or turn it off in Settings), the keypad takes that currency and the invoice is for the bitcoin it is worth at that moment. The price comes from Coinbase's public API, or Blockchain.com's if that fails, straight from the browser: the same request for everyone, with nothing about the register in it. It is refreshed every minute. A price more than 10 minutes old is not used; the keypad takes bitcoin until a new one arrives. A sale keeps the fiat amount and the price used.
- The vault API has no rate limit yet.

## Run it

```sh
npm install
npm run dev          # http://localhost:3000, vault kept in memory
```

Passkeys work on `localhost`. To try it with fake money, point it at the test mint, whose invoices pay themselves:

```sh
NEXT_PUBLIC_MINT_URL=https://testnut.cashu.space npm run dev
```

On Vercel, add an Upstash Redis store from the Marketplace. The app reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Without them the app still works, but each browser keeps its own copy.

## Tests

```sh
npm test                 # unit tests
BEEPOS_LIVE=1 npm test   # also runs the wallet against the test mint
npm run e2e              # the whole app in Chromium with a virtual passkey
```

## Layout

| Path | What |
| --- | --- |
| `lib/passkey.ts` | WebAuthn create and get with PRF |
| `lib/keys.ts` | Seed, vault key, auth key and quote key from the PRF secret |
| `lib/register.ts` | Sales, minting, cash out, recovery, sync, settings |
| `lib/destination.ts`, `lib/lnurl.ts` | Reading an invoice, offer or Lightning address; getting an invoice from an address |
| `lib/fiat.ts` | Currencies, the bitcoin price and converting a fiat amount |
| `lib/state.ts` | The state blob and how two devices' copies merge |
| `lib/vault-*.ts`, `app/api/vault` | Encrypted blob storage with signed requests |
| `app/pos.tsx` | The screens |
| `app/about` | The public page with the product video |
| `app/fx/*`, `app/globals.css` | The liquid and the glass |

What the product is for is in [PRODUCT.md](PRODUCT.md); how it looks and moves is in [DESIGN.md](DESIGN.md).

## License

MIT
