import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { syncSessionRole } from './lib/session';
import './index.css';

// Before first paint would be nicer, but this is cosmetic - the API is the
// authority on what a role may do - so it runs alongside the first render
// rather than gating it behind a request.
void syncSessionRole();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
