import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.tsx';
import './app/styles.css';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Missing #root application mount point.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
