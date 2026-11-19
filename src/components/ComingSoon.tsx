export function ComingSoon({ title, phase, what }: { title: string; phase: number; what: string }) {
  return (
    <>
      <h1>{title}</h1>
      <div className="notice">
        <p>
          <strong>Arrives in Phase {phase}.</strong> {what}
        </p>
        <p className="muted">Your access to this page is already set up for your role.</p>
      </div>
    </>
  );
}
