/**
 * LocaleStep.tsx — Step 0: Language selection
 */

import { useState, useCallback } from 'react';
import { LOCALES } from '../constants';
import { describeOnboardingError, saveLocale } from '../onboarding-actions';
import type { LucFetch, OnboardingVerificationPlan } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';

interface LocaleStepProps {
  preview: boolean;
  lucFetch: LucFetch;
  agentId: string;
  verificationPlan: OnboardingVerificationPlan;
  avatarSrc: string;
  initialLocale: string;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onLocaleChange: (locale: string) => Promise<void>;
  onConnectLanServer: (baseUrl: string, credential: string) => Promise<void>;
}

export function LocaleStep({
  preview, lucFetch, agentId, verificationPlan, avatarSrc, initialLocale,
  goToStep, showError, onLocaleChange, onConnectLanServer,
}: LocaleStepProps) {
  const [locale, setLocale] = useState(initialLocale);
  const [showLanConnect, setShowLanConnect] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [serverKey, setServerKey] = useState('');
  const [connecting, setConnecting] = useState(false);

  const changeLocale = useCallback(async (loc: string) => {
    if (locale === loc) return;
    setLocale(loc);
    await onLocaleChange(loc);
  }, [locale, onLocaleChange]);

  const onNext = useCallback(async () => {
    if (!preview) {
      try {
        await saveLocale(lucFetch, agentId, locale, verificationPlan);
      } catch (err) {
        console.error('[onboarding] save locale failed:', err);
        showError(describeOnboardingError(err, t('onboarding.error')));
        return;
      }
    }
    goToStep(1);
  }, [preview, lucFetch, agentId, locale, verificationPlan, goToStep, showError]);

  const connectExistingServer = useCallback(async () => {
    if (!serverUrl.trim() || !serverKey.trim() || connecting) return;
    setConnecting(true);
    try {
      await onConnectLanServer(serverUrl, serverKey);
    } catch (err: any) {
      showError(`${t('onboarding.remote.failed')}: ${err.message}`);
    } finally {
      setConnecting(false);
    }
  }, [connecting, onConnectLanServer, serverKey, serverUrl, showError]);

  return (
    <StepContainer>
      <img className="onboarding-avatar" src={avatarSrc} draggable={false} alt="" />
      <h1 className="onboarding-title">{t('onboarding.welcome.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.welcome.subtitle')} />
      <div className="ob-locale-picker">
        {LOCALES.map(loc => (
          <button
            key={loc.value}
            className={`ob-locale-btn${locale === loc.value ? ' active' : ''}`}
            onClick={() => changeLocale(loc.value)}
          >
            <span>{loc.label}</span>
          </button>
        ))}
      </div>
      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-primary" onClick={onNext}>
          {t('onboarding.welcome.next')}
        </button>
      </div>
      <div className="ob-remote-connect">
        {!showLanConnect ? (
          <button type="button" className="ob-remote-connect-link" onClick={() => setShowLanConnect(true)}>
            {t('onboarding.remote.link')}
          </button>
        ) : (
          <div className="ob-remote-connect-panel">
            <input
              className="ob-input"
              aria-label={t('onboarding.remote.url')}
              value={serverUrl}
              placeholder="http://192.168.31.75:14500"
              onChange={event => setServerUrl(event.target.value)}
            />
            <input
              className="ob-input"
              aria-label={t('onboarding.remote.key')}
              value={serverKey}
              type="password"
              placeholder="luc_dev_..."
              onChange={event => setServerKey(event.target.value)}
            />
            <div className="ob-remote-connect-actions">
              <button type="button" className="ob-btn ob-btn-secondary" onClick={() => setShowLanConnect(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="ob-btn ob-btn-primary"
                onClick={connectExistingServer}
                disabled={connecting || !serverUrl.trim() || !serverKey.trim()}
              >
                {connecting ? t('onboarding.remote.connecting') : t('onboarding.remote.connect')}
              </button>
            </div>
          </div>
        )}
      </div>
    </StepContainer>
  );
}
