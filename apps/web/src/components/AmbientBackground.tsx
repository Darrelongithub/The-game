// A single lightweight artwork replaces multiple full-screen, animated blur
// layers. It is local, so the game still works without an internet connection.
export function AmbientBackground() {
  return <div aria-hidden="true" className="ambient-background" />
}
