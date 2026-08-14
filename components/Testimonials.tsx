const TESTIMONIALS = [
  {
    quote:
      "Spencer is really amazing. He's sent us incredible high-intent candidates that are excellent fits with our business needs.",
    attribution: "Founder · Series A · Sequoia",
  },
  {
    quote: "5 key hires over the last two years — we now only work with Spencer.",
    attribution: "CTO · Fintech Startup",
  },
  {
    quote: "Goated.",
    attribution: "VP of AI & Data Science · Series C",
  },
];

export default function Testimonials() {
  // Rendered twice for the seamless -50% translate loop.
  const loop = [...TESTIMONIALS, ...TESTIMONIALS];
  return (
    <div className="testimonials-wrapper">
      <div className="testimonials">
        {loop.map((t, i) => (
          <div key={i} style={{ display: "contents" }}>
            <div className="testimonial">
              <q>{t.quote}</q>
              <span className="attribution">— {t.attribution}</span>
            </div>
            <span className="testimonial-divider">✦</span>
          </div>
        ))}
      </div>
    </div>
  );
}
