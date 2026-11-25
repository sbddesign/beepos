import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

// Opening the register loads the mint's keys; the test mint can be slow.
const OPEN = 30_000;
const MINT = process.env.BEEPOS_TEST_MINT ?? 'https://testnut.cashu.space';

// Printed when a test fails: requests over 4 s and console errors.
const slow: string[] = [];
test.afterEach(({}, testInfo) => {
  if (testInfo.status !== 'passed') console.log('slow or failing requests:', slow);
  slow.length = 0;
});

// A virtual passkey provider with PRF, like iCloud Keychain or 1Password.
async function addAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function sell(page: Page, digits: string, memo: string) {
  for (const d of digits) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByLabel('Memo (optional)').fill(memo);
  await page.getByRole('button', { name: /^Charge ₿/ }).click();
  await expect(page.getByRole('img', { name: 'Lightning invoice QR code' })).toBeVisible({
    timeout: OPEN,
  });
}

const HOME_BUTTON = 'Open the register';

async function openRegister(page: Page) {
  await page.getByRole('button', { name: HOME_BUTTON }).click();
  await expect(page.getByTestId('wallet-balance')).toBeVisible();
}

// The register opens on a menu of tiles; each one leads to its own view.
const tile = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Register' }).getByRole('button', { name });
const goBack = (page: Page) => page.getByRole('button', { name: 'Back', exact: true }).click();

// Nobody looking at the till can learn what the drawer holds: not on screen, not
// in the page behind it, not in what a screen reader says.
async function expectNoTotal(page: Page, total: string) {
  await expect(page.getByTestId('wallet-balance')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const seen = await page.evaluate(() => {
    const attrs = [...document.querySelectorAll('*')].flatMap((el) =>
      ['aria-label', 'title', 'value', 'placeholder', 'alt'].map((a) => el.getAttribute(a) ?? ''),
    );
    return [document.body.innerText, document.body.textContent, document.title, ...attrs].join('\n');
  });
  expect(seen).not.toContain(total);
  expect(seen).not.toContain(total.replace(/\D/g, ''));
}

// The bitcoin price, as the public sources would give it. `null` means neither answers.
async function prices(page: Page, perBitcoin: Record<string, string> | null) {
  await page.route('https://api.coinbase.com/**', (route) =>
    perBitcoin
      ? route.fulfill({ json: { data: { currency: 'BTC', rates: perBitcoin } } })
      : route.abort(),
  );
  await page.route('https://blockchain.info/**', (route) => route.abort());
}

test('create a passkey, take a payment, and open the register on a second device', async ({
  context,
  page,
}, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const { cdp, authenticatorId } = await addAuthenticator(context, page);
  page.on('requestfinished', (r) => {
    const t = r.timing();
    if (t.responseEnd > 4000) slow.push(`${Math.round(t.responseEnd)}ms ${r.method()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => slow.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('console', (m) => m.type() === 'error' && slow.push(`console: ${m.text()}`));

  await prices(page, { USD: '50000' });
  await page.goto('/');
  await shot('1-lock');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  // A new register rings up in dollars. This one is switched to bitcoin only, and
  // the choice has to follow the passkey to the second device below.
  await expect(page.getByTestId('amount')).toHaveText('$0.00', { timeout: OPEN });
  await openRegister(page);
  await tile(page, 'Settings').click();
  await page.getByLabel('Currency').selectOption({ label: 'Bitcoin only' });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('amount')).toHaveText('₿0');
  await expect(page.getByTestId('convert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Charge', exact: true })).toBeDisabled();

  await sell(page, '2100', 'Flat white');
  await expect(page.getByTestId('invoice-amount')).toHaveText('₿2,100');
  expect(await page.getByTestId('invoice').inputValue()).toMatch(/^lnbc21u/);
  await expect(page.locator('header').getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot('2-invoice');

  // The test mint pays the invoice by itself.
  await expect(page.getByRole('status').filter({ hasText: 'Paid' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('wallet-balance')).toHaveCount(0);
  await shot('3-paid');
  await page.getByRole('button', { name: 'New sale' }).click();
  await expect(page.getByTestId('amount')).toHaveText('₿0');
  // The header is the name and one button, and the home says nothing about the drawer.
  await expect(page.locator('header').getByRole('button')).toHaveCount(1);
  await expect(page.locator('header')).toHaveText('beepos');
  await expectNoTotal(page, '₿2,100');
  await shot('4-keypad');

  // The total is behind the button. Escape or Done puts it away again.
  await openRegister(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('₿2,100', { timeout: OPEN });
  await expect(page.getByRole('navigation', { name: 'Register' }).getByRole('button')).toHaveText([
    'Activity',
    'Saved items',
    'Settings',
    'Cash out',
    'Lock',
  ]);
  // With the register open, typing does not ring up a sale behind it.
  await page.keyboard.press('7');
  await page.keyboard.press('Escape');
  await expectNoTotal(page, '₿2,100');
  await expect(page.getByTestId('amount')).toHaveText('₿0');
  await expect(page.getByRole('button', { name: HOME_BUTTON })).toBeFocused();

  // A reload keeps the session; locking asks for the passkey again.
  await page.reload();
  await expect(page.getByTestId('amount')).toHaveText('₿0', { timeout: OPEN });
  await expectNoTotal(page, '₿2,100');
  await openRegister(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('₿2,100', { timeout: OPEN });
  await expect(page.getByText('Any device with your passkey can open this register')).toBeVisible();
  await page.waitForTimeout(400); // let the drawer finish sliding in before the picture
  await shot('5-register');
  // The sales are one tap in, and the total stays on the menu.
  await expect(page.getByText('Flat white')).toHaveCount(0);
  await tile(page, 'Activity').click();
  await expect(page.getByText('Flat white')).toBeVisible();
  await expect(page.getByText('+₿2,100')).toBeVisible();
  await expect(page.getByTestId('wallet-balance')).toHaveCount(0);
  await shot('5-activity');
  await goBack(page);
  await tile(page, 'Lock').click();
  await page.getByRole('button', { name: 'Unlock with passkey' }).click();
  // Unlocking lands on the keypad with the drawer shut.
  await expect(page.getByTestId('amount')).toHaveText('₿0', { timeout: OPEN });
  await expectNoTotal(page, '₿2,100');

  // Second device: nothing but the passkey. A wiped browser stands in for it,
  // so the sale has to come back from the vault server.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByRole('button', { name: 'I already have a passkey' }).click();
  await expect(page.getByTestId('amount')).toHaveText('₿0', { timeout: OPEN });
  await openRegister(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('₿2,100', { timeout: OPEN });
  await tile(page, 'Activity').click();
  await expect(page.getByText('Flat white')).toBeVisible();
  await goBack(page);

  // Cash out to a token. The passkey is asked for again and answers.
  await tile(page, 'Cash out').click();
  await page.getByLabel('Amount to cash out').fill('100');
  await page.getByRole('button', { name: 'Make ₿100 token' }).click();
  await expect(page.getByTestId('token')).toHaveValue(/^cashuB/, { timeout: OPEN });
  await shot('6-token');
  const balance = page.getByTestId('wallet-balance');
  let left = Number((await balance.innerText()).replace(/\D/g, ''));
  expect(left).toBeLessThanOrEqual(2000);
  expect(left).toBeGreaterThanOrEqual(1990); // the test mint takes a small swap fee
  await page.getByRole('button', { name: 'Done' }).last().click();
  await tile(page, 'Activity').click();
  await expect(page.getByText('Not redeemed yet')).toBeVisible();

  // The token is still money, so seeing it again takes the passkey too.
  const showToken = page.getByRole('button', { name: 'Show token' });
  await showToken.click();
  await expect(page.getByTestId('token')).toHaveValue(/^cashuB/);
  // Done on a token opened from Activity goes back to Activity.
  await page.getByRole('button', { name: 'Done' }).last().click();
  await expect(showToken).toBeVisible();
  await goBack(page);

  // Backup lives in Settings. It shows the 12 words after the passkey, and hides
  // them again on leaving.
  const showWords = page.getByRole('button', { name: 'Show the 12 words' });
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const backup = page.getByRole('button', { name: 'Backup' });
  await tile(page, 'Settings').click();
  await backup.click();
  await expect(page.getByRole('heading', { name: 'Backup' })).toBeVisible();
  await expect(page.getByTestId('words')).toHaveCount(0);
  await showWords.click();
  expect((await page.getByTestId('words').innerText()).trim().split(/\s+/)).toHaveLength(12);
  await back.click();
  await expect(page.getByLabel('Currency')).toBeVisible(); // back in Settings
  await backup.click();
  await expect(page.getByTestId('words')).toHaveCount(0);
  await back.click();
  await back.click();

  // Cash out over Lightning: paste an invoice, see the cost, pay with the passkey.
  // The test mint pays its own invoices after a few seconds, and an invoice that is
  // already paid cannot be paid again. When it wins that race the register must say
  // so and keep the money; then a fresh invoice is tried.
  await tile(page, 'Cash out').click();
  const payTo = page.getByLabel('Lightning invoice or address to pay');
  await payTo.fill('not a destination');
  await expect(page.getByText('That is not a Lightning invoice or address')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Make/ })).toBeDisabled();
  let reserve = 0;
  for (let attempt = 1; ; attempt++) {
    const bill = await (
      await page.request.post(`${MINT}/v1/mint/quote/bolt11`, { data: { amount: 50, unit: 'sat' } })
    ).json();
    await payTo.fill(`lightning:${bill.request.toUpperCase()}`);
    await expect(page.getByLabel('Amount to cash out')).toHaveValue('50');
    await page.getByRole('button', { name: 'Check the cost' }).click();
    await expect(page.getByRole('heading', { name: 'Pay ₿50' })).toBeVisible({ timeout: OPEN });
    reserve = Number((await page.getByTestId('fee-reserve').innerText()).replace(/\D/g, ''));
    await expect(page.getByTestId('left')).toHaveText(
      `₿${(left - 50 - reserve).toLocaleString('en-US')}`,
    );
    await expect(balance).toHaveText(`₿${left.toLocaleString('en-US')}`); // nothing moved yet
    if (attempt === 1) await shot('7-lightning-cost');
    await page.getByRole('button', { name: 'Pay ₿50' }).click();
    const paid = page.getByText(/^Paid ₿50 to lnbc/);
    const refused = page.getByText('The money is back in the register.');
    await expect(paid.or(refused)).toBeVisible({ timeout: OPEN });
    if (await paid.isVisible()) break;
    expect(attempt).toBeLessThan(4);
    // Refused: the ecash set aside came back, less the test mint's swap fees.
    const back = Number((await balance.innerText()).replace(/\D/g, ''));
    expect(back).toBeGreaterThanOrEqual(left - 4);
    expect(back).toBeLessThanOrEqual(left);
    left = back;
    await page.getByRole('button', { name: 'Change' }).click();
  }
  const after = Number((await balance.innerText()).replace(/\D/g, ''));
  expect(after).toBeLessThanOrEqual(left - 50);
  expect(after).toBeGreaterThanOrEqual(left - 50 - reserve - 4); // the test mint's swap fees
  left = after;
  await shot('8-lightning-paid');
  await tile(page, 'Activity').click();
  await expect(page.getByText(/^Cash out to lnbc/).first()).toBeVisible();
  await expect(page.getByText(/^Paid · /)).toBeVisible();
  await back.click();

  // Leaving while the passkey prompt is still open withdraws the question: the
  // prompt is closed, and an answer that arrives later shows and moves nothing.
  const presence = (enabled: boolean) =>
    cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled });
  await presence(false);
  // Back out of Backup, to Settings.
  await tile(page, 'Settings').click();
  await backup.click();
  await showWords.click();
  await expect(showWords).toBeDisabled();
  await back.click();
  await backup.click();
  await expect(showWords).toBeEnabled();
  await expect(page.getByTestId('words')).toHaveCount(0);
  // Close the drawer.
  await showWords.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openRegister(page);
  await tile(page, 'Settings').click();
  await backup.click();
  await expect(showWords).toBeEnabled();
  await expect(page.getByTestId('words')).toHaveCount(0);
  await back.click();
  await back.click();
  // Leave Activity for the menu with "Show token" still asking.
  await tile(page, 'Activity').click();
  await showToken.click();
  await expect(showToken).toBeDisabled();
  await back.click();
  await tile(page, 'Activity').click();
  await expect(showToken).toBeEnabled();
  await expect(page.getByTestId('token')).toHaveCount(0);
  await back.click();
  // Back out of a pending cash out: no token is made.
  await tile(page, 'Cash out').click();
  await page.getByRole('button', { name: /^Make ₿[\d,]+ token$/ }).click();
  await back.click();
  await expect(balance).toHaveText(`₿${left.toLocaleString('en-US')}`);
  await presence(true);
  await tile(page, 'Activity').click();
  await expect(page.getByText('Not redeemed yet')).toHaveCount(1);
  await expect(page.getByTestId('token')).toHaveCount(0);
  await expect(page.getByTestId('words')).toHaveCount(0);

  // A stranger at the unlocked terminal: the prompt appears and they cannot pass it.
  // (Last in the test: the virtual passkey refuses everything after one failed check.)
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await showToken.click();
  await expect(showToken).toBeEnabled({ timeout: OPEN });
  await expect(page.getByTestId('token')).toHaveCount(0);
  await back.click();

  await tile(page, 'Settings').click();
  await backup.click();
  await showWords.click();
  await expect(showWords).toBeEnabled({ timeout: OPEN });
  await expect(page.getByTestId('words')).toHaveCount(0);
  await back.click();
  await back.click();

  await tile(page, 'Cash out').click();
  const make = page.getByRole('button', { name: /^Make ₿[\d,]+ token$/ });
  await make.click();
  await expect(make).toBeEnabled({ timeout: OPEN });
  await expect(page.getByTestId('token')).toHaveCount(0);
  await expect(balance).toHaveText(`₿${left.toLocaleString('en-US')}`);
  await back.click();

  // Taking a token back is safe and asks for nothing.
  await tile(page, 'Activity').click();
  await page.getByRole('button', { name: 'Take it back' }).click();
  await expect(page.getByText('Token taken back into the register.')).toBeVisible({ timeout: OPEN });
  await back.click();
  await expect(balance).not.toHaveText(`₿${left.toLocaleString('en-US')}`);
});

test('a passkey provider without PRF gets a clear message', async ({ context, page }) => {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: false,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.locator('p.error')).toContainText('cannot derive keys');
});

test('ring up in dollars, then in yen', async ({ context, page }, testInfo) => {
  await addAuthenticator(context, page);
  await prices(page, { USD: '50000', JPY: '8000000' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  const amount = page.getByTestId('amount');
  const convert = page.getByTestId('convert');
  await expect(amount).toHaveText('$0.00', { timeout: OPEN });
  await expect(convert).toHaveText('₿0 · price from just now');

  // 12.50 at 50,000 a bitcoin is ₿25,000. The keys type cents.
  for (const d of ['1', '2', '5', '0']) await page.getByRole('button', { name: d, exact: true }).click();
  await expect(amount).toHaveText('$12.50');
  await expect(convert).toContainText('₿25,000');
  await page.screenshot({ path: testInfo.outputPath('fiat-keypad.png') });
  await page.getByRole('button', { name: 'Charge $12.50' }).click();
  await expect(page.getByTestId('invoice-amount')).toHaveText('₿25,000', { timeout: OPEN });
  await expect(page.getByTestId('invoice-fiat')).toHaveText('$12.50');
  expect(await page.getByTestId('invoice').inputValue()).toMatch(/^lnbc250u/);
  await expect(page.getByRole('status').filter({ hasText: 'Paid' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'New sale' }).click();

  // The sale keeps both amounts.
  await openRegister(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('₿25,000', { timeout: OPEN });
  await tile(page, 'Activity').click();
  await expect(page.getByText('+₿25,000')).toBeVisible();
  await expect(page.getByText(/· \$12\.50$/)).toBeVisible();
  await goBack(page);

  // Yen has no cents: 1,000 yen at 8,000,000 a bitcoin is ₿12,500.
  await tile(page, 'Settings').click();
  await page.getByLabel('Currency').selectOption('JPY');
  // Settings is the currency, the mint and the way to Backup, with no explainer.
  await expect(page.getByText(/The keypad takes/)).toHaveCount(0);
  await expect(page.getByText('testnut.cashu.space')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('fiat-settings.png') });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(amount).toHaveText('¥0');
  for (const d of ['1', '0', '00']) await page.getByRole('button', { name: d, exact: true }).click();
  await expect(amount).toHaveText('¥1,000');
  await expect(convert).toContainText('₿12,500');
  await expect(page.getByRole('button', { name: 'Charge ¥1,000' })).toBeEnabled();
});

test('saved items fill the price and the memo in one tap', async ({ context, page }, testInfo) => {
  await addAuthenticator(context, page);
  await prices(page, { USD: '50000', JPY: '8000000' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  const amount = page.getByTestId('amount');
  await expect(amount).toHaveText('$0.00', { timeout: OPEN });
  const chips = page.locator('ul.presets');
  await expect(chips).toHaveCount(0);

  const add = async (name: string, price: string, unit?: string) => {
    await page.getByRole('button', { name: 'Add an item' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Price', { exact: true }).fill(price);
    if (unit !== undefined) await page.getByLabel('Price is in').selectOption(unit);
    await page.getByRole('button', { name: 'Save item' }).click();
  };

  // Add one in dollars and one in bitcoin. A bad price is refused in plain words.
  await openRegister(page);
  await tile(page, 'Saved items').click();
  await add('Flat white', 'four');
  await expect(page.locator('.saved-form [role=alert]')).toHaveText(
    'Enter a price in USD, like 4.50.',
  );
  await page.getByLabel('Price', { exact: true }).fill('4.50');
  await page.getByRole('button', { name: 'Save item' }).click();
  await add('Sticker', '2100', '');
  const saved = page.locator('ul.saved-list');
  await expect(saved.getByRole('listitem')).toHaveText([/Flat white\$4\.50/, /Sticker₿2,100/]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('presets-settings.png') });
  await page.getByRole('button', { name: 'Done' }).click();

  // The keypad takes dollars, so it offers the dollar item only. One tap fills both fields.
  await expect(chips.getByRole('button')).toHaveText(['Flat white$4.50']);
  await page.getByRole('button', { name: '7', exact: true }).click();
  await chips.getByRole('button', { name: 'Flat white' }).click();
  await expect(amount).toHaveText('$4.50');
  await expect(page.getByTestId('convert')).toContainText('₿9,000');
  await expect(page.getByLabel('Memo (optional)')).toHaveValue('Flat white');
  await page.screenshot({ path: testInfo.outputPath('presets-keypad.png') });
  await page.getByRole('button', { name: 'Charge $4.50' }).click();
  await expect(page.getByTestId('invoice-amount')).toHaveText('₿9,000', { timeout: OPEN });
  await expect(page.getByTestId('invoice-fiat')).toHaveText('$4.50');
  await expect(page.getByText('Flat white')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Bitcoin only: the bitcoin item shows, and the dollar price is never read as bitcoin.
  await openRegister(page);
  await tile(page, 'Settings').click();
  await page.getByLabel('Currency').selectOption({ label: 'Bitcoin only' });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(chips.getByRole('button')).toHaveText(['Sticker₿2,100']);
  await chips.getByRole('button', { name: 'Sticker' }).click();
  await expect(amount).toHaveText('₿2,100');
  await expect(page.getByLabel('Memo (optional)')).toHaveValue('Sticker');

  // A second device: nothing but the passkey brings the items back.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByRole('button', { name: 'I already have a passkey' }).click();
  await expect(chips.getByRole('button')).toHaveText(['Sticker₿2,100'], { timeout: OPEN });

  // Change one, remove the other.
  await openRegister(page);
  await tile(page, 'Saved items').click();
  await page.getByRole('button', { name: 'Change Sticker' }).click();
  await expect(page.getByLabel('Price', { exact: true })).toHaveValue('2100');
  await page.getByLabel('Price', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Save item' }).click();
  await page.getByRole('button', { name: 'Remove Flat white' }).click();
  await expect(saved.getByRole('listitem')).toHaveText([
    /Sticker₿500/,
  ]);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(chips.getByRole('button')).toHaveText(['Sticker₿500']);
});

test('a long sales history does not push the menu down', async ({ context, page }, testInfo) => {
  await addAuthenticator(context, page);
  await prices(page, { USD: '50000' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByTestId('amount')).toHaveText('$0.00', { timeout: OPEN });
  const rung = ['Flat white', 'Cortado', 'Croissant', 'Oat latte', 'Sticker', 'Espresso'];
  for (let i = 0; i < 14; i++) {
    for (const d of ['3', '5', '0']) await page.getByRole('button', { name: d, exact: true }).click();
    await page.getByLabel('Memo (optional)').fill(rung[i % rung.length]);
    await page.getByRole('button', { name: /^Charge \$/ }).click();
    await expect(page.getByTestId('invoice-amount')).toBeVisible({ timeout: OPEN });
    await page.getByRole('button', { name: 'Cancel' }).click();
  }
  await openRegister(page);
  // Every tile is on screen without scrolling, however much has been sold.
  for (const name of ['Activity', 'Saved items', 'Settings', 'Cash out', 'Lock']) {
    await expect(tile(page, name)).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator('ul.activity')).toHaveCount(0);
  await tile(page, 'Activity').click();
  await expect(page.locator('ul.activity > li')).toHaveCount(14);
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('long-activity.png') });
  await goBack(page);
  await expect(tile(page, 'Lock')).toBeInViewport({ ratio: 1 });
});

test('with no price to be had, the keypad takes bitcoin and says why', async ({ context, page }) => {
  await addAuthenticator(context, page);
  await prices(page, null);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByTestId('convert')).toHaveText(
    'No current price for USD. Enter the amount in bitcoin.',
    { timeout: OPEN },
  );
  await expect(page.getByTestId('amount')).toHaveText('₿0');
  for (const d of ['2', '1']) await page.getByRole('button', { name: d, exact: true }).click();
  await expect(page.getByTestId('amount')).toHaveText('₿21');
  await page.getByRole('button', { name: 'Charge ₿21' }).click();
  await expect(page.getByTestId('invoice-amount')).toHaveText('₿21', { timeout: OPEN });
  await expect(page.getByTestId('invoice-fiat')).toHaveCount(0);
});

test('a price that went out of date while the tab slept is not charged at', async ({ context, page }) => {
  await addAuthenticator(context, page);
  await prices(page, { USD: '50000' });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByTestId('amount')).toHaveText('$0.00', { timeout: OPEN });
  for (const d of ['1', '2', '5', '0']) await page.getByRole('button', { name: d, exact: true }).click();
  const charge = page.getByRole('button', { name: 'Charge $12.50' });
  await expect(charge).toBeEnabled();
  // The clock jumps 11 minutes with no timer firing: the screen still shows the old price.
  await page.clock.setSystemTime(Date.now() + 11 * 60_000);
  await charge.click();
  await expect(page.getByRole('alert').filter({ hasText: 'The price is out of date' })).toBeVisible();
  await expect(page.getByTestId('invoice-amount')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Charge', exact: true })).toBeDisabled();
});
