import type { ReactNode } from 'react';

// Playback controls are drawn as inline SVG rather than Unicode media glyphs
// (▶ ⏸ ⏮ ⏭). Those code points carry emoji presentation on some platforms
// (notably Android/Chrome), which ignores the text variation selector and
// renders a colored emoji tile instead of a monochrome amber icon.
function ControlIcon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      className="control-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlayIcon() {
  return (
    <ControlIcon>
      <path d="M7 5 19 12 7 19z" />
    </ControlIcon>
  );
}

export function PauseIcon() {
  return (
    <ControlIcon>
      <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
    </ControlIcon>
  );
}

export function PreviousIcon() {
  return (
    <ControlIcon>
      <path d="M7 5h2.5v14H7zM18 5 9 12 18 19z" />
    </ControlIcon>
  );
}

export function NextIcon() {
  return (
    <ControlIcon>
      <path d="M6 5 15 12 6 19zM15.5 5h2.5v14h-2.5z" />
    </ControlIcon>
  );
}

export function MaximizeIcon() {
  return (
    <ControlIcon>
      <path d="M4 10V4h6v2H6v4H4zm10-6h6v6h-2V6h-4V4zM6 14v4h4v2H4v-6h2zm12 0h2v6h-6v-2h4v-4z" />
    </ControlIcon>
  );
}

export function RestoreIcon() {
  return (
    <ControlIcon>
      <path d="M10 4v6H4V8h4V4h2zm4 0h2v4h4v2h-6V4zM4 14h6v6H8v-4H4v-2zm12 2v4h-2v-6h6v2h-4z" />
    </ControlIcon>
  );
}
