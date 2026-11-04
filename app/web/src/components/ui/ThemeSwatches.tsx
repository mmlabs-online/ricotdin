import { useTranslation } from 'react-i18next'
import { COLOR_THEMES, type ColorTheme } from '../../theme/theme'

export function ThemeSwatches({ value, onChange }: { value: ColorTheme; onChange: (theme: ColorTheme) => void }) {
  const { t } = useTranslation()
  return (
    <div className="theme-swatches" role="group" aria-label={t('menu.colorTheme')}>
      {COLOR_THEMES.map((theme) => (
        <button
          key={theme}
          type="button"
          className={`${theme} ${value === theme ? 'active' : ''}`}
          onClick={() => onChange(theme)}
          aria-label={t('menu.useTheme', { name: t(`theme.${theme}`) })}
          aria-pressed={value === theme}
          title={t(`theme.${theme}`)}
        />
      ))}
    </div>
  )
}
