import { useEffect, useMemo } from 'react';
import { useStore } from '../../stores';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import s from './PluginPageView.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface Props {
  pluginId: string;
}

export function PluginPageView({ pluginId }: Props) {
  const pages = useStore(st => st.pluginPages);
  const agentId = useStore(st => st.currentAgentId);
  const page = useMemo(() => pages.find(p => p.pluginId === pluginId), [pages, pluginId]);

  const surfaceUrl = usePluginSurfaceUrl(page?.routeUrl ?? null, agentId);

  const { iframeRef, status: iframeStatus, postToIframe, retry: retryIframe } = usePluginIframe(surfaceUrl.iframeSrc, {
    pluginId,
    agentId,
    slot: 'page',
    readyOnTimeout: true,
    capabilityGrants: page?.hostCapabilities ?? [],
  });
  const status = surfaceUrl.status === 'ready' ? iframeStatus : surfaceUrl.status;
  const retry = () => {
    surfaceUrl.retry();
    retryIframe();
  };

  useEffect(() => {
    if (status === 'ready') postToIframe('visibility-changed', { visible: true });
    return () => { postToIframe('visibility-changed', { visible: false }); };
  }, [status, postToIframe]);

  if (!page) {
    return (
      <div className={s.container}>
        <div className={s.error}>{t('plugin.page.notFound')}</div>
      </div>
    );
  }

  return (
    <div className={s.container}>
      {status === 'loading' && (
        <div className={s.overlay}><div className={s.spinner} /></div>
      )}
      {status === 'error' && (
        <div className={s.overlay}>
          <p>{t('plugin.page.loadFailed')}</p>
          <button className={s.retryBtn} onClick={retry}>{t('plugin.page.retry')}</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className={s.iframe}
        src={surfaceUrl.iframeSrc || undefined}
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        style={{ opacity: status === 'ready' ? 1 : 0 }}
      />
    </div>
  );
}
