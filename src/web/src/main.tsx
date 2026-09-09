import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/board.css';
import './styles/card.css';
import './styles/overlay.css';
import './styles/session.css';

/**
 * Boots the dashboard, installing the offline mock first when it is enabled.
 *
 * @returns Nothing, once the app is mounted.
 */
async function boot(): Promise<void> {
  if (import.meta.env.VITE_MOCK === '1') {
    const mock = await import('./dev-mock.js');
    mock.installMock();
  }
  const host = document.getElementById('root');
  if (host === null) throw new Error('index.html is missing its #root element');
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
