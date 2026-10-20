/**
 * WeChat platform section — uses QR scan instead of token input.
 */
import React from 'react';
import { t } from '../../helpers';
import { lucFetch } from '../../api';
import { Toggle } from '@/ui';
import { BridgeStatusDot, BridgeStatusText } from './BridgeWidgets';
import { SettingsSection } from '../../components/SettingsSection';
import bridgeStyles from '../BridgeTab.module.css';

interface WechatSectionProps {
  // undefined 表示 bridge status 还未加载完成；让 Toggle 走加载态而不是"假关"
  status: { status?: string; error?: string; enabled?: boolean; token?: string } | undefined;
  showToast: (msg: string, type: 'success' | 'error') => void;
  onSaveConfig: (credentials: Record<string, string> | null, enabled?: boolean) => Promise<void>;
  onReload: () => Promise<void>;
  agentId: string | null;
}

export function WechatSection({ status, showToast, onSaveConfig, onReload, agentId }: WechatSectionProps) {
  const unbind = async () => {
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await Promise.all([
        lucFetch(`/api/bridge/config${agentQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'wechat', credentials: { botToken: '' }, enabled: false }),
        }),
        lucFetch(`/api/bridge/owner${agentQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'wechat', userId: null }),
        }),
      ]);
      showToast(t('settings.bridge.wechatUnbound'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
    await onReload();
  };

  const toggleOn = status === undefined ? undefined : !!status.enabled;

  /** 状态 + Toggle 作为 section 右上角 context */
  const statusContext = (
    <div className="bridge-platform-header" style={{ margin: 0 }}>
      <BridgeStatusDot status={status?.status} />
      <BridgeStatusText status={status?.status} error={status?.error} />
      <Toggle
        on={toggleOn}
        onChange={async (on) => {
          if (on && !status?.token) { showToast(t('settings.bridge.wechatNeedScan'), 'error'); return; }
          await onSaveConfig(null, on);
        }}
      />
    </div>
  );

  return (
    <SettingsSection title={t('settings.bridge.wechat')} context={statusContext}>
      <div style={{ padding: 'var(--space-8) var(--space-16)' }}>
        {status?.token ? (
          <div className={bridgeStyles['wechat-logged-in']}>
            <span className={bridgeStyles['wechat-login-info']}>
              {t('settings.bridge.wechatLoggedIn')}
            </span>
            <div className={bridgeStyles['wechat-btn-row']}>
              <button className="bridge-test-btn" onClick={() => window.dispatchEvent(new CustomEvent('luc-show-wechat-qrcode', { detail: { agentId } }))}>
                {t('settings.bridge.wechatRescan')}
              </button>
              <button className="bridge-test-btn" onClick={unbind}>
                {t('settings.bridge.wechatUnbind')}
              </button>
            </div>
          </div>
        ) : (
          <div className={bridgeStyles['wechat-scan-row']}>
            <button className="bridge-test-btn" onClick={() => window.dispatchEvent(new CustomEvent('luc-show-wechat-qrcode', { detail: { agentId } }))}>
              {t('settings.bridge.wechatScan')}
            </button>
          </div>
        )}
        <div className={bridgeStyles['wechat-hints']}>
          <div>{t('settings.bridge.wechatHint')}</div>
          <div>{t('settings.bridge.wechatExclusive')}</div>
          <div className={bridgeStyles['wechat-info-reminder']}>
            {t('settings.bridge.wechatReplyWindowReminder')}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
