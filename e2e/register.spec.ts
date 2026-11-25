import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

// Opening the register loads the mint's keys; the test mint can be slow.
const OPEN = 30_000;

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

  await page.goto('/');
  await shot('1-lock');
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByTestId('amount')).toHaveText('₿0', { timeout: OPEN });
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
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
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
  await expect(page.getByText('Flat white')).toBeVisible();
  await expect(page.getByText('+₿2,100')).toBeVisible();
  await expect(page.getByText('Any device with your passkey can open this register')).toBeVisible();
  await page.waitForTimeout(400); // let the drawer finish sliding in before the picture
  await shot('5-register');
  await page.getByRole('button', { name: 'Lock' }).click();
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
  await expect(page.getByText('Flat white')).toBeVisible();

  // Cash out to a token. The passkey is asked for again and answers.
  await page.getByRole('button', { name: 'Cash out' }).click();
  await page.getByLabel('Amount to cash out').fill('100');
  await page.getByRole('button', { name: 'Make ₿100 token' }).click();
  await expect(page.getByTestId('token')).toHaveValue(/^cashuB/, { timeout: OPEN });
  await shot('6-token');
  const balance = page.getByTestId('wallet-balance');
  const left = Number((await balance.innerText()).replace(/\D/g, ''));
  expect(left).toBeLessThanOrEqual(2000);
  expect(left).toBeGreaterThanOrEqual(1990); // the test mint takes a small swap fee
  await page.getByRole('button', { name: 'Done' }).last().click();
  await expect(page.getByText('Not redeemed yet')).toBeVisible();

  // The token is still money, so seeing it again takes the passkey too.
  const showToken = page.getByRole('button', { name: 'Show token' });
  await showToken.click();
  await expect(page.getByTestId('token')).toHaveValue(/^cashuB/);
  await page.getByRole('button', { name: 'Done' }).last().click();

  // The backup screen shows the 12 words after the passkey, and hides them again on leaving.
  const showWords = page.getByRole('button', { name: 'Show the 12 words' });
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await page.getByRole('button', { name: 'Backup' }).click();
  await expect(page.getByTestId('words')).toHaveCount(0);
  await showWords.click();
  expect((await page.getByTestId('words').innerText()).trim().split(/\s+/)).toHaveLength(12);
  await back.click();

  // A stranger at the unlocked terminal: the prompt appears and they cannot pass it.
  // (Last in the test: the virtual passkey refuses everything after one failed check.)
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await showToken.click();
  await expect(showToken).toBeEnabled({ timeout: OPEN });
  await expect(page.getByTestId('token')).toHaveCount(0);

  await page.getByRole('button', { name: 'Backup' }).click();
  await showWords.click();
  await expect(showWords).toBeEnabled({ timeout: OPEN });
  await expect(page.getByTestId('words')).toHaveCount(0);
  await back.click();

  await page.getByRole('button', { name: 'Cash out' }).click();
  const make = page.getByRole('button', { name: /^Make ₿[\d,]+ token$/ });
  await make.click();
  await expect(make).toBeEnabled({ timeout: OPEN });
  await expect(page.getByTestId('token')).toHaveCount(0);
  await expect(balance).toHaveText(`₿${left.toLocaleString('en-US')}`);
  await back.click();

  // Taking a token back is safe and asks for nothing.
  await page.getByRole('button', { name: 'Take it back' }).click();
  await expect(page.getByText('Token taken back into the register.')).toBeVisible({ timeout: OPEN });
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
