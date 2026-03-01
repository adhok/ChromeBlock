(function initSafeBrowserShared(global) {
  const STORAGE_KEY = "safeBrowserSettings";
  const DEFAULT_SETTINGS = {
    enabled: true,
    hideMode: "hide",
    keywords: ["spoiler", "gambling", "nsfw"],
    semanticEnabled: false,
    semanticThreshold: 0.72,
    semanticProfiles: [],
    transformerEnabled: false,
    transformerModel: "Xenova/all-MiniLM-L6-v2",
    transformerThreshold: 0.44
  };

  function normalizeKeyword(keyword) {
    return String(keyword || "").trim().toLowerCase();
  }

  function normalizeStringList(values) {
    return Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map(normalizeKeyword)
          .filter(Boolean)
      )
    );
  }

  function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, numeric));
  }

  function normalizeProfile(profile) {
    const raw = profile || {};
    const label = String(raw.label || raw.name || "").trim();

    if (!label) {
      return null;
    }

    return {
      label,
      aliases: normalizeStringList([label, ...(raw.aliases || [])]),
      related: normalizeStringList(raw.related || raw.relatedTerms || []),
      context: normalizeStringList(raw.context || raw.contextTerms || []),
      threshold: clampNumber(raw.threshold, 0, 1, DEFAULT_SETTINGS.semanticThreshold)
    };
  }

  function normalizeSettings(settings) {
    const merged = {
      ...DEFAULT_SETTINGS,
      ...(settings || {})
    };

    return {
      enabled: Boolean(merged.enabled),
      hideMode: merged.hideMode === "blur" ? "blur" : "hide",
      keywords: normalizeStringList(merged.keywords),
      semanticEnabled: Boolean(merged.semanticEnabled),
      semanticThreshold: clampNumber(
        merged.semanticThreshold,
        0,
        1,
        DEFAULT_SETTINGS.semanticThreshold
      ),
      transformerEnabled: Boolean(merged.transformerEnabled),
      transformerModel: String(merged.transformerModel || DEFAULT_SETTINGS.transformerModel).trim() ||
        DEFAULT_SETTINGS.transformerModel,
      transformerThreshold: clampNumber(
        merged.transformerThreshold,
        0,
        1,
        DEFAULT_SETTINGS.transformerThreshold
      ),
      semanticProfiles: (Array.isArray(merged.semanticProfiles) ? merged.semanticProfiles : [])
        .map(normalizeProfile)
        .filter(Boolean)
    };
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (result) => {
        resolve(normalizeSettings(result[STORAGE_KEY]));
      });
    });
  }

  function saveSettings(settings) {
    return new Promise((resolve) => {
      const normalized = normalizeSettings(settings);
      chrome.storage.sync.set({ [STORAGE_KEY]: normalized }, () => resolve(normalized));
    });
  }

  function textMatchesKeywords(text, keywords) {
    const haystack = String(text || "").toLowerCase();

    return keywords.some((keyword) => haystack.includes(keyword));
  }

  function findMatchingKeyword(text, keywords) {
    const haystack = String(text || "").toLowerCase();

    return keywords.find((keyword) => haystack.includes(keyword)) || null;
  }

  function tokenize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function buildWordSet(text) {
    return new Set(tokenize(text));
  }

  function countMatches(text, terms) {
    const haystack = String(text || "").toLowerCase();
    return terms.filter((term) => haystack.includes(term)).length;
  }

  function scoreSemanticProfile(text, profile, defaultThreshold) {
    const haystack = String(text || "").toLowerCase();
    if (!haystack) {
      return null;
    }

    const aliasMatch = profile.aliases.find((alias) => haystack.includes(alias));
    if (aliasMatch) {
      return {
        type: "semantic",
        label: profile.label,
        matchText: aliasMatch,
        score: 1,
        threshold: profile.threshold || defaultThreshold,
        reason: "alias"
      };
    }

    const words = buildWordSet(haystack);
    const relatedMatches = profile.related.filter((term) => {
      if (term.includes(" ")) {
        return haystack.includes(term);
      }

      return words.has(term);
    });
    const contextMatches = profile.context.filter((term) => {
      if (term.includes(" ")) {
        return haystack.includes(term);
      }

      return words.has(term);
    });

    if (relatedMatches.length === 0) {
      return null;
    }

    let score = 0.42;
    score += Math.min(0.33, relatedMatches.length * 0.18);
    score += Math.min(0.18, contextMatches.length * 0.09);

    // Reward denser coverage for longer related-term sets.
    if (profile.related.length >= 4) {
      score += Math.min(0.12, relatedMatches.length / profile.related.length);
    }

    score = Math.min(0.99, score);

    return {
      type: "semantic",
      label: profile.label,
      matchText: relatedMatches[0],
      score,
      threshold: profile.threshold || defaultThreshold,
      reason: contextMatches.length > 0 ? "related+context" : "related"
    };
  }

  function findBestMatch(text, settings) {
    const keyword = findMatchingKeyword(text, settings.keywords || []);
    if (keyword) {
      return {
        type: "keyword",
        label: keyword,
        matchText: keyword,
        score: 1,
        threshold: 1,
        reason: "keyword"
      };
    }

    if (!settings.semanticEnabled) {
      return null;
    }

    let best = null;

    for (const profile of settings.semanticProfiles || []) {
      const match = scoreSemanticProfile(text, profile, settings.semanticThreshold);
      if (!match) {
        continue;
      }

      if (match.score < match.threshold) {
        continue;
      }

      if (!best || match.score > best.score) {
        best = match;
      }
    }

    return best;
  }

  function applyBlockState(element, mode, matchedKeyword) {
    if (!element || element.dataset.safeBrowserBlocked === "true") {
      return;
    }

    element.dataset.safeBrowserBlocked = "true";
    element.dataset.safeBrowserKeyword = matchedKeyword;

    if (mode === "blur") {
      element.classList.add("safe-browser-blur");
      return;
    }

    element.classList.add("safe-browser-hidden");
  }

  function clearBlockState(element) {
    if (!element) {
      return;
    }

    delete element.dataset.safeBrowserBlocked;
    delete element.dataset.safeBrowserKeyword;
    element.classList.remove("safe-browser-hidden");
    element.classList.remove("safe-browser-blur");
  }

  global.SafeBrowserShared = {
    DEFAULT_SETTINGS,
    STORAGE_KEY,
    normalizeSettings,
    normalizeProfile,
    getSettings,
    saveSettings,
    textMatchesKeywords,
    findMatchingKeyword,
    findBestMatch,
    scoreSemanticProfile,
    applyBlockState,
    clearBlockState
  };
})(globalThis);
