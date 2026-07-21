const segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
type Segment = (typeof segments)[number];

const activeSegments: Readonly<Record<string, readonly Segment[]>> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'd', 'e', 'g'],
  '3': ['a', 'b', 'c', 'd', 'g'],
  '4': ['b', 'c', 'f', 'g'],
  '5': ['a', 'c', 'd', 'f', 'g'],
  '6': ['a', 'c', 'd', 'e', 'f', 'g'],
  '7': ['a', 'b', 'c'],
  '8': segments,
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
};

function SegmentedValue({ value }: { readonly value: string }) {
  const characters = value.match(/[0-9:]/gu) ?? [];
  return (
    <span className="seven-segment-value">
      {characters.map((character, index) =>
        character === ':' ? (
          <span className="seven-segment-colon" key={`${character}-${index}`} />
        ) : (
          <span className="seven-segment-digit" key={`${character}-${index}`}>
            {segments.map((segment) => (
              <span
                className={`seven-segment seven-segment-${segment}${
                  activeSegments[character]?.includes(segment)
                    ? ' is-active'
                    : ''
                }`}
                key={segment}
              />
            ))}
          </span>
        ),
      )}
    </span>
  );
}

export function SevenSegmentTime({
  elapsed,
  total,
}: {
  readonly elapsed: string;
  readonly total: string;
}) {
  return (
    <time
      className="seven-segment-display"
      aria-label={`${elapsed} elapsed of ${total} total`}
    >
      <span aria-hidden="true">
        <SegmentedValue value={elapsed} />
        <span className="seven-segment-divider" />
        <SegmentedValue value={total} />
      </span>
    </time>
  );
}
