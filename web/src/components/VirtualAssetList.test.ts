import { describe, expect, it } from 'vitest';
import { virtualWindow } from './VirtualAssetList';

describe('VirtualAssetList', () => {
  it('keeps the rendered window bounded at the 1000-asset target scale', () => {
    const top = virtualWindow(1000, 0);
    const middle = virtualWindow(1000, 104 * 500);
    expect(top.end - top.start).toBeLessThan(30);
    expect(middle.end - middle.start).toBeLessThan(30);
    expect(middle.start).toBeGreaterThan(450);
  });
});
