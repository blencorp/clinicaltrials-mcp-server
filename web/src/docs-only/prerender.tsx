import { renderToString } from 'react-dom/server';
import { Home } from '@/docs-only/home';
import { Policy, policyTitle } from '@/pages/policy';
import { brand } from '@/brand';

// Build-time entry of the `docs-only` build (web/prerender.ts): every page the anonymous server
// serves, rendered with the docs-only brand. Keep the markup in step with main.tsx's routes.
export function render(path: string) {
  if (path === '/') return { html: renderToString(<Home />), title: brand.name };
  const kind = path === '/privacy-policy' ? 'privacy' : 'terms';
  return { html: renderToString(<Policy kind={kind} />), title: `${policyTitle(kind)} · ${brand.name}` };
}
