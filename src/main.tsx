/**
 * Entry point.
 *
 * The window is created hidden (`visible: false` in tauri.conf.json) and is only
 * shown once React has painted and the backend has reported it is ready. That
 * avoids the white flash a webview shows while it boots, and it means the first
 * frame the moderator sees is the real UI rather than an empty shell.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles/tokens.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/pages.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('SRCTools could not start: the #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
