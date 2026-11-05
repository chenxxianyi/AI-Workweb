import type { ReactNode } from 'react';

/**
 * 极简安全 Markdown 渲染（F20）。
 *
 * 设计目标不是“支持全部 Markdown”，而是**绝不把用户输入当 HTML 执行**：
 * - 全部内容以 React 文本节点输出，不使用 `dangerouslySetInnerHTML`
 * - 自动转义 `<script>`、`<img onerror=…>` 等标签（它们只会显示为文字）
 * - 链接只接受 http(s) 与站内相对路径；`javascript:` / `data:` 等渲染为纯文本
 * - 围栏代码块原样保留字符（不做二次解析），保证代码里的 `*` `_` `<` 不被改写
 */

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const UL_ITEM = /^[-*]\s+(.*)$/;
const OL_ITEM = /^(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed === '' || [...trimmed].some(c=>c.charCodeAt(0)<=32||c.charCodeAt(0)===127||c==='\\')) return false;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('/')) return !trimmed.startsWith('//');
  if(!/^https?:\/\//i.test(trimmed))return false;
  try{const url=new URL(trimmed);return url.hostname!==''&&!url.username&&!url.password;}catch{return false;}
}

/** 行内解析：`code`、**bold**、*italic*、[text](url) */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]*`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]*\))/g;
  let cursor = 0;
  let index = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="md-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token);
      if (linkMatch === null) {
        nodes.push(token);
      } else {
        const label = linkMatch[1] ?? '';
        const href = (linkMatch[2] ?? '').trim();
        if (isSafeHref(href)) {
          const external = /^https?:\/\//i.test(href);
          nodes.push(
            <a
              key={key}
              href={href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {label}
            </a>,
          );
        } else {
          // 危险协议：只显示文字，不生成可点击链接
          nodes.push(
            <span key={key} className="md-unsafe-link" title="出于安全原因，该链接不会被启用">
              {label}（链接已禁用）
            </span>,
          );
        }
      }
    }
    cursor = match.index + token.length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // 围栏代码块：整块原样输出
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && FENCE.exec(lines[index] ?? '') === null) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // 跳过结束围栏
      blocks.push(
        <pre key={`code-${index}`} className="md-pre">
          <code data-lang={lang}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      const content = heading[2] ?? '';
      const key = `h-${index}`;
      const children = renderInline(content, key);
      blocks.push(
        level === 1 ? (
          <h1 key={key}>{children}</h1>
        ) : level === 2 ? (
          <h2 key={key}>{children}</h2>
        ) : (
          <h3 key={key}>{children}</h3>
        ),
      );
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        const matched = QUOTE.exec(lines[index] ?? '');
        quoteLines.push(matched?.[1] ?? '');
        index += 1;
      }
      blocks.push(
        <blockquote key={`q-${index}`} className="md-quote">
          {renderInline(quoteLines.join(' '), `q-${index}`)}
        </blockquote>,
      );
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const matched = ordered ? OL_ITEM.exec(current) : UL_ITEM.exec(current);
        if (matched === null) break;
        items.push(ordered ? (matched[2] ?? '') : (matched[1] ?? ''));
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`li-${index}-${itemIndex}`}>{renderInline(item, `li-${index}-${itemIndex}`)}</li>
      ));
      blocks.push(ordered ? <ol key={`ol-${index}`}>{children}</ol> : <ul key={`ul-${index}`}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || FENCE.test(current) || HEADING.test(current) || QUOTE.test(current) || UL_ITEM.test(current) || OL_ITEM.test(current)) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{renderInline(paragraph.join(' '), `p-${index}`)}</p>);
  }

  return blocks;
}

/** 供界面直接使用的组件封装 */
export function Markdown({ source }: { source: string }): React.JSX.Element {
  return <div className="markdown-body">{renderMarkdown(source)}</div>;
}
