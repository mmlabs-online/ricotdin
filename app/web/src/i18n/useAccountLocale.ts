// PRF-06: the UI language is saved on the account. It is applied once per signed-in user per page
// load (module state, so moving between the user and the admin shell does not apply it again). A
// choice made on this device applies at once, settles the account value for this page load (a
// later preferences fetch never overrides it, even if the save failed) and is saved in the
// background, one save after another so the last click is the value the server keeps.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { usePreferences, useUpdatePreferences } from '../api/profile'
import { useAuth } from '../auth/AuthProvider'
import { setLocale } from '.'
import { accountLocaleToApply, type Locale } from './locale'

let settledFor: string | null = null // user id whose language is decided for this page load
let saving: Promise<unknown> = Promise.resolve()

function useUserId(): string | null {
  const { state } = useAuth()
  return state.status === 'signedIn' ? state.user.id : null
}

export function useApplyAccountLocale(): void {
  const prefs = usePreferences()
  const { i18n } = useTranslation()
  const userId = useUserId()
  const account = prefs.data?.locale
  const loaded = prefs.isSuccess
  useEffect(() => {
    if (!loaded || userId === null || settledFor === userId) return
    settledFor = userId
    const next = accountLocaleToApply(account, i18n.resolvedLanguage === 'vi' ? 'vi' : 'en')
    if (next) setLocale(next)
  }, [loaded, account, userId, i18n])
}

export function useChooseLocale(): (locale: Locale) => void {
  const save = useUpdatePreferences()
  const userId = useUserId()
  return (locale) => {
    setLocale(locale)
    settledFor = userId
    saving = saving.then(() => save.mutateAsync({ locale })).catch(() => undefined)
  }
}
