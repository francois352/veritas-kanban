import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      refetchOnWindowFocus: true,
    },
  },
});

// Rewrite /api/* fetch calls to include base path prefix (for reverse-proxy deployments)
const _basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
if (_basePath && _basePath !== '') {
  const _originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      input = _basePath + input;
    } else if (input instanceof Request && input.url.startsWith(window.location.origin + '/api/')) {
      input = new Request(
        input.url.replace(
          window.location.origin + '/api/',
          window.location.origin + _basePath + '/api/'
        ),
        input
      );
    }
    return _originalFetch.call(window, input, init);
  } as typeof fetch;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
