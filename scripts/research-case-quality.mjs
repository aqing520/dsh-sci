// Text matching is a diagnostic, not a judgement of whether a source supports
// a claim. Missing text can also mean the stored excerpt was truncated.
export function inspectCaseCitations(snapshot) {
  const normalize = (text) => String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const sources = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  return snapshot.citations.map((citation) => {
    const source = sources.get(citation.sourceId);
    const quote = normalize(citation.quotedText);
    const excerpt = normalize(source?.excerpt);
    let match = !source ? "source-missing" : !quote ? "quote-missing" : excerpt.includes(quote) ? "verbatim-in-stored-excerpt" : "not-verified-in-stored-excerpt";
    if (source && quote && match === "not-verified-in-stored-excerpt") {
      const fragments = quote.split(/\s*(?:\.{3}|…)\s*/u).map((fragment) => fragment.trim()).filter(Boolean);
      if (fragments.length > 1) {
        let end = 0;
        const ordered = fragments.every((fragment) => { const position = excerpt.indexOf(fragment, end); if (position < 0) return false; end = position + fragment.length; return true; });
        if (ordered) match = "ordered-ellipsis-fragments-in-stored-excerpt";
      }
    }
    return { citationId: citation.citationId, sourceId: citation.sourceId, hasLocator: Boolean(citation.locator), match, supportReview: "required" };
  });
}
