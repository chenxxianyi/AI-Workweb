import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './markdown';
import {
  BODY_LIMIT_BYTES,
  formatBytes,
  isBodyOverLimit,
  isSaveShortcut,
  shouldIgnoreShortcut,
  utf8Bytes,
} from './kb-utils';

describe('安全 Markdown 渲染（F20）', () => {
  it('script 标签只当文本显示，不会变成元素', () => {
    const { container } = render(<Markdown source={'正常文字\n\n<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('img onerror 不会创建图片元素', () => {
    const { container } = render(<Markdown source={'<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img');
  });

  it('javascript: 链接不生成可点击锚点', () => {
    const { container } = render(<Markdown source={'[点我](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('链接已禁用');
  });

  it('http(s) 链接正常生成并带 noopener', () => {
    render(<Markdown source={'[文档](https://example.com/doc)'} />);
    const link = screen.getByRole('link', { name: '文档' });
    expect(link.getAttribute('href')).toBe('https://example.com/doc');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('代码块保留原始字符（不做行内解析）', () => {
    const { container } = render(<Markdown source={'```ts\nconst a = *not italic*;\n<div>raw</div>\n```'} />);
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('const a = *not italic*;\n<div>raw</div>');
    expect(container.querySelector('em')).toBeNull();
  });

  it('标题、列表与引用按块渲染', () => {
    const { container } = render(<Markdown source={'## 标题\n\n- 一\n- 二\n\n> 引用'} />);
    expect(container.querySelector('h2')?.textContent).toBe('标题');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('blockquote')?.textContent).toContain('引用');
  });
});

describe('字节计数与快捷键（F20）', () => {
  it('中文按 3 字节、英文按 1 字节', () => {
    expect(utf8Bytes('中文')).toBe(6);
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('中a')).toBe(4);
  });

  it('20480 字节合法、20481 超限', () => {
    expect(isBodyOverLimit('a'.repeat(BODY_LIMIT_BYTES))).toBe(false);
    expect(isBodyOverLimit('a'.repeat(BODY_LIMIT_BYTES + 1))).toBe(true);
    // 中文：6826 字 = 20478 字节，仍在限内
    expect(isBodyOverLimit('中'.repeat(6826))).toBe(false);
    expect(isBodyOverLimit('中'.repeat(6827))).toBe(true);
  });

  it('字节展示格式', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20480)).toBe('20.0 KB');
  });

  it('输入控件里的单键 N 不触发快捷键', () => {
    expect(shouldIgnoreShortcut({ tagName: 'INPUT' })).toBe(true);
    expect(shouldIgnoreShortcut({ tagName: 'TEXTAREA' })).toBe(true);
    expect(shouldIgnoreShortcut({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(shouldIgnoreShortcut({ tagName: 'BODY' })).toBe(false);
  });

  it('只有 Ctrl/Cmd+Enter 才保存', () => {
    expect(isSaveShortcut({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSaveShortcut({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSaveShortcut({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSaveShortcut({ key: 'n', ctrlKey: false, metaKey: false })).toBe(false);
  });
});
