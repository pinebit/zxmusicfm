/** Compact m:ss for durations under an hour, h:mm:ss when longer. */
export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const tail = String(whole % 60).padStart(2, '0');
  return hours === 0
    ? `${minutes}:${tail}`
    : `${hours}:${String(minutes).padStart(2, '0')}:${tail}`;
}
