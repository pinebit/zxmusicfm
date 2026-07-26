import { useEffect, useRef } from 'react';

import packageMetadata from '../../package.json';

type AboutDialogProps = {
  readonly open: boolean;
  readonly onClose: () => void;
};

const musicSources = [
  { name: 'ZX-Art', url: 'https://zxart.ee/eng/music/' },
  { name: 'ZXTunes', url: 'https://zxtunes.com/' },
  { name: 'Demozoo', url: 'https://demozoo.org/' },
  { name: 'AY/YM homepage', url: 'https://bulba.untergrund.net/music_e.htm' },
  { name: 'CVGM.net', url: 'https://www.cvgm.net/' },
] as const;

const browserNotices = [
  {
    name: 'React and React DOM',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
  },
  { name: 'Zod', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
  {
    name: 'Inter Variable',
    license: 'SIL Open Font License 1.1',
    url: 'https://fontsource.org/fonts/inter',
  },
  {
    name: 'Space Grotesk Variable',
    license: 'SIL Open Font License 1.1',
    url: 'https://fontsource.org/fonts/space-grotesk',
  },
  {
    name: 'ym2149-rs',
    license: 'MIT',
    url: 'https://github.com/slippyex/ym2149-rs',
  },
] as const;

const buildNotices = [
  { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
  {
    name: 'TypeScript',
    license: 'Apache License 2.0',
    url: 'https://github.com/microsoft/TypeScript',
  },
  {
    name: 'Vitest',
    license: 'MIT',
    url: 'https://github.com/vitest-dev/vitest',
  },
  {
    name: 'Playwright',
    license: 'Apache License 2.0',
    url: 'https://github.com/microsoft/playwright',
  },
  {
    name: 'React Testing Library',
    license: 'MIT',
    url: 'https://github.com/testing-library/react-testing-library',
  },
  {
    name: 'axe-core for Playwright',
    license: 'Mozilla Public License 2.0',
    url: 'https://github.com/dequelabs/axe-core-npm',
  },
  {
    name: 'ESLint',
    license: 'MIT',
    url: 'https://github.com/eslint/eslint',
  },
  {
    name: 'Prettier',
    license: 'MIT',
    url: 'https://github.com/prettier/prettier',
  },
] as const;

function NoticeGroup({
  heading,
  notices,
}: {
  readonly heading: string;
  readonly notices: readonly { name: string; license: string; url: string }[];
}) {
  return (
    <div className="about-notice-group">
      <h4>{heading}</h4>
      <ul className="about-notice-list">
        {notices.map((notice) => (
          <li key={notice.name}>
            <a href={notice.url} target="_blank" rel="noopener noreferrer">
              {notice.name}
            </a>
            <span>{notice.license}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="about-dialog"
      aria-labelledby="about-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const dialog = dialogRef.current;
        if (dialog === null) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button, a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => !element.hasAttribute('disabled'));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="about-masthead">
        <div>
          <p className="section-kicker">ZX-MUSIC.FM</p>
          <h2 id="about-title">About</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="about-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="about-body">
        <div className="about-row">
          <h3>Version</h3>
          <div className="about-row-body">
            <p>
              {packageMetadata.version} &middot;{' '}
              <a
                href="https://github.com/pinebit/zxmusicfm"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </p>
          </div>
        </div>

        <div className="about-row">
          <h3>The project</h3>
          <div className="about-row-body">
            <p>
              Created by{' '}
              <a
                href="https://github.com/pinebit"
                target="_blank"
                rel="noopener noreferrer"
              >
                Andrei Smirnov
              </a>
              . This is a deep-coding experiment made with state-of-the-art AI
              models from Anthropic and OpenAI. The project source is available
              under the MIT License. The original wordmark, interface, and
              Spectrum-inspired artwork do not imply endorsement by Sinclair or
              any rights holder.
            </p>
          </div>
        </div>

        <div className="about-row">
          <h3>Curation</h3>
          <div className="about-row-body">
            <p>
              The track list is curated solely at the author&rsquo;s discretion
              and reflects a private, humble opinion. It is not a ranking or a
              statement of relative merit, and the inclusion or omission of any
              track, author, or group implies no judgment.
            </p>
          </div>
        </div>

        <div className="about-row">
          <h3>Sources</h3>
          <div className="about-row-body">
            <p>
              Tracks in this catalog are sourced from these archives and
              communities.
            </p>
            <ul className="about-notice-list">
              {musicSources.map((source) => (
                <li key={source.name}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="about-row">
          <h3>Third-party notices</h3>
          <div className="about-row-body">
            <NoticeGroup heading="In the browser" notices={browserNotices} />
            <NoticeGroup heading="Build and test" notices={buildNotices} />
          </div>
        </div>
      </div>
    </dialog>
  );
}
