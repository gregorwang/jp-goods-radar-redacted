interface GoinnhellirEmblemProps {
  className?: string;
}

export function GoinnhellirEmblem({ className }: GoinnhellirEmblemProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 180 240"
      width="44"
      height="59"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M48 55C25 68 13 91 13 119c0 35 17 66 45 82M132 55c23 13 35 36 35 64 0 35-17 66-45 82" strokeWidth="6.4" />
        <path d="M90 5 96 25l-4 5v23M90 5l-6 20 4 5v23m2-5L61 80m29-32 29 32M90 50v54M62 84l28 27 28-27" strokeWidth="5.6" />
        <path d="M58 63v58l18 18M58 80 42 63m16 33L39 78m19 27 16-16m48-26v58l-18 18m18-59 16-17m-16 33 19-18m-19 27-16-16" strokeWidth="5.4" />
        <path d="m39 63 8-7v15m94-8-8-7v15" strokeWidth="4.6" />
        <path d="m67 92-8-3-3-8 8 3 3 8Zm46 0 8-3 3-8-8 3-3 8ZM56 112l-9-2-4-8 9 2 4 8Zm68 0 9-2 4-8-9 2-4 8Z" fill="currentColor" stroke="none" />
        <path d="M88 113v46m0-45 9 9-9 8 9 8-9 8 9 9" strokeWidth="3.8" />
        <path d="M57 194c-12-9-17-23-14-39 4-19 17-33 33-44-5 20-3 39 2 55m45 28c12-9 17-23 14-39-4-19-17-33-33-44 5 20 3 39-2 55" strokeWidth="7" />
        <path d="M65 177v-28l8-18m42 46v-28l-8-18" strokeWidth="4.6" />
        <path d="m90 157 17 18-17 18-17-18 17-18Z" strokeWidth="6" />
        <path d="m90 169 6 6-6 6-6-6 6-6Z" fill="currentColor" stroke="none" />
        <path d="M90 193v36m-21-32 42 29m0-29-42 29m0-19-8 8m50-8 8 8m-40 4-8 11m30-11 8 11" strokeWidth="5.2" />
        <circle cx="90" cy="232" r="7" strokeWidth="5.2" />
        <path d="m45 208 5 5-5 5-5-5 5-5Zm90 0 5 5-5 5-5-5 5-5Z" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
