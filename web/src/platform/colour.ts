/**
 * The browser's colour picker (the desktop's Windows colour dialog): one hidden <input type="color"> reused; onPicked
 * runs with 0xRRGGBB as the user picks.
 */
let input: HTMLInputElement | null = null;
let current: ((rgb: number) => void) | null = null;

export function pickColour(startRgb: number, onPicked: (rgb: number) => void): void {
  if (!input) {
    input = document.createElement('input');
    input.type = 'color';
    input.style.position = 'fixed';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.style.left = '50%';
    input.style.top = '30%';
    input.addEventListener('input', () => {
      const hex = input!.value.replace(/^#/, '');
      if (/^[0-9a-fA-F]{6}$/.test(hex)) { current?.(parseInt(hex, 16)); }
    });
    document.body.appendChild(input);
  }
  current = onPicked;
  input.value = '#' + (startRgb & 0xffffff).toString(16).padStart(6, '0');
  input.click();
}
