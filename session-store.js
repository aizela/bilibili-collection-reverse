(function (root) {
  "use strict";
  const STORAGE_KEY = "bili-collection-reverse:v1:settings";
  const DEFAULTS = Object.freeze({ reverseEnabled: false, reverseSectionsEnabled: false });

  function createSessionStore(getStorage) {
    function read() {
      // Resolve the page's sessionStorage lazily: access can be blocked by
      // browser policy, and the caller must be able to report that failure.
      const raw = getStorage().getItem(STORAGE_KEY);
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { return { ...DEFAULTS }; }
      return {
        reverseEnabled: parsed?.reverseEnabled === true,
        reverseSectionsEnabled: parsed?.reverseSectionsEnabled === true
      };
    }

    function write(key, value) {
      if (!Object.hasOwn(DEFAULTS, key) || typeof value !== "boolean") {
        throw new TypeError("Invalid session setting");
      }
      const next = { ...read(), [key]: value };
      getStorage().setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    }

    return Object.freeze({ read, write });
  }

  const api = Object.freeze({ createSessionStore, DEFAULTS, STORAGE_KEY });
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.defineProperty(root, "__BILI_REVERSE_SESSION_V1__", { value: api });
})(globalThis);
