import { withPublicBasePath } from '@app/utils/publicBasePath';
import axios from 'axios';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import App from './App';

axios.interceptors.request.use((config) => {
  if (typeof config.url === 'string') {
    config.url = withPublicBasePath(config.url);
  }
  return config;
});

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>
);
