export default function Loading() {
  return (
    <div className="mx-auto max-w-marketing px-4 py-10" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-56 animate-pulse rounded-input bg-surface-3/70" />
      <div className="mt-4 h-40 w-full animate-pulse rounded-panel bg-surface-3/70" />
    </div>
  );
}
