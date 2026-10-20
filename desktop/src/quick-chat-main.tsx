import { createRoot } from 'react-dom/client';
import { initTheme, initDragPrevention } from './react/bootstrap';
import { QuickChatApp } from './react/quick-chat/QuickChatApp';

initTheme();
initDragPrevention();

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(<QuickChatApp />);
}
