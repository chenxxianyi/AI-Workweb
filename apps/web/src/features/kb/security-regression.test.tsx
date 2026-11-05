import {render} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {isSafeHref,Markdown} from './markdown';
describe('hostile markdown and URL regression',()=>{
 it.each(['javascript:alert(1)','JaVaScRiPt:alert(1)','java\nscript:alert(1)','data:text/html,evil','vbscript:msgbox(1)','//evil.test/path','/\\evil.test','https://u:p@example.test','https://','https://exa\tmple.test'])('rejects unsafe destination %s',href=>expect(isSafeHref(href)).toBe(false));
 it.each(['/kb/id','#anchor','https://example.test/doc','http://127.0.0.1:3000'])('allows ordinary destination %s',href=>expect(isSafeHref(href)).toBe(true));
 it('hostile HTML SVG and style remain literal text without active nodes',()=>{const source='<svg onload=alert(1)><foreignObject>evil</foreignObject></svg>\n\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n\n<style>body{display:none}</style>\n\n[坏链接](//evil.test)';const {container}=render(<Markdown source={source}/>);expect(container.querySelector('svg,iframe,script,style,img,object,embed')).toBeNull();expect(container.querySelector('a')).toBeNull();expect(container.textContent).toContain('<svg');});
 it('code preserves exact Unicode, brackets and HTML without a second parse',()=>{const code='const 中文 = "<img onerror=evil()>";\n[运行](javascript:evil) **raw**';const {container}=render(<Markdown source={'```ts\n'+code+'\n```'}/>);expect(container.querySelector('pre code')?.textContent).toBe(code);expect(container.querySelector('a,img,strong')).toBeNull();});
});
