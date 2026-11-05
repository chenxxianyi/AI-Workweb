import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';
afterEach(() => { vi.restoreAllMocks(); });
describe('F24 clipboard outcome', () => {
  it('copies original text including code characters', async () => {
    const writeText=vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
    expect(await copyText('<code> & 中文')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('<code> & 中文');
  });
  it('falls back after rejection and removes the temporary textarea', async () => {
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockRejectedValue(new Error('denied'))}});
    const exec=vi.fn().mockReturnValue(true);
    Object.defineProperty(document,'execCommand',{configurable:true,value:exec});
    expect(await copyText('正文')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('reports false when both paths fail without leaving DOM behind', async () => {
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
    Object.defineProperty(document,'execCommand',{configurable:true,value:vi.fn().mockReturnValue(false)});
    expect(await copyText('正文')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
