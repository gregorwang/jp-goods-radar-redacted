interface PageHeroProps {
  eyebrow: string;
  title: string;
  soft?: string;
  copy?: string;
  note?: string;
}

export function PageHero({ eyebrow, title, soft, copy, note }: PageHeroProps) {
  return (
    <header className="page-hero reveal">
      <div className="hero-content">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="display-title"><span>{title}</span>{soft && <em>{soft}</em>}</h1>
        {copy && <p className="hero-copy">{copy}</p>}
      </div>
      {note && <p className="vertical-note">{note}</p>}
      <span className="hero-coordinate" aria-hidden="true">35.6762° N<br />139.6503° E</span>
    </header>
  );
}
