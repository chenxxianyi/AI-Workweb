import type { SVGProps } from 'react';

/** 内联 SVG 图标（ADR-0007）：统一 24×24 viewBox、currentColor，无图标库/CDN */
type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function base(props: IconProps): SVGProps<SVGSVGElement> {
  const { title, ...rest } = props;
  return {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': title === undefined ? true : undefined,
    role: title === undefined ? undefined : 'img',
    ...rest,
  };
}

export function TodayIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M8 2v4M16 2v4M3 10h18M8 14h3" />
    </svg>
  );
}

export function ProjectsIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 7h6l2 2h8v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
      <path d="M4 7V5a1 1 0 0 1 1-1h4l2 2" />
    </svg>
  );
}

export function KnowledgeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

export function LedgerIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1.1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.7 8.8a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 8.1 4a1.7 1.7 0 0 0 1.1-1.6V2a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 3.7a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20 9.1v.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-.5 1.8Z" />
    </svg>
  );
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function SunIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 3 2 21h20L12 3Z" />
      <path d="M12 9v5M12 18h.01" />
    </svg>
  );
}
