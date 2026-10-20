import { Component, type ReactNode } from 'react';
import styles from './RegionalErrorBoundary.module.css';

const FALLBACK_TEXT: Record<string, { en: string; zh: string }> = {
  'error.regionUnavailable': {
    en: 'This area is temporarily unavailable',
    zh: '此区域暂时无法显示',
  },
  'action.retry': {
    en: 'Retry',
    zh: '重试',
  },
};

const tr = (key: string, vars?: Record<string, string | number>): string => {
  const translated = window.t?.(key, vars);
  if (translated && translated !== key) return translated;
  const locale = window.i18n?.locale || '';
  return FALLBACK_TEXT[key]?.[locale.startsWith('zh') ? 'zh' : 'en'] ?? key;
};

interface Props {
  region: string;
  resetKeys?: unknown[];
  autoRetry?: {
    attempts?: number;
    delayMs?: number;
  };
  children: ReactNode;
}

interface State {
  error: Error | null;
  prevResetKeys: unknown[];
  autoRetryCount: number;
  autoRetryPending: boolean;
}

export class RegionalErrorBoundary extends Component<Props, State> {
  private autoRetryTimer: number | null = null;
  private stableRenderTimer: number | null = null;

  state: State = {
    error: null,
    prevResetKeys: this.props.resetKeys || [],
    autoRetryCount: 0,
    autoRetryPending: false,
  };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKeys && state.error) {
      const changed = props.resetKeys.some((k, i) => k !== state.prevResetKeys[i]);
      if (changed) {
        return {
          error: null,
          prevResetKeys: props.resetKeys,
          autoRetryCount: 0,
          autoRetryPending: false,
        };
      }
    }
    if (props.resetKeys) return { prevResetKeys: props.resetKeys };
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RegionalErrorBoundary]', this.props.region, error, info.componentStack);
    this.scheduleAutoRetry();
    import('../../../../shared/error-bus.ts').then(({ errorBus }) => {
      import('../../../../shared/errors.ts').then(({ AppError }) => {
        errorBus.report(new AppError('RENDER_CRASH', {
          cause: error,
          context: { region: this.props.region, componentStack: info.componentStack?.slice(0, 500) },
        }));
      });
    }).catch(() => { /* best effort - error reporting itself failed */ });
  }

  componentDidUpdate(_prevProps: Props, prevState: State) {
    if (!prevState.error || this.state.error || this.state.autoRetryCount === 0) return;
    this.clearStableRenderTimer();
    this.stableRenderTimer = window.setTimeout(() => {
      this.stableRenderTimer = null;
      if (!this.state.error && this.state.autoRetryCount > 0) {
        this.setState({ autoRetryCount: 0 });
      }
    }, 600);
  }

  componentWillUnmount() {
    this.clearAutoRetryTimer();
    this.clearStableRenderTimer();
  }

  handleRetry = () => {
    this.clearAutoRetryTimer();
    this.setState({ error: null, autoRetryCount: 0, autoRetryPending: false });
  };

  private scheduleAutoRetry() {
    const config = this.props.autoRetry;
    if (!config) return;
    const attempts = Math.max(0, config.attempts ?? 1);
    if (attempts <= 0 || this.state.autoRetryCount >= attempts) return;
    const delayMs = Math.max(0, config.delayMs ?? 120);
    this.clearAutoRetryTimer();
    this.setState({ autoRetryPending: true });
    this.autoRetryTimer = window.setTimeout(() => {
      this.autoRetryTimer = null;
      this.setState((state) => ({
        error: null,
        autoRetryPending: false,
        autoRetryCount: state.autoRetryCount + 1,
      }));
    }, delayMs);
  }

  private clearAutoRetryTimer() {
    if (this.autoRetryTimer === null) return;
    window.clearTimeout(this.autoRetryTimer);
    this.autoRetryTimer = null;
  }

  private clearStableRenderTimer() {
    if (this.stableRenderTimer === null) return;
    window.clearTimeout(this.stableRenderTimer);
    this.stableRenderTimer = null;
  }

  render() {
    if (this.state.error) {
      if (this.state.autoRetryPending) {
        return <div className={styles.recovering} aria-hidden="true" />;
      }
      return (
        <div className={styles.fallback}>
          <p className={styles.message}>{tr('error.regionUnavailable')}</p>
          <button className={styles.retry} onClick={this.handleRetry}>
            {tr('action.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
