import { useSyncExternalStore } from 'react';
import { Landing } from '@/components/kit/landing';

const subscribe = () => () => undefined;

/** The landing page of the docs-only server: one anonymous URL, the address this page was served from. */
export function Home() {
  // The page is prerendered, so it cannot know its own address: the server snapshot leaves it out
  // (and so does hydration); the browser then reads it.
  const origin = useSyncExternalStore(subscribe, () => window.location.origin, () => undefined);
  return <Landing accountUrl={`${origin ?? '<this site’s address>'}/mcp`} />;
}
