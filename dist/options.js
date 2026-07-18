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
  function saveSettings(settings) {
    return new Promise((resolve) => {
      const normalized = normalizeSettings(settings);
      chrome.storage.sync.set({ [STORAGE_KEY]: normalized }, () => resolve(normalized));
    });
  }

  // src/options.js
  var enabledInput = document.getElementById("enabled");
  var hideModeInput = document.getElementById("hideMode");
  var keywordsInput = document.getElementById("keywords");
  var excludedWebsitesInput = document.getElementById("excludedWebsites");
  var semanticEnabledInput = document.getElementById("semanticEnabled");
  var semanticThresholdInput = document.getElementById("semanticThreshold");
  var transformerEnabledInput = document.getElementById("transformerEnabled");
  var transformerModelInput = document.getElementById("transformerModel");
  var transformerThresholdInput = document.getElementById("transformerThreshold");
  var semanticProfilesInput = document.getElementById("semanticProfiles");
  var saveButton = document.getElementById("save");
  var status = document.getElementById("status");
  function keywordsToText(keywords) {
    return keywords.join("\n");
  }
  function textToKeywords(text) {
    return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  }
  function profilesToText(profiles) {
    return JSON.stringify(profiles, null, 2);
  }
  function textToProfiles(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return [];
    }
    return JSON.parse(trimmed);
  }
  async function load() {
    const settings = await getSettings();
    enabledInput.checked = settings.enabled;
    hideModeInput.value = settings.hideMode;
    keywordsInput.value = keywordsToText(settings.keywords);
    excludedWebsitesInput.value = keywordsToText(settings.excludedWebsites);
    semanticEnabledInput.checked = settings.semanticEnabled;
    semanticThresholdInput.value = String(settings.semanticThreshold);
    transformerEnabledInput.checked = settings.transformerEnabled;
    transformerModelInput.value = settings.transformerModel;
    transformerThresholdInput.value = String(settings.transformerThreshold);
    semanticProfilesInput.value = profilesToText(settings.semanticProfiles);
  }
  async function handleSave() {
    let semanticProfiles;
    try {
      semanticProfiles = textToProfiles(semanticProfilesInput.value);
    } catch (error) {
      status.textContent = "Semantic profiles must be valid JSON.";
      return;
    }
    const settings = {
      enabled: enabledInput.checked,
      hideMode: hideModeInput.value,
      keywords: textToKeywords(keywordsInput.value),
      excludedWebsites: textToKeywords(excludedWebsitesInput.value),
      semanticEnabled: semanticEnabledInput.checked,
      semanticThreshold: Number(semanticThresholdInput.value || 0.72),
      transformerEnabled: transformerEnabledInput.checked,
      transformerModel: transformerModelInput.value.trim() || "Xenova/all-MiniLM-L6-v2",
      transformerThreshold: Number(transformerThresholdInput.value || 0.44),
      semanticProfiles
    };
    await saveSettings(settings);
    status.textContent = "Saved.";
    window.setTimeout(() => {
      status.textContent = "";
    }, 1500);
  }
  saveButton.addEventListener("click", handleSave);
  load();
})();
