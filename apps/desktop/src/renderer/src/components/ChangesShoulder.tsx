/** An eased ramp from the composer shell's top edge up to the changes tab's left side, so the
    two read as one outline. 22px tall: a 20px rise plus the shell's 1px edge and 1px sheen, which
    the fill covers so the ramp's own edge and sheen carry on from the shell's without a break. */
export function ChangesShoulder() {
  return (
    <svg className="composer-changes-shoulder" width="32" height="22" viewBox="0 0 32 22" aria-hidden="true">
      <path className="composer-changes-shoulder-fill" d="M0 22V20C16 20 16 0 32 0V22Z" />
      <path className="composer-changes-shoulder-sheen" d="M0 21.5C16 21.5 16 1.5 32 1.5" />
      <path className="composer-changes-shoulder-edge" d="M0 20.5C16 20.5 16 0.5 32 0.5" />
    </svg>
  );
}
