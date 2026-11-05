// Admin smoke (ARC-14c acceptance): sign in as an admin, list users, requeue a failed meeting and
// see the stand-in worker finish it, run the provider key check and save a key that never comes
// back. Same servers as core-flow (app/api/tests/e2e_server.py seeds e2e_admin and the failed meeting).
import { expect, test } from '@playwright/test'
import en from '../src/i18n/locales/en.json' with { type: 'json' }

const ADMIN = 'e2e_admin'
const PASSWORD = 'correct horse battery'
const FAILED = 'Quarterly review (failed)'
const a = en.admin

test.use({ locale: 'en-US' })

test('admin: users, requeue, key check', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/sign-in/)
  await page.locator('input[name=identifier]').fill(ADMIN)
  await page.locator('input[name=password]').fill(PASSWORD)
  await page.locator('button[type=submit]').click()
  await expect(page.getByRole('heading', { level: 1, name: a.tabs.overview })).toBeVisible()

  // users: both seeded accounts, the admin's own row marked and without a checkbox
  await page.getByRole('link', { name: a.tabs.users }).click()
  await expect(page.getByRole('heading', { level: 1, name: a.tabs.users })).toBeVisible()
  await expect(page.getByRole('link', { name: 'e2e@example.com' })).toBeVisible()
  await expect(page.getByText(a.users.you)).toBeVisible()
  await page.getByRole('searchbox').fill('e2e-admin')
  await page.getByRole('searchbox').press('Enter')
  await expect(page).toHaveURL(/q=e2e-admin/)
  await expect(page.getByRole('link', { name: 'e2e@example.com' })).toHaveCount(0)

  // pipeline: requeue the failed meeting (asks first), the stand-in worker finishes it
  await page.getByRole('link', { name: a.tabs.pipeline }).click()
  await page.getByRole('group', { name: a.pipeline.filterLabel }).getByRole('button', { name: a.pipeline.status.failed }).click()
  await expect(page).toHaveURL(/status=failed/)
  await page.getByRole('button', { name: `Requeue ${FAILED}` }).click()
  await expect(page.getByRole('dialog')).toContainText(a.pipeline.confirmBody_one.slice(0, 40))
  await page.getByRole('dialog').getByRole('button', { name: a.pipeline.requeue }).click()
  await expect(page.locator('.notice-banner')).toContainText('1 meeting queued again.')
  await page.getByRole('group', { name: a.pipeline.filterLabel }).getByRole('button', { name: a.pipeline.status.done }).click()
  await expect(page.getByRole('rowheader', { name: FAILED })).toBeVisible({ timeout: 20_000 })

  // keys: run the check (no stored key yet), then save one — the page never shows it again
  await page.getByRole('link', { name: a.tabs.keys }).click()
  await page.getByRole('button', { name: a.keys.runCheck }).click()
  await expect(page.locator('.notice-banner')).toContainText('Health check done')
  await page.getByLabel(a.keys.label).fill('E2E key')
  await page.getByLabel(a.keys.key, { exact: true }).fill('e2e-secret-key-0000-1234')
  await page.getByRole('button', { name: a.keys.add }).click()
  await expect(page.locator('.notice-banner')).toContainText(a.keys.saved)
  await expect(page.locator('.provider-card').first()).toContainText('••••1234')
  await expect(page.getByLabel(a.keys.key, { exact: true })).toHaveValue('')
  expect(await page.content()).not.toContain('e2e-secret-key-0000')

  // every admin action above is in the audit log
  await page.getByRole('link', { name: a.tabs.audit }).click()
  await expect(page.locator('.audit-table')).toContainText('meeting.requeue')
  await expect(page.locator('.audit-table')).toContainText('admin_config.create')
})
