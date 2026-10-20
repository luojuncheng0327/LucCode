import { useMemo } from 'react';
import { useStore } from '../../stores';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import s from './PluginWidgetView.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface Props {
  pluginId: string;
}

export function PluginWidgetView({ pluginId }: Props) {
  const widgets = useStore(st => st.pluginWidgets);
  const agentId = useStore(st => st.currentAgentId);
  const widget = useMemo(() => widgets.find(w => w.pluginId === pluginId), [widgets, pluginId]);

  const surfaceUrl = usePluginSurfaceUrl(widget?.routeUrl ?? null, agentId);

  const { iframeRef, status: iframeStatus, retry: retryIframe } = usePluginIframe(surfaceUrl.iframeSrc, {
    pluginId,
    agentId,
    slot: 'widget',
    capabilityGrants: widget?.hostCapabilities ?? [],
  });
  const status = surfaceUrl.status === 'ready' ? iframeStatus : surfaceUrl.status;
  const retry = () => {
    surfaceUrl.retry();
    retryIframe();
  };

  if (!widget) {
    return <div className={s.error}>Widget not found</div>;
  }

  return (
    <div className={s.container}>
      {status === 'loading' && (
        <div className={s.overlay}><div className={s.spinner} /></div>
      )}
      {status === 'error' && (
        <div className={s.overlay}>
          <p>{t('plugin.widget.loadFailed')}</p>
          <button className={s.retryBtn} onClick={retry}>{t('plugin.widget.retry')}</button>
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
