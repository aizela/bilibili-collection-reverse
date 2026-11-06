/* Pure data transforms. Never mutate Bilibili's original arrays. */
(function (root) {
  "use strict";
  function isCollection(value) {
    return Boolean(value && value.id != null && Array.isArray(value.sections) &&
      value.sections.length && value.sections.every(section =>
        section && Array.isArray(section.episodes)));
  }

  function reverseEpisodes(collection) {
    return transformCollection(collection, true, false);
  }

  function transformCollection(collection, reverseVideos, reverseSections) {
    if (!reverseVideos && !reverseSections) return collection;
    let sections = reverseVideos
      ? collection.sections.map(section => ({
          ...section,
          // Parts within an individual video always keep their original order.
          episodes: [...section.episodes].reverse()
        }))
      : [...collection.sections];
    if (reverseSections) sections.reverse();
    return {
      ...collection,
      sections
    };
  }

  function createOrderBook() {
    const forward = new WeakMap();
    const originals = new WeakMap();
    return {
      original(value) { return originals.get(value) || value; },
      desired(value, enabled, reverseSections = false) {
        const original = originals.get(value) || value;
        const mode = (enabled ? 1 : 0) | (reverseSections ? 2 : 0);
        if (!mode) return original;
        if (!forward.has(original)) forward.set(original, new Map());
        const variants = forward.get(original);
        if (!variants.has(mode)) {
          const reversed = transformCollection(original, enabled, reverseSections);
          variants.set(mode, reversed);
          originals.set(reversed, original);
        }
        return variants.get(mode);
      }
    };
  }

  const api = Object.freeze({ isCollection, reverseEpisodes, transformCollection, createOrderBook });
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.defineProperty(root, "__BILI_REVERSE_CORE_V1__", { value: api, configurable: true });
})(globalThis);
