import React from "react";

/** One stroke icon family (24px grid, 1.75 stroke, round caps). Decorative unless labelled. */
type IconProps = React.SVGProps<SVGSVGElement> & { size?: number; title?: string };

function Svg({ size = 18, title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const IconCluster = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="7.5" height="6.5" rx="1.8" /><rect x="13.5" y="4" width="7.5" height="6.5" rx="1.8" /><rect x="3" y="13.5" width="7.5" height="6.5" rx="1.8" /><rect x="13.5" y="13.5" width="7.5" height="6.5" rx="1.8" /></Svg>
);
export const IconNotebook = (p: IconProps) => (
  <Svg {...p}><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5z" /><path d="M9 8h6M9 12h4" /></Svg>
);
export const IconJobs = (p: IconProps) => (
  <Svg {...p}><path d="M8 5.5v13l10-6.5z" /></Svg>
);
export const IconDatasets = (p: IconProps) => (
  <Svg {...p}><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" /><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" /></Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}><path d="M20 14.2A8 8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2z" /></Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5 21.5 20h-19z" /><path d="M12 10v4.5M12 17.2v.3" /></Svg>
);
export const IconX = IconClose;
export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>
);
export const IconCpu = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="0.8" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></Svg>
);
export const IconGpu = (p: IconProps) => (
  <Svg {...p}><rect x="2.5" y="7" width="19" height="10" rx="1.8" /><circle cx="9" cy="12" r="2.4" /><circle cx="15.5" cy="12" r="2.4" /><path d="M5 17v2.5M8.5 17v2.5" /></Svg>
);
export const IconServer = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4" width="17" height="7" rx="1.6" /><rect x="3.5" y="13" width="17" height="7" rx="1.6" /><path d="M7 7.5h.01M7 16.5h.01" /></Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5" /><path d="M20 20v-4.5h-4.5" /></Svg>
);
export const IconSpinner = ({ className = "", ...p }: IconProps) => (
  <Svg {...p} className={`animate-spin ${className}`}><path d="M12 3a9 9 0 1 0 9 9" /></Svg>
);
export const IconChevron = (p: IconProps) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);
export const IconPanel = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Svg>
);
export const IconThermometer = (p: IconProps) => (
  <Svg {...p}><path d="M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0z" /></Svg>
);
export const IconBolt = (p: IconProps) => (
  <Svg {...p}><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></Svg>
);
