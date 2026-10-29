// The official API returns at most 50 rows unless every cursor is followed.
// Keep cursors opaque and keep every continuation on the original API path.
export async function fetchOfficialPages(path, fetchPage, { maxPages = 20, maxItems = 500 } = {}) {
  const rows = [];
  const seenTokens = new Set();
  let firstPage = null;
  let token = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const nextPath = token
      ? `${path}${path.includes("?") ? "&" : "?"}page_token=${encodeURIComponent(token)}`
      : path;
    const page = await fetchPage(nextPath);
    if (!page || !Array.isArray(page.data)) throw new Error("Official API returned an invalid page");
    firstPage ||= page;
    rows.push(...page.data);
    if (rows.length > maxItems) throw new Error("Official API result exceeds the expected size");
    token = page.meta?.page_token;
    if (token == null || token === "") return { ...firstPage, data: rows, meta: { ...page.meta, page_token: null } };
    if (typeof token !== "string" || token.length > 16_384 || seenTokens.has(token) || !page.data.length) {
      throw new Error("Official API returned a repeated or invalid pagination cursor");
    }
    seenTokens.add(token);
  }
  throw new Error("Official API pagination exceeded the page limit");
}
