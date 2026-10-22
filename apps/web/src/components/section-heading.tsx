export function SectionHeading({ jp, en }: { jp: string; en: string }) {
  return <div className="section-heading"><span className="jp">{jp}</span><span className="rule" /><span className="en">{en}</span></div>;
}
