import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installSpringVariables } from '../animations/spring';
import { RadialWheel } from '../components/RadialWheel';
import { getApi } from '../lib/api';
import '../styles/tokens.css';
import '../styles/wheel.css';

installSpringVariables();

void getApi().then((api) => {
  const container = document.getElementById('root');
  if (!container) return;
  createRoot(container).render(
    <StrictMode>
      <RadialWheel api={api.wheel} />
    </StrictMode>,
  );
});
