export function DotMatrixTrackDisplay({
  title,
  author,
}: {
  readonly title: string;
  readonly author: string;
}) {
  const text = `${title} / ${author}`;
  return (
    <span className="dot-matrix-display" aria-label={`${title} by ${author}`}>
      <span className="dot-matrix-viewport" aria-hidden="true">
        <span className="dot-matrix-track">
          <span>{text}</span>
          <span className="dot-matrix-copy">{text}</span>
        </span>
      </span>
    </span>
  );
}
