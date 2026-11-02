/**
 * Parses a "provider/model" or "provider/sub/model" string into a ModelRef.
 */
export function parseModel(modelStr) {
    if (!modelStr || typeof modelStr !== "string")
        return undefined;
    const trimmed = modelStr.trim();
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx <= 0 || slashIdx === trimmed.length - 1)
        return undefined;
    return {
        providerID: trimmed.slice(0, slashIdx),
        id: trimmed.slice(slashIdx + 1),
    };
}
/**
 * Formats a model reference into a "provider/id" string.
 */
export function formatModel(ref) {
    if (!ref?.providerID || !ref?.id)
        return undefined;
    return `${ref.providerID}/${ref.id}`;
}
/**
 * Normalizes a configured chain so the primary head model is always at index 0,
 * followed by any configured fallbacks without duplicates.
 */
export function normalizeChain(head, targets) {
    const list = Array.isArray(targets) ? targets : [targets];
    const items = list
        .filter((m) => typeof m === "string" && m.trim().length > 0)
        .map((m) => m.trim());
    if (items.length > 0 && items[0] === head) {
        return items;
    }
    return [head, ...items.filter((m) => m !== head)];
}
