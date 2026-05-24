// scripts/helpers/html-util.js

/**
 * Strips potentially unsafe HTML tags from an item description string before
 * passing it to TextEditor.enrichHTML. Removes scripts, images, iframes,
 * objects, and embeds — leaving all other HTML (bold, italic, links, etc.)
 * intact for enrichment.
 *
 * Single authoritative implementation — replaces the duplicate inline regex
 * chains that previously existed in character-sheet.js and company-sheet.js.
 *
 * @param {string} rawDesc - The raw HTML string from an item's system data.
 * @returns {string} The sanitised string, safe to pass to enrichHTML.
 */
export function sanitiseItemDescription(rawDesc) {
  return String(rawDesc || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<img[\s\S]*?>/gi, "")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "");
}
