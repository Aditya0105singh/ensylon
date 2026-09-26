type AlertLensMarkProps = {
  className?: string;
};

/**
 * AlertLens logo: a lens ring over a signal pulse.
 */
export const AlertLensMark = ({ className }: AlertLensMarkProps) => (
  <svg
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    role="img"
    aria-label="Nexus AIOps"
  >
    <circle
      cx="14"
      cy="14"
      r="9.5"
      stroke="rgb(21 128 61)"
      strokeWidth="2.5"
    />
    <path
      d="M9.5 14.5l2.5 0 1.75-4 2.25 7.5 1.75-3.5h2.25"
      stroke="rgb(21 128 61)"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M21.5 21.5l6 6"
      stroke="rgb(21 128 61)"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);
