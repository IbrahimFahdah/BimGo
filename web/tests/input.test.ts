import { describe, expect, it } from 'vitest';
import { blocksBrowserDefault, InputState, Vk, vkFromCode } from '../src/platform/input';

describe('vkFromCode', () => {
  it('maps letters, digits, F-keys and named keys to Win32 codes', () => {
    expect(vkFromCode('KeyO')).toBe(0x4f);
    expect(vkFromCode('Digit1')).toBe(0x31);
    expect(vkFromCode('Numpad5')).toBe(Vk.NUMPAD0 + 5);
    expect(vkFromCode('F1')).toBe(Vk.F1);
    expect(vkFromCode('F12')).toBe(Vk.F12);
    expect(vkFromCode('PageUp')).toBe(Vk.PRIOR);
    expect(vkFromCode('ShiftLeft')).toBe(Vk.LSHIFT);
    expect(vkFromCode('MediaPlayPause')).toBe(-1);
  });
});

describe('blocksBrowserDefault', () => {
  it('blocks reload, help, focus moves and save / open but leaves DevTools alone', () => {
    expect(blocksBrowserDefault(Vk.F5, false, false)).toBe(true);
    expect(blocksBrowserDefault(Vk.F1, false, false)).toBe(true);
    expect(blocksBrowserDefault(Vk.TAB, false, false)).toBe(true);
    expect(blocksBrowserDefault(Vk.key('S'), true, false)).toBe(true);
    expect(blocksBrowserDefault(Vk.key('S'), false, false)).toBe(false);
    expect(blocksBrowserDefault(Vk.key('3'), false, true)).toBe(true);
    expect(blocksBrowserDefault(Vk.F12, false, false)).toBe(false);
  });
});

describe('InputState', () => {
  it('reports presses once, then repeats, and clears edges each frame', () => {
    const input = new InputState();
    input.onKey(Vk.key('W'), true, false);
    expect(input.isPressed(Vk.key('W'))).toBe(true);
    input.endFrame();
    input.onKey(Vk.key('W'), true, true);
    expect(input.isPressed(Vk.key('W'))).toBe(false);
    expect(input.isPressedOrRepeated(Vk.key('W'))).toBe(true);
    expect(input.isDown(Vk.key('W'))).toBe(true);
    input.releaseAll();
    expect(input.isDown(Vk.key('W'))).toBe(false);
  });

  it('turns mouse buttons into pressed / released edges', () => {
    const input = new InputState();
    input.onLeft(true);
    expect(input.leftPressed).toBe(true);
    input.consumeClicks();
    expect(input.leftPressed).toBe(false);
    input.onLeft(false);
    expect(input.leftReleased).toBe(true);
  });
});
