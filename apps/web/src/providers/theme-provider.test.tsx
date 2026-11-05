import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, useTheme } from './theme-provider';
function Controls(){const t=useTheme();return <><span data-testid="mode">{t.mode}</span><button onClick={()=>t.setMode('dark')}>dark</button>{t.syncError?<p role="alert">{t.syncError}</p>:null}</>;}
beforeEach(()=>{vi.restoreAllMocks();localStorage.clear();});
describe('server theme with isolated local cache',()=>{
 it('cache quota failure does not block server preference save',async()=>{vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});const save=vi.fn().mockResolvedValue(undefined);render(<ThemeProvider storageScope="user-a" onChange={save}><Controls/></ThemeProvider>);fireEvent.click(screen.getByRole('button',{name:'dark'}));await waitFor(()=>expect(save).toHaveBeenCalledWith('dark'));expect(screen.getByTestId('mode').textContent).toBe('dark');});
 it('server failure keeps local result and displays retry feedback',async()=>{render(<ThemeProvider storageScope="user-a" onChange={vi.fn().mockRejectedValue(new Error('offline'))}><Controls/></ThemeProvider>);fireEvent.click(screen.getByRole('button',{name:'dark'}));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByTestId('mode').textContent).toBe('dark');});
 it('other user does not inherit previous user cache',()=>{localStorage.setItem('aiwb.theme.user-a','dark');localStorage.setItem('aiwb.theme','dark');render(<ThemeProvider storageScope="user-b"><Controls/></ThemeProvider>);expect(screen.getByTestId('mode').textContent).toBe('system');});
 it('server value is applied and cached in correct user scope',async()=>{render(<ThemeProvider storageScope="user-a" serverMode="light"><Controls/></ThemeProvider>);await waitFor(()=>expect(screen.getByTestId('mode').textContent).toBe('light'));expect(localStorage.getItem('aiwb.theme.user-a')).toBe('light');});
});
