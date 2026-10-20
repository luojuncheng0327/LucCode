import { ChannelTabBar } from '../channels/ChannelTabBar';
import { WidgetButtons } from '../plugin/WidgetButtons';
import { WindowControls } from '../WindowControls';

interface AppTitlebarProps {
  sidebarOpen: boolean;
  jianOpen: boolean;
  onToggleSidebar: () => void;
  onToggleJian: () => void;
  onNewSession?: () => void;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  centerTitle?: string | null;
  showNewSessionButton?: boolean;
  showPreviewToggle?: boolean;
  showChannelTabs?: boolean;
  showWidgetButtons?: boolean;
  onLeftMouseEnter?: () => void;
  onRightMouseEnter?: () => void;
  onToggleMouseLeave?: () => void;
}

export function AppTitlebar({
  sidebarOpen,
  jianOpen,
  onToggleSidebar,
  onToggleJian,
  onNewSession,
  previewOpen = false,
  onTogglePreview,
  centerTitle = null,
  showNewSessionButton = false,
  showPreviewToggle = false,
  showChannelTabs = true,
  showWidgetButtons = true,
  onLeftMouseEnter,
  onRightMouseEnter,
  onToggleMouseLeave,
}: AppTitlebarProps) {
  const t = window.t ?? ((p: string) => p);

  return (
    <div className="titlebar">
      <div className="tb-left-group">
        <button
          className={`tb-toggle tb-toggle-left${sidebarOpen ? ' active' : ''}`}
          id="tbToggleLeft"
          title={t('sidebar.toggle')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleSidebar}
          onMouseEnter={onLeftMouseEnter}
          onMouseLeave={onToggleMouseLeave}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
        {showNewSessionButton && onNewSession && (
          <button
            className="tb-toggle tb-new-session"
            type="button"
            title={t('sidebar.newChat')}
            aria-label={t('sidebar.newChat')}
            data-mobile-titlebar-action="new-session"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onNewSession}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        )}
      </div>
      {centerTitle && (
        <div className="tb-center-title" aria-label={t('titlebar.currentChatTitle')} title={centerTitle}>
          <span>{centerTitle}</span>
        </div>
      )}
      {showChannelTabs && <ChannelTabBar />}
      <div className="tb-right-group">
        {showWidgetButtons && <WidgetButtons />}
        {showPreviewToggle && onTogglePreview && (
          <button
            className={`tb-toggle tb-toggle-preview${previewOpen ? ' active' : ''}`}
            id="tbTogglePreview"
            title={t('preview.toggle')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onTogglePreview}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 3.5h7l3 3v14H7z"></path>
              <path d="M14 3.5v3h3"></path>
              <path d="M9.5 11h5"></path>
              <path d="M9.5 14.5h5"></path>
            </svg>
          </button>
        )}
        <button
          className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
          id="tbToggleRight"
          title={t('sidebar.jian')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleJian}
          onMouseEnter={onRightMouseEnter}
          onMouseLeave={onToggleMouseLeave}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
        </button>
      </div>
      <WindowControls />
    </div>
  );
}
