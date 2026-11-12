/** Green / yellow / red attendance dot with the percentage, next to a student's name. */
export function LevelDot({ level, rate }: { level: "good" | "attention" | "poor" | "none"; rate: number | null }) {
  const words = { good: "Good attendance", attention: "Needs attention", poor: "Poor attendance", none: "No attendance yet" }[level];
  return <span className={`level sm ${level}`} title={`${words}${rate !== null ? `: ${rate}%` : ""}`}>{rate !== null ? `${rate}%` : "—"}</span>;
}
