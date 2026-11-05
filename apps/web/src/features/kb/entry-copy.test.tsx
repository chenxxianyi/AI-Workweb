import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EntryCopy } from './entry-copy';
import { copyText } from '../../services/clipboard';
import { apiClient } from '../../services/api-client';
import type { Entry } from '../../services/kb-api';
vi.mock('../../providers/workspace-provider',()=>({useWorkspace:()=>({workspace:{workspaceId:'copy-space'}})}));
vi.mock('../../services/clipboard',()=>({copyText:vi.fn()}));
vi.mock('../../services/auth-api',()=>({ensureCsrfToken:vi.fn().mockResolvedValue(undefined),describeApiError:()=> '测试失败'}));
vi.mock('../../services/tasks-api',()=>({newIdempotencyKey:()=> 'copy-event-1'}));
vi.mock('../../services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
const entry:Entry={id:'copy-entry',title:'复制测试',body:'<code> & 中文',summary:null,type:'note',status:'draft',tags:[],version:1,createdAt:'2026-11-03T00:00:00Z',updatedAt:'2026-11-03T00:00:00Z',bodyBytes:20,projectId:null,source:null,lang:null,rating:null};
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><EntryCopy entry={entry}/></QueryClientProvider>);}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(apiClient.get).mockResolvedValue({useCount:0,lastUsedAt:null});vi.mocked(copyText).mockResolvedValue(true);vi.mocked(apiClient.post).mockResolvedValue({useCount:1,lastUsedAt:'2026-11-03T01:00:00Z'});});
describe('F24 usage reflects actual clipboard outcome',()=>{
  it('copy failure never sends an event',async()=>{vi.mocked(copyText).mockResolvedValue(false);mount();fireEvent.click(screen.getByRole('button',{name:'复制正文'}));await screen.findByText(/复制失败/);expect(apiClient.post).not.toHaveBeenCalled();});
  it('copies exact original body and persists one event',async()=>{mount();fireEvent.click(screen.getByRole('button',{name:'复制正文'}));await screen.findByText('已复制，使用记录已保存。');expect(copyText).toHaveBeenCalledWith(entry.body);expect(apiClient.post).toHaveBeenCalledTimes(1);});
  it('failed event retry reuses key and does not copy again',async()=>{vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({useCount:1,lastUsedAt:'2026-11-03T01:00:00Z'});mount();fireEvent.click(screen.getByRole('button',{name:'复制正文'}));await screen.findByText(/使用记录尚未保存/);fireEvent.click(screen.getByRole('button',{name:'重试保存统计'}));await waitFor(()=>expect(apiClient.post).toHaveBeenCalledTimes(2));expect(vi.mocked(apiClient.post).mock.calls[0]?.[2]).toEqual(vi.mocked(apiClient.post).mock.calls[1]?.[2]);expect(copyText).toHaveBeenCalledTimes(1);});
});
