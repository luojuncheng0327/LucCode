/** OnboardingApp.tsx — Orchestration layer (6 steps, each in ./steps/) */

import { useState, useEffect, useRef, useCallback } from 'react';
import { TOTAL_STEPS } from './constants';
import { createOnboardingVerificationPlan, resolveOnboardingAgentId } from './onboarding-actions';
import type { LucFetch } from './onboarding-actions';
import { LocaleStep } from './steps/LocaleStep';
import { NameStep } from './steps/NameStep';
import { ProviderStep } from './steps/ProviderStep';
import { ModelStep } from './steps/ModelStep';
import { WorkspaceStep } from './steps/WorkspaceStep';
import { TutorialStep } from './steps/TutorialStep';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  connectDeviceServerConnection,
  createLocalServerConnection,
  persistServerConnectionSelection,
  type ServerConnection,
} from '../services/server-connection';

interface OnboardingAppProps { preview: boolean; skipToTutorial: boolean }
export function OnboardingApp({ preview, skipToTutorial }: OnboardingAppProps) {
  const [serverConnection, setServerConnection] = useState<ServerConnection | null>(null);
  const [agentId, setAgentId] = useState('');
  const [initError, setInitError] = useState('');
  const [step, setStep] = useState(skipToTutorial ? 5 : 0);
  const [stepKey, setStepKey] = useState(0);
  const [agentName, setAgentName] = useState('Luc');
  const [avatarSrc, setAvatarSrc] = useState('assets/Luc.png');
  const [locale, setLocale] = useState('zh-CN');
  const [i18nReady, setI18nReady] = useState(false);

  // Provider info passed from ProviderStep to ModelStep
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerApi, setProviderApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');

  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localeLoadSeq = useRef(0);
  const verificationPlan = useRef(createOnboardingVerificationPlan()).current;

  const lucFetch: LucFetch = useCallback((path, opts = {}) => {
    if (!serverConnection) {
      throw new Error(`onboarding lucFetch ${path}: server connection not ready`);
    }
    const headers = appendConnectionAuth(serverConnection, opts.headers);
    return fetch(buildConnectionUrl(serverConnection, path), { ...opts, headers });
  }, [serverConnection]);

  const showError = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 3000);
  }, []);

  const goToStep = useCallback((index: number) => {
    if (index < 0 || index >= TOTAL_STEPS) return;
    setStepKey(k => k + 1);
    setStep(index);
  }, []);

  const onLocaleChange = useCallback(async (loc: string) => {
    const seq = localeLoadSeq.current + 1;
    localeLoadSeq.current = seq;
    setLocale(loc);
    setI18nReady(false);
    try {
      await i18n.load(loc);
    } catch (err) {
      console.error('[onboarding] locale load failed:', err);
    } finally {
      if (localeLoadSeq.current === seq) {
        setI18nReady(true);
      }
    }
  }, []);

  const onProviderReady = useCallback((name: string, url: string, api: string, key: string) => {
    setProviderName(name);
    setProviderUrl(url);
    setProviderApi(api);
    setApiKey(key);
  }, []);

  const connectLanServer = useCallback(async (baseUrl: string, credential: string) => {
    const connection = await connectDeviceServerConnection({ baseUrl, credential });
    persistServerConnectionSelection(connection);
    setServerConnection(connection);
    if (!preview) {
      await window.luc.onboardingComplete?.();
    }
  }, [preview]);

  useEffect(() => {
    (async () => {
      let localeLoaded = false;
      try {
        const port = await window.luc.getServerPort();
        const token = await window.luc.getServerToken();
        const connection = createLocalServerConnection({ serverPort: port, serverToken: token });
        if (!connection) throw new Error('Local server connection is unavailable');
        setServerConnection(connection);
        const splashInfo = await window.luc.getSplashInfo?.();
        const loc = splashInfo?.locale || 'zh-CN';
        const name = splashInfo?.agentName || 'Luc';
        setLocale(loc);
        setAgentName(name);
        await i18n.load(loc);
        localeLoaded = true;
        i18n.defaultName = name;
        try {
          const localPath = await window.luc.getAvatarPath?.('agent');
          if (localPath) setAvatarSrc(window.platform?.getFileUrl?.(localPath) ?? '');
        } catch { /* ignore */ }
        if (!preview) {
          const connectionFetch: LucFetch = (path, opts = {}) => {
            const headers = appendConnectionAuth(connection, opts.headers);
            return fetch(buildConnectionUrl(connection, path), { ...opts, headers });
          };
          setAgentId(await resolveOnboardingAgentId(connectionFetch));
        }
        setI18nReady(true);
      } catch (err) {
        console.error('[onboarding] init failed:', err);
        if (!localeLoaded) {
          try { await i18n.load('zh-CN'); } catch { /* keep the visible fallback below */ }
        }
        setInitError(err instanceof Error ? err.message : String(err));
        setI18nReady(true);
      }
    })();
  }, [preview]);

  if (!i18nReady) return null;
  const activeStep = initError ? 0 : step;
  const visibleError = toastMsg || initError;

  return (
    <div className="onboarding">
      <div className="onboarding-progress">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div key={`dot-${i}`} className={`onboarding-dot${i === activeStep ? ' active' : ''}${i < activeStep ? ' done' : ''}`} />
        ))}
      </div>

      {activeStep === 0 && <LocaleStep key={`step-0-${stepKey}`} preview={preview} lucFetch={lucFetch} agentId={agentId} verificationPlan={verificationPlan} avatarSrc={avatarSrc} initialLocale={locale} goToStep={goToStep} showError={showError} onLocaleChange={onLocaleChange} onConnectLanServer={connectLanServer} />}
      {activeStep === 1 && <NameStep key={`step-1-${stepKey}`} preview={preview} lucFetch={lucFetch} agentId={agentId} verificationPlan={verificationPlan} goToStep={goToStep} showError={showError} />}
      {activeStep === 2 && <ProviderStep key={`step-2-${stepKey}`} preview={preview} lucFetch={lucFetch} agentId={agentId} verificationPlan={verificationPlan} goToStep={goToStep} showError={showError} onProviderReady={onProviderReady} />}
      {activeStep === 3 && <ModelStep key={`step-3-${stepKey}`} preview={preview} lucFetch={lucFetch} agentId={agentId} verificationPlan={verificationPlan} providerName={providerName} providerUrl={providerUrl} providerApi={providerApi} apiKey={apiKey} goToStep={goToStep} showError={showError} />}
      {activeStep === 4 && <WorkspaceStep key={`step-4-${stepKey}`} preview={preview} lucFetch={lucFetch} agentId={agentId} verificationPlan={verificationPlan} goToStep={goToStep} showError={showError} />}
      {activeStep === 5 && <TutorialStep key={`step-5-${stepKey}`} preview={preview} lucFetch={lucFetch} agentId={agentId} verificationPlan={verificationPlan} showError={showError} />}

      {visibleError && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--coral, #c66)', color: '#fff', padding: '8px 20px', borderRadius: 8, fontSize: '0.82rem', zIndex: 999 }}>
          {visibleError}
        </div>
      )}
    </div>
  );
}
