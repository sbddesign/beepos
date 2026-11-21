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

async function openRegister(page: Page) {
  const done = page.getByRole('button', { name: 'Done' });
  if (!(await page.getByTestId('wallet-balance').isVisible())) {
    await page.getByTestId('balance').click();
  }
  return done;
}

test('create a passkey, take a payment, and open the register on a second device', async ({
  context,
  page,
}, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  await addAuthenticator(context, page);
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
  await shot('2-invoice');

  // The test mint pays the invoice by itself.
  await expect(page.getByRole('status').filter({ hasText: 'Paid' })).toBeVisible({ timeout: 60_000 });
  await shot('3-paid');
  await page.getByRole('button', { name: 'New sale' }).click();
  await expect(page.getByTestId('balance')).toHaveText('₿2,100', { timeout: OPEN });
  await expect(page.getByTestId('amount')).toHaveText('₿0');
  await shot('4-keypad');

  // A reload keeps the session; locking asks for the passkey again.
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('₿2,100', { timeout: OPEN });
  await openRegister(page);
  await expect(page.getByText('Flat white')).toBeVisible();
  await expect(page.getByText('+₿2,100')).toBeVisible();
  await expect(page.getByText('Any device with your passkey can open this register')).toBeVisible();
  await shot('5-register');
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('button', { name: 'Unlock with passkey' }).click();
  await expect(page.getByTestId('balance')).toHaveText('₿2,100', { timeout: OPEN });

  // Second device: nothing but the passkey. A wiped browser stands in for it,
  // so the sale has to come back from the vault server.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByRole('button', { name: 'I already have a passkey' }).click();
  await expect(page.getByTestId('balance')).toHaveText('₿2,100', { timeout: OPEN });
  await openRegister(page);
  await expect(page.getByText('Flat white')).toBeVisible();

  // Cash out to a token.
  await page.getByRole('button', { name: 'Cash out' }).click();
  await page.getByLabel('Amount to cash out').fill('100');
  await page.getByRole('button', { name: 'Make ₿100 token' }).click();
  await expect(page.getByTestId('token')).toHaveValue(/^cashuB/, { timeout: OPEN });
  await shot('6-token');
  const left = Number((await page.getByTestId('wallet-balance').innerText()).replace(/\D/g, ''));
  expect(left).toBeLessThanOrEqual(2000);
  expect(left).toBeGreaterThanOrEqual(1990); // the test mint takes a small swap fee
  await page.getByRole('button', { name: 'Done' }).last().click();
  await expect(page.getByText('Not redeemed yet')).toBeVisible();

  // The backup screen offers the 12 words.
  await page.getByRole('button', { name: 'Backup' }).click();
  await page.getByText('Show the 12 words').click();
  expect((await page.getByTestId('words').innerText()).trim().split(/\s+/)).toHaveLength(12);
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
