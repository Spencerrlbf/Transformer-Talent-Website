import type { SVGProps } from "react";

// Every SVG on the home page goes through this wrapper so no diagram ships
// without a title, a description and a viewBox. The id seeds the two
// accessible-name ids, so pass a different one per diagram on a page.

type DiagramProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "role" | "id" | "aria-labelledby"> & {
  id: string;
  title: string;
  desc: string;
  viewBox: string;
};

export default function Diagram({ id, title, desc, viewBox, children, ...rest }: DiagramProps) {
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      viewBox={viewBox}
      {...rest}
    >
      <title id={titleId}>{title}</title>
      <desc id={descId}>{desc}</desc>
      {children}
    </svg>
  );
}
