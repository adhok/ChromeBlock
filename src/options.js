(function initOptionsPage() {
  const { getSettings, saveSettings } = globalThis.SafeBrowserShared;

  const enabledInput = document.getElementById("enabled");
  const hideModeInput = document.getElementById("hideMode");
  const keywordsInput = document.getElementById("keywords");
  const semanticEnabledInput = document.getElementById("semanticEnabled");
  const semanticThresholdInput = document.getElementById("semanticThreshold");
  const transformerEnabledInput = document.getElementById("transformerEnabled");
  const transformerModelInput = document.getElementById("transformerModel");
  const transformerThresholdInput = document.getElementById("transformerThreshold");
  const semanticProfilesInput = document.getElementById("semanticProfiles");
  const saveButton = document.getElementById("save");
  const status = document.getElementById("status");

  function keywordsToText(keywords) {
    return keywords.join("\n");
  }

  function textToKeywords(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
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
