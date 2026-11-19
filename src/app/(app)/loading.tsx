/** Shown instantly while a page's data loads, so navigation never feels frozen. */
export default function Loading() {
  return (
    <p className="muted" role="status" aria-live="polite">
      Loading…
    </p>
  );
}
