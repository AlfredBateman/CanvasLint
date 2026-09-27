import React from 'react';
import { createRoot } from 'react-dom/client';
import { PanelApp } from './PanelApp';
import './panel.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <React.StrictMode>
    <PanelApp />
  </React.StrictMode>
);
