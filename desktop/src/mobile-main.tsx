import React from 'react';
import { createRoot } from 'react-dom/client';
import { installMobilePlatform } from './react/mobile/mobile-platform';
import './react/mobile/mobile-entry.css';
import './react/mobile/MobileApp.css';

if (!window.t) {
  window.t = ((key: string) => key) as typeof window.t;
}

installMobilePlatform();

const root = document.getElementById('root');
if (!root) throw new Error('mobile root not found');

void import('./react/mobile/MobileApp').then(({ MobileApp }) => {
  createRoot(root).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  );
}).catch((err) => {
  console.error('[mobile] failed to boot renderer:', err);
  const translated = window.t?.('mobile.startupFailed');
  root.textContent = translated && translated !== 'mobile.startupFailed'
    ? translated
    : 'LucCode failed to start';
});

const MOBILE_UPDATE_AVAILABLE_EVENT = 'luc-mobile-update-available';
const MOBILE_APPLY_UPDATE_EVENT = 'luc-mobile-apply-update';

function registerMobileServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  let hadController = Boolean(navigator.serviceWorker.controller);
  let reloadOnControllerChange = false;
  let reloadStarted = false;

  const notifyUpdateAvailable = () => {
    window.__lucMobileUpdateAvailable = true;
    window.dispatchEvent(new CustomEvent(MOBILE_UPDATE_AVAILABLE_EVENT));
  };

  const reloadForUpdate = () => {
    if (reloadStarted) return;
    reloadStarted = true;
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadOnControllerChange) {
      reloadForUpdate();
      return;
    }
    if (hadController) notifyUpdateAvailable();
    hadController = true;
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyUpdateAvailable();
      }

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            notifyUpdateAvailable();
          }
        });
      });

      const checkForUpdate = () => {
        if (document.visibilityState === 'hidden') return;
        void registration.update().catch((err) => {
          console.warn('[mobile] service worker update check failed:', err);
        });
      };

      window.addEventListener(MOBILE_APPLY_UPDATE_EVENT, () => {
        if (registration.waiting) {
          reloadOnControllerChange = true;
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          return;
        }
        reloadForUpdate();
      });
      window.addEventListener('focus', checkForUpdate);
      document.addEventListener('visibilitychange', checkForUpdate);
    }).catch((err) => {
      console.warn('[mobile] service worker registration failed:', err);
    });
  });
}

registerMobileServiceWorker();
