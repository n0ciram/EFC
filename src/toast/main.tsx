import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installSpringVariables } from '../animations/spring';
import { ToastStack } from '../components/ToastStack';
import { getApi } from '../lib/api';
import '../styles/tokens.css';
import '../styles/toast.css';

installSpringVariables();

void getApi().then((api) => {
  const container = document.getElementById('root');
  if (!container) return;
  createRoot(container).render(
    <StrictMode>
      <ToastStack api={api.toast} />
    </StrictMode>,
  );
});
