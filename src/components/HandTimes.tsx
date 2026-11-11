/** The day's times as the student wrote them: Start, Lunch start, Lunch end, End, each with a small label. */
export function HandTimes({ times, h = 28 }: { times: { label: string; ink: string | null; typed: string }[]; h?: number }) {
  if (!times.length) return null;
  return (
    <span className="handtimes4">
      {times.map((t) => (
        <span key={t.label} className="ht">
          <span className="ht-label">{t.label}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {t.ink ? <img className="inkimg" src={`/api/ink/${t.ink}`} alt={`${t.label}, written by hand`} height={h} loading="lazy" /> : <span className="ht-typed">{t.typed}</span>}
        </span>
      ))}
    </span>
  );
}
