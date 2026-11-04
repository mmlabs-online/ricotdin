import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { PlaceholderPage } from './PlaceholderPage'

export function MeetingDetailPage() {
  const { t } = useTranslation()
  return (
    <PlaceholderPage titleKey="page.meetingDetail.title" subtitleKey="page.meetingDetail.subtitle">
      <Link className="button button-ghost back-button" to="/meetings">
        {t('page.meetingDetail.back')}
      </Link>
    </PlaceholderPage>
  )
}
