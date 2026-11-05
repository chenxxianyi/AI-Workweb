import { expect, it } from 'vitest';
import { classifyDisk } from './disk-capacity';
it('disk reserve boundaries keep ordinary reads available and reject high volume below10%', () => {
  expect(classifyDisk(20, 100).status).toBe('ok');
  expect(classifyDisk(19.99, 100).status).toBe('warning');
  expect(classifyDisk(10, 100).status).toBe('warning');
  expect(classifyDisk(9.99, 100).status).toBe('critical');
  expect(classifyDisk(0, 0).status).toBe('critical');
});
