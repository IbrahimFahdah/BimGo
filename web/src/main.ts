import { initGl } from './engine/gl/Gl';
import { AppShell } from './shell/AppShell';

/**
 * Entry point (the desktop's Program.cs): create the GL context, then hand over to the shell.
 * Anything that fails before the first frame is shown as plain HTML, since the UI may not exist yet.
 */
function start(): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  try {
    initGl(canvas);
    new AppShell(canvas, __BIMGO_VERSION__).run();
  } catch (e) {
    showFatal(e instanceof Error ? e.message : String(e));
    console.error(e);
  }
}

function showFatal(message: string): void {
  const panel = document.getElementById('fatal');
  const text = document.getElementById('fatal-message');
  if (text) { text.textContent = message; }
  if (panel) { panel.style.display = 'block'; }
  document.getElementById('view')?.remove();
}

start();
