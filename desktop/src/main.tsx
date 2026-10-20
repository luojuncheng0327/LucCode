import { createRoot } from 'react-dom/client';
import App from './react/App';

function markLaunch(event: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[luc-launch] ${event}`);
  } else {
    console.info(`[luc-launch] ${event}`, details);
  }
}

markLaunch('renderer-entry');

window.addEventListener('securitypolicyviolation', (event) => {
  markLaunch('securitypolicyviolation', JSON.stringify({
    blockedURI: event.blockedURI,
    violatedDirective: event.violatedDirective,
    effectiveDirective: event.effectiveDirective,
    originalPolicy: event.originalPolicy,
    disposition: event.disposition,
    sourceFile: event.sourceFile,
    lineNumber: event.lineNumber,
    columnNumber: event.columnNumber,
  }));
});

const el = document.getElementById('react-root');
if (el) {
  markLaunch('root-mount-start');
  createRoot(el).render(<App />);
  markLaunch('root-mounted');
} else {
  markLaunch('react-root-missing');
}
