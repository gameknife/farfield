export function formatDurationSeconds(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 1) return "<1s";
  return `${Math.round(seconds).toString()}s`;
}
