(function initGenericFilter() {
  const {
    getSettings,
    findBestMatch,
    applyBlockState,
    clearBlockState,
    normalizeSettings
  } = globalThis.SafeBrowserShared;

  const MAX_TEXT_LENGTH = 5000;
  const MAX_TEXT_NODES_PER_SCAN = 2000;
  const CONTAINER_TAGS = new Set([
    "ARTICLE",
    "ASIDE",
    "DIV",
    "LI",
    "MAIN",
    "SECTION"
  ]);
  const EXCLUDED_SELECTOR =
    "script, style, noscript, svg, canvas, header, footer, nav, form, input, textarea, button";
  const SITE_SELECTORS = {
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
  const GENERIC_SELECTORS = [
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

  let currentSettings = null;
  let pendingRoots = new Set();
  let pendingFrame = 0;
  let forceFullScan = false;
  let scanSequence = 0;
  const transformerMatchCache = new Map();

  function getSelectorList() {
    return [...(SITE_SELECTORS[window.location.hostname] || []), ...GENERIC_SELECTORS];
  }

  function getSelectorString() {
    return getSelectorList().join(", ");
  }

  function extractText(element) {
    return (element?.innerText || element?.textContent || "").trim();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity || "1") === 0
    ) {
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
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return /(post|feed|card|item|story|result|comment|update|news|headline)/.test(marker);
  }

  function isEligibleContainer(element) {
    if (!isVisible(element)) {
      return false;
    }

    if (element.closest(EXCLUDED_SELECTOR)) {
      return false;
    }

    const text = extractText(element);
    if (!text || text.length > MAX_TEXT_LENGTH) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.height > window.innerHeight * 0.98 && rect.width > window.innerWidth * 0.95) {
      return false;
    }

    return looksLikeContainer(element);
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
      currentSettings?.transformerEnabled &&
        currentSettings?.semanticProfiles?.length &&
        String(text || "").trim().length >= 24
    );
  }

  function requestTransformerMatch(text) {
    const payload = {
      text: String(text || "").slice(0, 1200),
      profiles: currentSettings.semanticProfiles,
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
    const localMatch = findBestMatch(text, currentSettings);
    if (localMatch || !canUseTransformer(text)) {
      return localMatch;
    }

    const cacheKey =
      currentSettings.transformerModel +
      "::" +
      currentSettings.transformerThreshold +
      "::" +
      String(text || "").slice(0, 1200);

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

    return (
      'Matched profile: "' +
      match.label +
      '" via "' +
      match.matchText +
      '" (score ' +
      match.score.toFixed(2) +
      ")"
    );
  }

  function ensurePageOverlay(match) {
    let overlay = document.getElementById("safe-browser-page-overlay");

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "safe-browser-page-overlay";
      overlay.className = "safe-browser-page-overlay";
      overlay.innerHTML =
        '<div class="safe-browser-page-overlay__panel"><h1>Blocked by ChromeBlock</h1><p></p></div>';
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
    return (
      document.querySelector("main article") ||
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector("[role='main']")
    );
  }

  async function applyPageLevelFiltering() {
    removePageOverlay();

    if (
      !currentSettings.enabled ||
      (currentSettings.keywords.length === 0 &&
        !currentSettings.semanticEnabled &&
        !currentSettings.transformerEnabled)
    ) {
      return false;
    }

    const titleMatch = await findBestTextMatch(document.title);
    const urlMatch = await findBestTextMatch(window.location.href);
    const primary = getPrimaryContentElement();
    const bodyMatch = await findBestTextMatch(extractText(primary || document.body));

    if (!bodyMatch || (!titleMatch && !urlMatch)) {
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
    const candidates = new Set();
    const selectors = getSelectorList();

    for (const selector of selectors) {
      if (root.matches?.(selector)) {
        candidates.add(root);
      }

      root.querySelectorAll?.(selector).forEach((element) => candidates.add(element));
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
    const candidates = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: textNodeFilter
    });
    let visited = 0;
    let node = walker.nextNode();

    while (node && visited < MAX_TEXT_NODES_PER_SCAN) {
      visited += 1;

      const match = findBestMatch(node.textContent, currentSettings);
      if (match) {
        const container = findBestContainer(node.parentElement);
        if (container) {
          candidates.add(container);
        }
      }

      node = walker.nextNode();
    }

    return Array.from(candidates);
  }

  function collectCandidates(root) {
    const candidates = new Set();

    collectSelectorCandidates(root).forEach((element) => candidates.add(element));
    collectTextNodeCandidates(root).forEach((element) => candidates.add(element));

    return Array.from(candidates);
  }

  async function filterElement(element, sequence) {
    if (!currentSettings) {
      return;
    }

    clearBlockState(element);

    if (
      !currentSettings.enabled ||
      (currentSettings.keywords.length === 0 &&
        !currentSettings.semanticEnabled &&
        !currentSettings.transformerEnabled)
    ) {
      return;
    }

    const match = await findBestTextMatch(extractText(element));

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

    const roots = forceFullScan || pendingRoots.size === 0
      ? [document.documentElement]
      : Array.from(pendingRoots);

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

    const candidates = new Set();
    roots.forEach((root) => {
      collectCandidates(root).forEach((element) => candidates.add(element));
    });

    await Promise.all(Array.from(candidates, (element) => filterElement(element, sequence)));
  }

  function scheduleScan(root = document.documentElement, fullScan = false) {
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

  const observer = new MutationObserver((mutations) => {
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
      () =>
        observer.observe(document.body, {
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
