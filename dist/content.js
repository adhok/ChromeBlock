(() => {
  // src/shared.js
  var STORAGE_KEY = "safeBrowserSettings";
  var DEFAULT_SETTINGS = {
    enabled: true,
    hideMode: "hide",
    keywords: ["spoiler", "gambling", "nsfw"],
    excludedWebsites: ["claude.ai", "chatgpt.com", "gemini.google.com"],
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
        (Array.isArray(values) ? values : []).map(normalizeKeyword).filter(Boolean)
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
      aliases: normalizeStringList([label, ...raw.aliases || []]),
      related: normalizeStringList(raw.related || raw.relatedTerms || []),
      context: normalizeStringList(raw.context || raw.contextTerms || []),
      threshold: clampNumber(raw.threshold, 0, 1, DEFAULT_SETTINGS.semanticThreshold)
    };
  }
  function normalizeSettings(settings) {
    const merged = {
      ...DEFAULT_SETTINGS,
      ...settings || {}
    };
    return {
      enabled: Boolean(merged.enabled),
      hideMode: merged.hideMode === "blur" ? "blur" : "hide",
      keywords: normalizeStringList(merged.keywords),
      excludedWebsites: normalizeStringList(merged.excludedWebsites),
      semanticEnabled: Boolean(merged.semanticEnabled),
      semanticThreshold: clampNumber(
        merged.semanticThreshold,
        0,
        1,
        DEFAULT_SETTINGS.semanticThreshold
      ),
      transformerEnabled: Boolean(merged.transformerEnabled),
      transformerModel: String(merged.transformerModel || DEFAULT_SETTINGS.transformerModel).trim() || DEFAULT_SETTINGS.transformerModel,
      transformerThreshold: clampNumber(
        merged.transformerThreshold,
        0,
        1,
        DEFAULT_SETTINGS.transformerThreshold
      ),
      semanticProfiles: (Array.isArray(merged.semanticProfiles) ? merged.semanticProfiles : []).map(normalizeProfile).filter(Boolean)
    };
  }
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (result) => {
        resolve(normalizeSettings(result[STORAGE_KEY]));
      });
    });
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

  // src/matcher.js
  function tokenize(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  }
  function buildWordSet(text) {
    return new Set(tokenize(text));
  }
  function scoreSemanticProfile(text, profile, defaultThreshold, wordsSet = null) {
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
    const words = wordsSet || buildWordSet(haystack);
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
  function findBestLocalMatch(text, settings) {
    const haystack = String(text || "").toLowerCase();
    const keyword = (settings.keywords || []).find((kw) => haystack.includes(kw)) || null;
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
    if (!settings.semanticEnabled || !settings.semanticProfiles?.length) {
      return null;
    }
    let best = null;
    let words = null;
    for (const profile of settings.semanticProfiles) {
      let match;
      const aliasMatch = profile.aliases.find((alias) => haystack.includes(alias));
      if (aliasMatch) {
        match = {
          type: "semantic",
          label: profile.label,
          matchText: aliasMatch,
          score: 1,
          threshold: profile.threshold || settings.semanticThreshold,
          reason: "alias"
        };
      } else {
        if (!words) {
          words = buildWordSet(haystack);
        }
        match = scoreSemanticProfile(haystack, profile, settings.semanticThreshold, words);
      }
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

  // src/generic-content.js
  var MAX_TEXT_LENGTH = 5e3;
  var MAX_TEXT_NODES_PER_SCAN = 2e3;
  var CONTAINER_TAGS = /* @__PURE__ */ new Set([
    "ARTICLE",
    "ASIDE",
    "DIV",
    "LI",
    "MAIN",
    "SECTION"
  ]);
  var EXCLUDED_SELECTOR = "script, style, noscript, svg, canvas, header, footer, nav, form, input, textarea, button";
  var SITE_SELECTORS = {
    "x.com": ["article"],
    "twitter.com": ["article"],
    "linkedin.com": [
      ".feed-shared-update-v2",
      ".occludable-update",
      ".scaffold-layout__main article",
      ".scaffold-layout__aside li",
      ".scaffold-layout__aside a",
      ".scaffold-layout__aside div[class*='news']",
      ".scaffold-layout__aside div[class*='item']"
    ],
    "www.linkedin.com": [
      ".feed-shared-update-v2",
      ".occludable-update",
      ".scaffold-layout__main article",
      ".scaffold-layout__aside li",
      ".scaffold-layout__aside a",
      ".scaffold-layout__aside div[class*='news']",
      ".scaffold-layout__aside div[class*='item']"
    ],
    "youtube.com": [
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-comment-thread-renderer",
      "ytd-reel-item-renderer"
    ],
    "www.youtube.com": [
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-comment-thread-renderer",
      "ytd-reel-item-renderer"
    ],
    "reddit.com": ["shreddit-post", "article", "[data-testid='post-container']"],
    "www.reddit.com": ["shreddit-post", "article", "[data-testid='post-container']"]
  };
  var GENERIC_SELECTORS = [
    "article",
    "[role='article']",
    "[role='listitem']",
    "main article",
    "main li",
    "main section",
    "main div[class*='post']",
    "main div[class*='card']",
    "main div[class*='item']",
    "main div[class*='result']",
    "main div[class*='comment']",
    "main div[data-testid*='post']",
    "main div[data-testid*='card']",
    "main div[data-testid*='result']",
    "section article",
    "section li",
    "aside li",
    "aside article",
    "aside div[class*='item']",
    "aside div[class*='card']",
    "aside div[class*='news']",
    "aside div[class*='story']",
    "[role='complementary'] li",
    "[role='complementary'] article",
    "[role='complementary'] div[class*='item']"
  ];
  var currentSettings = null;
  var pendingRoots = /* @__PURE__ */ new Set();
  var pendingFrame = 0;
  var forceFullScan = false;
  var scanSequence = 0;
  var transformerMatchCache = /* @__PURE__ */ new Map();
  var elementTextCache = /* @__PURE__ */ new WeakMap();
  function isCurrentPageExcluded(settings) {
    if (!settings || !settings.excludedWebsites || settings.excludedWebsites.length === 0) {
      return false;
    }
    const hostname = window.location.hostname.toLowerCase();
    return settings.excludedWebsites.some((site) => {
      const normalizedSite = site.toLowerCase();
      return hostname === normalizedSite || hostname.endsWith("." + normalizedSite);
    });
  }
  function getSelectorList() {
    return [...SITE_SELECTORS[window.location.hostname] || [], ...GENERIC_SELECTORS];
  }
  function getSelectorString() {
    return getSelectorList().join(", ");
  }
  function extractText(element) {
    return (element?.innerText || element?.textContent || "").trim();
  }
  function getElementTextSnapshot(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }
    const cached = elementTextCache.get(element);
    if (cached && cached.sequence === scanSequence) {
      return cached.text;
    }
    const text = extractText(element);
    elementTextCache.set(element, { text, sequence: scanSequence });
    return text;
  }
  function isVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 40 && rect.height >= 16;
  }
  function looksLikeContainer(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (CONTAINER_TAGS.has(element.tagName)) {
      return true;
    }
    const role = element.getAttribute("role") || "";
    if (["article", "listitem", "row", "gridcell"].includes(role)) {
      return true;
    }
    const marker = [
      element.className,
      element.getAttribute("data-testid"),
      element.getAttribute("data-view-name")
    ].filter(Boolean).join(" ").toLowerCase();
    return /(post|feed|card|item|story|result|comment|update|news|headline)/.test(marker);
  }
  function isEligibleContainer(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (!looksLikeContainer(element)) {
      return false;
    }
    if (element.closest(EXCLUDED_SELECTOR)) {
      return false;
    }
    const rawText = element.textContent || "";
    if (!rawText.trim()) {
      return false;
    }
    if (!isVisible(element)) {
      return false;
    }
    const text = getElementTextSnapshot(element);
    if (!text || text.length > MAX_TEXT_LENGTH) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.height > window.innerHeight * 0.98 && rect.width > window.innerWidth * 0.95) {
      return false;
    }
    return true;
  }
  function clearAllBlockStates() {
    document.querySelectorAll("[data-safe-browser-blocked='true']").forEach(clearBlockState);
    removePageOverlay();
  }
  function trimCache(map, maxEntries) {
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }
  function canUseTransformer(text) {
    return Boolean(
      currentSettings?.transformerEnabled && currentSettings?.semanticProfiles?.length && String(text || "").trim().length >= 24
    );
  }
  function requestTransformerMatch(text) {
    const payload = {
      text: String(text || "").slice(0, 1200),
      model: currentSettings.transformerModel,
      threshold: currentSettings.transformerThreshold
    };
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "safe-browser-score-transformer",
          payload
        },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            resolve(null);
            return;
          }
          resolve(response.match || null);
        }
      );
    });
  }
  async function findBestTextMatch(text) {
    const localMatch = findBestLocalMatch(text, currentSettings);
    if (localMatch || !canUseTransformer(text)) {
      return localMatch;
    }
    const cacheKey = currentSettings.transformerModel + "::" + currentSettings.transformerThreshold + "::" + String(text || "").slice(0, 1200);
    if (transformerMatchCache.has(cacheKey)) {
      return transformerMatchCache.get(cacheKey);
    }
    const matchPromise = requestTransformerMatch(text).then((match) => {
      transformerMatchCache.set(cacheKey, match);
      trimCache(transformerMatchCache, 200);
      return match;
    });
    transformerMatchCache.set(cacheKey, matchPromise);
    return matchPromise;
  }
  function formatMatch(match) {
    if (!match) {
      return "";
    }
    if (match.type === "keyword") {
      return 'Matched keyword: "' + match.label + '"';
    }
    return 'Matched profile: "' + match.label + '" via "' + match.matchText + '" (score ' + match.score.toFixed(2) + ")";
  }
  function ensurePageOverlay(match) {
    let overlay = document.getElementById("safe-browser-page-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "safe-browser-page-overlay";
      overlay.className = "safe-browser-page-overlay";
      overlay.innerHTML = '<div class="safe-browser-page-overlay__panel"><h1>Blocked by ChromeBlock</h1><p></p></div>';
      document.documentElement.appendChild(overlay);
    }
    overlay.dataset.mode = currentSettings.hideMode;
    overlay.querySelector("p").textContent = formatMatch(match);
    document.documentElement.classList.add("safe-browser-page-blocked");
  }
  function removePageOverlay() {
    document.getElementById("safe-browser-page-overlay")?.remove();
    document.documentElement.classList.remove("safe-browser-page-blocked");
  }
  function getPrimaryContentElement() {
    return document.querySelector("main article") || document.querySelector("article") || document.querySelector("main") || document.querySelector("[role='main']");
  }
  async function applyPageLevelFiltering() {
    removePageOverlay();
    if (!currentSettings.enabled || isCurrentPageExcluded(currentSettings) || currentSettings.keywords.length === 0 && !currentSettings.semanticEnabled && !currentSettings.transformerEnabled) {
      return false;
    }
    const titleMatch = await findBestTextMatch(document.title);
    const urlMatch = await findBestTextMatch(window.location.href);
    const primary = getPrimaryContentElement();
    const bodyMatch = await findBestTextMatch(getElementTextSnapshot(primary || document.body));
    if (!bodyMatch || !titleMatch && !urlMatch) {
      return false;
    }
    if (primary && isEligibleContainer(primary)) {
      applyBlockState(primary, currentSettings.hideMode, bodyMatch.label);
      return false;
    }
    ensurePageOverlay(bodyMatch);
    return true;
  }
  function collectSelectorCandidates(root) {
    const candidates = /* @__PURE__ */ new Set();
    const selectorString = getSelectorString();
    if (root.matches?.(selectorString)) {
      candidates.add(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll(selectorString).forEach((element) => candidates.add(element));
    }
    return Array.from(candidates).filter(isEligibleContainer);
  }
  function findBestContainer(startElement) {
    if (!(startElement instanceof HTMLElement)) {
      return null;
    }
    const selectorMatch = startElement.closest(getSelectorString());
    if (selectorMatch && isEligibleContainer(selectorMatch)) {
      return selectorMatch;
    }
    let current = startElement;
    let depth = 0;
    while (current && current !== document.body && depth < 8) {
      if (isEligibleContainer(current)) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }
    return null;
  }
  function textNodeFilter(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDED_SELECTOR)) {
      return NodeFilter.FILTER_REJECT;
    }
    const value = String(node.textContent || "").trim();
    if (!value) {
      return NodeFilter.FILTER_REJECT;
    }
    if (!isVisible(parent)) {
      return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }
  function collectTextNodeCandidates(root) {
    const candidates = /* @__PURE__ */ new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: textNodeFilter
    });
    let visited = 0;
    let node = walker.nextNode();
    while (node && visited < MAX_TEXT_NODES_PER_SCAN) {
      visited += 1;
      const text = String(node.textContent || "").trim();
      if (text.length >= 2 && /[a-z0-9]/i.test(text)) {
        const match = findBestLocalMatch(text, currentSettings);
        if (match) {
          const container = findBestContainer(node.parentElement);
          if (container) {
            candidates.add(container);
          }
        }
      }
      node = walker.nextNode();
    }
    return Array.from(candidates);
  }
  function collectCandidates(root) {
    const candidates = /* @__PURE__ */ new Set();
    const selectorCandidates = collectSelectorCandidates(root);
    selectorCandidates.forEach((element) => candidates.add(element));
    if (selectorCandidates.length === 0) {
      collectTextNodeCandidates(root).forEach((element) => candidates.add(element));
    }
    return Array.from(candidates);
  }
  async function filterElement(element, sequence) {
    if (!currentSettings) {
      return;
    }
    clearBlockState(element);
    if (!currentSettings.enabled || currentSettings.keywords.length === 0 && !currentSettings.semanticEnabled && !currentSettings.transformerEnabled) {
      return;
    }
    const match = await findBestTextMatch(getElementTextSnapshot(element));
    if (match && sequence === scanSequence) {
      applyBlockState(element, currentSettings.hideMode, match.label);
    }
  }
  async function runScan() {
    pendingFrame = 0;
    scanSequence += 1;
    const sequence = scanSequence;
    if (!currentSettings) {
      pendingRoots.clear();
      forceFullScan = false;
      return;
    }
    const roots = forceFullScan || pendingRoots.size === 0 ? [document.documentElement] : Array.from(pendingRoots);
    const fullScan = forceFullScan || roots.includes(document.documentElement);
    pendingRoots.clear();
    forceFullScan = false;
    if (fullScan) {
      clearAllBlockStates();
    }
    const pageBlocked = await applyPageLevelFiltering();
    if (pageBlocked) {
      return;
    }
    const candidates = /* @__PURE__ */ new Set();
    roots.forEach((root) => {
      collectCandidates(root).forEach((element) => candidates.add(element));
    });
    await Promise.all(Array.from(candidates, (element) => filterElement(element, sequence)));
  }
  function scheduleScan(root = document.documentElement, fullScan = false) {
    if (currentSettings && isCurrentPageExcluded(currentSettings)) {
      clearAllBlockStates();
      return;
    }
    pendingRoots.add(root);
    forceFullScan = forceFullScan || fullScan;
    if (pendingFrame) {
      return;
    }
    pendingFrame = window.setTimeout(runScan, 120);
  }
  async function refreshSettings() {
    currentSettings = await getSettings();
    transformerMatchCache.clear();
    scheduleScan(document.documentElement, true);
  }
  var observer = new MutationObserver((mutations) => {
    let requiresFullScan = false;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        if (mutation.target.parentElement) {
          scheduleScan(mutation.target.parentElement);
        } else {
          requiresFullScan = true;
        }
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          scheduleScan(node);
        }
      }
    }
    if (requiresFullScan) {
      scheduleScan(document.documentElement, true);
    }
  });
  refreshSettings();
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  } else {
    window.addEventListener(
      "DOMContentLoaded",
      () => observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      }),
      { once: true }
    );
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes.safeBrowserSettings) {
      return;
    }
    currentSettings = normalizeSettings(changes.safeBrowserSettings.newValue);
    transformerMatchCache.clear();
    scheduleScan(document.documentElement, true);
  });
})();
