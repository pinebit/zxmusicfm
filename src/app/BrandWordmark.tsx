import { useEffect, useState } from 'react';

import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

// The "ZX-MUSIC.FM" wordmark rendered as an LED dot-matrix display: every
// letter is drawn from individual dots on a 5x7 grid, one rounded square per
// lit dot.
const GLYPHS: Record<string, readonly string[]> = {
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00000', '00100'],
};

const TEXT = 'ZX-MUSIC.FM';
const COLS = 5;
const ROWS = 7;
const GAP = 1;
const DOT_SIZE = 0.82;
const DOT_CORNER = 0.24;

const STEP = COLS + GAP;
const WIDTH = TEXT.length * STEP - GAP;

type Dot = { readonly cx: number; readonly cy: number };

const LETTERS: { readonly char: string; readonly dots: readonly Dot[] }[] =
  Array.from(TEXT, (char, charIndex) => {
    const glyph = GLYPHS[char] ?? [];
    const dots: Dot[] = [];
    for (let row = 0; row < ROWS; row += 1) {
      const bits = glyph[row] ?? '';
      for (let col = 0; col < COLS; col += 1) {
        if (bits[col] === '1') {
          dots.push({ cx: charIndex * STEP + col + 0.5, cy: row + 0.5 });
        }
      }
    }
    return { char, dots };
  });

// Only the alphabetic characters bounce; the "-" and "." are left resting.
const BOUNCEABLE = LETTERS.map((_, index) => index).filter((index) =>
  /[A-Z]/u.test(TEXT[index] ?? ''),
);

// Matches the brand-letter-bounce keyframe duration in styles.css.
const BOUNCE_MS = 900;

function pickNext(previous: number | null): number {
  const options = BOUNCEABLE.filter((index) => index !== previous);
  const choice = options[Math.floor(Math.random() * options.length)];
  return choice ?? BOUNCEABLE[0] ?? 0;
}

export function BrandWordmark() {
  const [bouncing, setBouncing] = useState<number | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleBounce = () => {
      const rest = 1500 + Math.random() * 2500;
      timer = setTimeout(() => {
        setBouncing((previous) => pickNext(previous));
        timer = setTimeout(() => {
          setBouncing(null);
          scheduleBounce();
        }, BOUNCE_MS);
      }, rest);
    };

    scheduleBounce();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [reducedMotion]);

  return (
    <svg
      className="brand-wordmark"
      viewBox={`0 0 ${WIDTH} ${ROWS}`}
      aria-hidden="true"
      focusable="false"
    >
      {LETTERS.map((letter, index) => (
        <g
          key={index}
          className={`brand-letter${
            bouncing === index && !reducedMotion ? ' is-bouncing' : ''
          }`}
        >
          {letter.dots.map((dot, dotIndex) => (
            <rect
              key={dotIndex}
              x={dot.cx - DOT_SIZE / 2}
              y={dot.cy - DOT_SIZE / 2}
              width={DOT_SIZE}
              height={DOT_SIZE}
              rx={DOT_CORNER}
              ry={DOT_CORNER}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
