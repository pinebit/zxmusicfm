import { useEffect, useRef } from 'react';

import packageMetadata from '../../package.json';

type CreditsDialogProps = {
  readonly open: boolean;
  readonly onClose: () => void;
};

const dependencyNotices = [
  {
    name: 'React and React DOM',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
  },
  { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
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

export function CreditsDialog({ open, onClose }: CreditsDialogProps) {
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
      className="credits-dialog"
      aria-labelledby="credits-title"
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
      <div className="dialog-heading">
        <div>
          <h2 id="credits-title">About</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-button"
          aria-label="Close credits and licenses"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <section>
        <h3>Application</h3>
        <p>
          Created by{' '}
          <a
            href="https://github.com/pinebit"
            target="_blank"
            rel="noopener noreferrer"
          >
            Andrei Smirnov
          </a>
          . This is a vibe-coding experiment made with state-of-the-art AI
          models from Anthropic and OpenAI. The project source is available
          under the MIT License. The original wordmark, interface, and
          Spectrum-inspired artwork do not imply endorsement by Sinclair or any
          rights holder.
        </p>
        <dl className="project-meta">
          <div>
            <dt>Version</dt>
            <dd>
              <code>{packageMetadata.version}</code>
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <a
                href="https://github.com/pinebit/zxmusicfm"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub repository
              </a>
            </dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>Curation</h3>
        <p>
          The track list is curated solely at the author&rsquo;s discretion and
          reflects a private, humble opinion. It is not a ranking or a statement
          of relative merit, and the inclusion or omission of any track, author,
          or group implies no judgment.
        </p>
      </section>
      <section>
        <h3>Playback engine</h3>
        <p>
          <a
            href="https://github.com/slippyex/ym2149-rs"
            target="_blank"
            rel="noopener noreferrer"
          >
            ym2149-rs
          </a>{' '}
          by its contributors, pinned to commit{' '}
          <code>b3096aac0dcab6dd1d82c0209f579761943aadc6</code>, MIT License.
        </p>
      </section>
      <section>
        <h3>Dependencies</h3>
        <ul className="credit-list">
          {dependencyNotices.map((dependency) => (
            <li key={dependency.name}>
              <a
                href={dependency.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {dependency.name}
              </a>{' '}
              — {dependency.license}
            </li>
          ))}
        </ul>
      </section>
    </dialog>
  );
}
