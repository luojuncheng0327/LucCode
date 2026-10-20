/**
 * NameStep.tsx — Step 1: Identity and memory setup
 */

import { useState, useCallback } from 'react';
import { Toggle } from '../../settings/widgets/Toggle';
import { describeOnboardingError, saveOnboardingIdentity } from '../onboarding-actions';
import type { LucFetch, OnboardingVerificationPlan } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

interface NameStepProps {
  preview: boolean;
  lucFetch: LucFetch;
  agentId: string;
  verificationPlan: OnboardingVerificationPlan;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
}

export function NameStep({ preview, lucFetch, agentId, verificationPlan, goToStep, showError }: NameStepProps) {
  const [userName, setUserName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [memoryEnabled, setMemoryEnabled] = useState(true);

  const onNext = useCallback(async () => {
    if (preview) { goToStep(2); return; }
    const trimmed = userName.trim();
    if (!trimmed) return;
    try {
      await saveOnboardingIdentity({
        lucFetch,
        agentId,
        userName: trimmed,
        agentName,
        memoryEnabled,
        verificationPlan,
      });
      goToStep(2);
    } catch (err) {
      console.error('[onboarding] save identity failed:', err);
      showError(describeOnboardingError(err, t('onboarding.error')));
    }
  }, [preview, lucFetch, agentId, userName, agentName, memoryEnabled, verificationPlan, goToStep, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.name.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.name.subtitle')}</p>
      <div className="ob-name-form">
        <label className="ob-name-field">
          <span className="ob-field-label">{t('onboarding.name.userLabel')}</span>
          <input
            className="ob-input"
            type="text"
            placeholder={t('onboarding.name.placeholder')}
            value={userName}
            onChange={e => setUserName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="ob-name-field">
          <span className="ob-field-label">{t('onboarding.name.agentLabel')}</span>
          <input
            className="ob-input"
            type="text"
            placeholder={t('onboarding.name.agentPlaceholder')}
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="ob-memory-row">
          <div className="ob-memory-copy">
            <span className="ob-memory-title">{t('onboarding.name.memoryTitle')}</span>
            <span className="ob-memory-hint">{t('onboarding.name.memoryHint')}</span>
          </div>
          <Toggle on={memoryEnabled} onChange={setMemoryEnabled} label={t('onboarding.name.memoryTitle')} />
        </div>
      </div>
      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(0)}>
          {t('onboarding.name.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={!preview && !userName.trim()}
          onClick={onNext}
        >
          {t('onboarding.name.next')}
        </button>
      </div>
    </StepContainer>
  );
}
