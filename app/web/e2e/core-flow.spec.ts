// Core flow in EN and VI (ARC-13 acceptance): sign in → upload → processing → results → chat.
import { expect, test, type Page } from '@playwright/test'
import en from '../src/i18n/locales/en.json' with { type: 'json' }
import vi from '../src/i18n/locales/vi.json' with { type: 'json' }

const USER = 'e2e_user'
const PASSWORD = 'correct horse battery'

/** The browser's resumable PUT to Google Drive, answered like Drive does. */
async function stubDrive(page: Page) {
  await page.route('https://www.googleapis.com/upload/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: `e2e-${Date.now()}` }) }),
  )
}

for (const [lang, t, locale] of [
  ['en', en, 'en-US'],
  ['vi', vi, 'vi-VN'],
] as const) {
  test.describe(`core flow (${lang})`, () => {
    test.use({ locale })

    test('sign in, upload, see the results and ask about them', async ({ page }) => {
      await stubDrive(page)

      // sign in
      await page.goto('/meetings')
      await expect(page).toHaveURL(/\/sign-in/)
      await page.locator('input[name=identifier]').fill(USER)
      await page.locator('input[name=password]').fill(PASSWORD)
      await page.locator('button[type=submit]').click()
      await expect(page.getByRole('heading', { level: 1, name: t.page.meetings.title })).toBeVisible()

      // upload a recording
      await page.goto('/record')
      await page.locator('input[type=file]').setInputFiles({ name: `standup-${lang}.mp3`, mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 1) })
      await page.getByRole('button', { name: t.upload.start }).click()
      await page.getByRole('link', { name: t.upload.openMeeting }).click()

      // processing → done (the stand-in worker finishes the job; the page polls)
      await expect(page.getByRole('tab', { name: t.detail.tabs.summary })).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('tabpanel')).toContainText('thirty design partners')
      await page.getByRole('tab', { name: t.detail.tabs.transcript }).click()
      await expect(page.getByRole('tabpanel')).toContainText('onboarding copy')

      // ask about this meeting; the citation seeks the transcript
      await page.getByLabel(t.detail.chat.inputLabel).fill(lang === 'vi' ? 'Bản beta có bao nhiêu đối tác?' : 'How many partners in the beta?')
      await page.getByLabel(t.detail.chat.inputLabel).press('Enter')
      const citation = page.locator('.detail-chat .citations button').first()
      await expect(citation).toBeVisible()
      await page.getByRole('tab', { name: t.detail.tabs.summary }).click()
      await citation.click()
      await expect(page.getByRole('tab', { name: t.detail.tabs.transcript })).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('.transcript-row.active')).toBeVisible()

      // edit the summary in the rich-text editor, then restore the AI version (PRO-06)
      const panel = page.getByRole('tabpanel')
      await page.getByRole('tab', { name: t.detail.tabs.summary }).click()
      await page.getByRole('button', { name: t.detail.edit.actionSummary }).click()
      const editor = page.locator('.rich-editor-content')
      await expect(editor).toBeFocused()
      await editor.press('Control+End')
      await editor.pressSequentially(' Edited in e2e.')
      await page.getByRole('button', { name: t.detail.edit.save, exact: true }).click()
      await expect(panel).toContainText('Edited in e2e.')
      await page.getByRole('button', { name: t.detail.history.actionSummary }).click()
      const drawer = page.getByRole('dialog', { name: t.detail.history.title.summary })
      await expect(drawer.locator('.version-row')).toHaveCount(2)
      await drawer.getByRole('button', { name: t.detail.history.source.ai }).click()
      await expect(drawer.locator('.version-text')).toContainText('thirty design partners')
      await drawer.getByRole('button', { name: t.detail.history.restore }).click()
      await drawer.getByRole('button', { name: t.detail.history.confirmAction, exact: true }).click()
      await expect(drawer).toBeHidden()
      await expect(panel).not.toContainText('Edited in e2e.')
      await expect(page.getByRole('button', { name: t.detail.history.actionSummary })).toBeFocused()

      // the Chat page answers across meetings and links back to the moment
      await page.goto('/chat')
      await page.getByLabel(t.chatPage.inputLabel).fill(lang === 'vi' ? 'Đã quyết định gì?' : 'What was decided?')
      await page.getByLabel(t.chatPage.inputLabel).press('Enter')
      const link = page.locator('.citation-link').first()
      await expect(link).toBeVisible()
      await link.click()
      await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+\?t=\d+/)
      await expect(page.locator('.transcript-row.active')).toBeVisible()
    })
  })
}
