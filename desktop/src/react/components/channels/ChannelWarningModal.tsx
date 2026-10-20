import { useI18n } from '../../hooks/use-i18n';
import { ConfirmDialog } from '../../ui';

interface ChannelWarningModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ChannelWarningModal({ open, onConfirm, onCancel }: ChannelWarningModalProps) {
  const { t } = useI18n();

  const bodyText = t('channel.warningBody') || '';
  const paragraphs = bodyText.split('\n\n');

  return (
    <ConfirmDialog
      open={open}
      scope="window"
      title={t('channel.warningTitle')}
      confirmLabel={t('channel.warningConfirm')}
      cancelLabel={t('channel.createCancel')}
      onConfirm={onConfirm}
      onCancel={onCancel}
      closeOnBackdrop={false}
      closeOnEsc
      zIndex={9999}
    >
      {paragraphs.map((para, i) => {
        const lines = para.split('\n');
        return (
          <p key={`warning-para-${i}`}>
            {lines.map((line, j) => (
              j === 0
                ? <span key={`warning-line-${i}-${j}`}>{line}</span>
                : <span key={`warning-line-${i}-${j}`}><br />{line}</span>
            ))}
          </p>
        );
      })}
    </ConfirmDialog>
  );
}
