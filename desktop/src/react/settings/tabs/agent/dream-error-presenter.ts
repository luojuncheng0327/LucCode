import { errorWithCode, presentError } from '../../../errors/error-presenter';
import { t } from '../../helpers';
import type { DreamRunReport } from './agent-memory-dream-actions';

export function dreamErrorText(error: unknown, fallbackKey: string) {
  return presentError(error, { translate: t, fallbackKey }).text;
}

export function dreamReportErrorText(report: DreamRunReport) {
  return dreamErrorText(
    errorWithCode(report.error || '', report.errorCode || 'dream_run_failed'),
    'settings.memory.dream.failed',
  );
}
