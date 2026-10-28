import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installSpringVariables } from '../animations/spring';
import { SettingsPanel } from '../components/SettingsPanel';
import { getApi } from '../lib/api';
import '../styles/tokens.css';
import '../styles/settings.css';

installSpringVariables();

void getApi().then((api) => {
  const container = document.getElementById('root');
  if (!container) return;
  createRoot(container).render(
    <StrictMode>
      <SettingsPanel api={api.settings} />
    </StrictMode>,
  );
});
