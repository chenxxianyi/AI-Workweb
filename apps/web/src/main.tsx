import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './app/app';

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
