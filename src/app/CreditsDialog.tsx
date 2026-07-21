import { useEffect, useRef } from 'react';

import type { GeneratedCatalog } from '../content/schemas.ts';

type CreditsDialogProps = {
  readonly open: boolean;
  readonly tracks: GeneratedCatalog['tracks'];
  readonly onClose: () => void;
};

const dependencyNotices = [
  { name: 'React', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
  { name: 'Zod', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
] as const;

export function CreditsDialog({ open, tracks, onClose }: CreditsDialogProps) {
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
          <p className="section-kicker">OPEN SOURCE & ATTRIBUTION</p>
          <h2 id="credits-title">Credits / License</h2>
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
          ZX-SPECTRUM.FM project source is available under the MIT License. The
          original wordmark, interface, and Spectrum-inspired artwork do not
          imply endorsement by Sinclair or any rights holder.
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
        <ul className="credit-list compact">
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
      <section>
        <h3>Music</h3>
        {tracks.length === 0 ? (
          <p>No music is present in this development catalog.</p>
        ) : (
          <ul className="credit-list">
            {tracks.map((track) => (
              <li key={track.id}>
                <strong>{track.title}</strong> by {track.author}
                {track.year === undefined ? null : (
                  <span>Year: {track.year}</span>
                )}
                {track.notes === undefined ? null : <span>{track.notes}</span>}
                <span>
                  <a
                    href={track.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Original source
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </dialog>
  );
}
