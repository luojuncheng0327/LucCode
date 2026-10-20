export function isWebRuntime(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-platform') === 'web';
}

