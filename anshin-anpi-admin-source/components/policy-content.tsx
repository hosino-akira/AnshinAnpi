/** Render policy HTML with only attribute-free headings and paragraphs. */
export function PolicyContent({ body }: { body: string }) {
  if (!/<(?:h2|h3|p)>/i.test(body)) {
    return <p style={{ whiteSpace: "pre-wrap" }}>{body}</p>;
  }

  // Escape all markup, then restore only the three supported tags. Attributes,
  // scripts and other elements remain text in both the kiosk and admin preview.
  const html = body
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;(\/?(?:h2|h3|p))&gt;/gi, (_, tag: string) => `<${tag.toLowerCase()}>`);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
