import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { attachWorker } from './store.js';
import './styles.css';

const worker = new Worker(new URL('./worker/simWorker.ts', import.meta.url), { type: 'module' });
attachWorker(worker);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
