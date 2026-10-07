import { describe, expect, it } from 'vitest';
import { EditOp } from '../src/core/edits/EditMessages';
import { editRequestJson, isSessionUrl, readEditResult, readLaunch } from '../src/core/live/LiveProtocol';
import { vec3 } from '../src/core/math/Vector';

const SESSION = '0123456789abcdef0123456789abcdef';

describe('LiveProtocol', () => {
  it('reads loopback launch links only', () => {
    expect(readLaunch(`?live=127.0.0.1:47800&session=${SESSION}`, '#token=abcdef0123456789')).toEqual({ host: '127.0.0.1:47800', sessionId: SESSION, token: 'abcdef0123456789' });
    expect(readLaunch(`?live=localhost:47801&session=${SESSION.toUpperCase()}`, '')?.sessionId).toBe(SESSION);
    expect(readLaunch(`?live=evil.example:80&session=${SESSION}`, '#token=abcdef0123456789')).toBeNull();
    expect(readLaunch(`?live=127.0.0.1:47800&session=../x`, '')).toBeNull();
    expect(readLaunch('', '')).toBeNull();
  });

  it('only downloads snapshots from the session host', () => {
    const launch = { host: '127.0.0.1:47800', sessionId: SESSION, token: 't' };
    expect(isSessionUrl(`http://127.0.0.1:47800/snapshot/${SESSION}/2`, launch)).toBe(true);
    expect(isSessionUrl(`http://127.0.0.1:47801/snapshot/${SESSION}/2`, launch)).toBe(false);
    expect(isSessionUrl('https://example.com/x', launch)).toBe(false);
  });

  it('writes edits and reads results like System.Text.Json', () => {
    const json = editRequestJson({ ticket: 3, op: EditOp.Copy, elementId: 42, newCloneKey: 2, pivot: vec3(Math.fround(0.3), 1, 2), translation: vec3(0, 2, 0), angle: 0.5, label: 'Clone Chair' });
    expect(json).toEqual({ ticket: 3, op: 'copy', elementId: 42, targetCloneKey: 0, newCloneKey: 2, pivot: [0.3, 1, 2], translation: [0, 2, 0], angle: 0.5, label: 'Clone Chair' });
    const result = readEditResult({ ticket: 3, op: 'phaseDemolish', success: true, affectedIds: [42, 43], newElementId: 0, cloneKey: 0 });
    expect(result).toMatchObject({ ticket: 3, op: EditOp.PhaseDemolish, success: true, affectedIds: [42, 43] });
  });
});
