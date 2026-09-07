const colors = ["#F88745", "#A78BFA", "#EEC84D", "#66BD99", "#729CF1", "#EC7F9D"];
const silhouettes = [
  <rect key="square" x="7" y="9" width="50" height="46" rx="15" />,
  <path key="pebble" d="M32 5C45 5 57 21 57 35S47 58 32 58 7 49 7 35 19 5 32 5Z" />,
  <path key="hexagon" d="M22 8h20L58 32 45 55H19L6 32Z" />,
  <rect key="capsule" x="5" y="16" width="54" height="36" rx="18" />,
  <path key="wedge" d="M12 53C5 53 5 45 9 36L23 12C27 5 36 5 41 13l15 25c5 9 2 15-6 15Z" />,
  <path key="arch" d="M8 30C8 14 17 7 32 7s24 7 24 23v20c0 5-3 7-7 7H15c-4 0-7-2-7-7Z" />,
];

/** Draws a local terminal avatar with a deterministic color and shape for a bot name. */
export function TerminalAvatar({
  name,
  className,
}: {
  readonly name: string;
  readonly className: string;
}) {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  const color = colors[hash % colors.length];
  const silhouette = silhouettes[Math.floor(hash / colors.length) % silhouettes.length];
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" className={`${className} shrink-0`}>
      <g fill={color}>{silhouette}</g>
      <rect x="15" y="23" width="34" height="19" rx="7" fill="#25262B" />
      <g fill={color}>
        <rect x="23" y="29" width="5" height="6" rx="1" />
        <rect x="36" y="29" width="5" height="6" rx="1" />
      </g>
    </svg>
  );
}
