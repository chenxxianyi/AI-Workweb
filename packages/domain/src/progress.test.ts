import {expect,it} from 'vitest';
import {projectProgress} from './progress';
it('manual zero remains zero even with completed tasks',()=>{expect(projectProgress(true,0,3,3)).toBe(0);expect(projectProgress(true,72,3,0)).toBe(72);});
it('empty tasks and rounded task percentages are deterministic',()=>{expect(projectProgress(false,null,0,0)).toBe(0);expect(projectProgress(false,null,3,1)).toBe(33);expect(projectProgress(false,null,3,2)).toBe(67);expect(projectProgress(false,null,3,3)).toBe(100);});
