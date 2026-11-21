# beepos

A point of sale that takes Lightning and keeps ecash. Your passkey is the only key.

Built for [Nut November](https://nutnovember.org/) 2026. Everything here was written in November 2026.

> Early prototype. It works with real money. Only use amounts you can afford to lose.

## What it does

1. Open the app and unlock with a passkey (Face ID, Touch ID, Windows Hello, a password manager).
2. Type an amount on the keypad, add an optional memo, press **Charge**.
3. The customer pays the Lightning invoice. The register beeps and shows **Paid**.
4. The payment arrives as Cashu ecash in the register. Cash out to a token whenever you like.

Amounts follow [BIP-177](https://github.com/bitcoin/bips/blob/master/bip-0177.mediawiki): whole bitcoin with the ₿ symbol, so ₿2,100 is what used to be called 2,100 sats.

## How one passkey is enough

Nothing but the passkey needs backing up.

- The passkey's **PRF extension** returns the same 32 secret bytes every time, on every device the passkey syncs to. No server takes part in sign-in.
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
| `lib/register.ts` | Sales, minting, cash out, recovery, sync |
| `lib/state.ts` | The state blob and how two devices' copies merge |
| `lib/vault-*.ts`, `app/api/vault` | Encrypted blob storage with signed requests |
| `app/pos.tsx` | The screens |

## License

MIT
