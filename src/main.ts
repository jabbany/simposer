import './style.css';
import { App } from './app/app.ts';
import { Catalog } from './rig/catalog.ts';

async function main(): Promise<void> {
  const catalog = new Catalog();
  const warnings = await catalog.init();
  for (const w of warnings) {
    console.warn(w);
  }
  const app = new App(catalog);
  if (import.meta.env.DEV) {
    // debugging handle for the dev server only
    (window as unknown as { simposer: unknown }).simposer = app;
  }

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      console.warn('service worker registration failed', e);
    }
  }
}

if (import.meta.hot) {
  // The app owns a WebGL context; re-running it in place would leak contexts.
  import.meta.hot.accept(() => window.location.reload());
}

main().catch((e: unknown) => {
  const el = document.getElementById('status');
  if (el !== null) {
    const msg = e instanceof Error ? e.message : String(e);
    const webgl = /\bgl\b|webgl|getShaderPrecisionFormat|context/i.test(msg);
    el.textContent = webgl
      ? 'WebGL is unavailable in this browser right now. Reload the page; if that fails, restart the browser.'
      : `startup failed: ${msg}`;
    el.classList.add('error');
  }
  console.error(e);
});
