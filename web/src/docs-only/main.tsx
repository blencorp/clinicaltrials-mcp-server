import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import '../index.css';

import { Home } from '@/docs-only/home';
import { Policy } from '@/pages/policy';
import { NotFound } from '@/components/kit/error-page';

// Entry of the `docs-only` build (web/docs-only.html): the pages the anonymous --public-docs
// server serves. No sign-in, consent, account or error routes: that server has no sessions.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyTheme();
dark.addEventListener('change', applyTheme);

const root = document.getElementById('root')!;
const app = (
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/privacy-policy" element={<Policy kind="privacy" />} />
        <Route path="/terms" element={<Policy kind="terms" />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);

// Every page arrives prerendered (web/prerender.ts): hydrate that markup in place.
hydrateRoot(root, app);
