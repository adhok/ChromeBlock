import { env, pipeline } from "@huggingface/transformers";
import { getSettings, normalizeSettings, STORAGE_KEY } from "./shared.js";

env.allowRemoteModels = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("onnx/");
env.backends.onnx.wasm.numThreads = 1;

let currentModel = null;
let extractorPromise = null;
const embeddingCache = new Map();

let currentSettings = null;
let profileEmbeddingsCache = [];
let precomputePromise = null;

function trimCache(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function buildProfileText(profile) {
  return [
    profile.label,
    ...(profile.aliases || []),
    ...(profile.related || []),
    ...(profile.context || [])
  ]
    .filter(Boolean)
    .join(". ");
}

function dotProduct(left, right) {
  let dot = 0;
  const length = left.length;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
  }
  return dot;
}

async function getExtractor(model) {
  if (!extractorPromise || currentModel !== model) {
    currentModel = model;
    extractorPromise = pipeline("feature-extraction", model, {
      dtype: "q8"
    });
  }

  return extractorPromise;
}

async function getEmbedding(text, model) {
  const normalizedText = String(text || "").trim().slice(0, 1200);
  const cacheKey = model + "::" + normalizedText;

  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  const extractor = await getExtractor(model);
  const output = await extractor(normalizedText, {
    pooling: "mean",
    normalize: true
  });
  const vector = Array.from(output.data);

  embeddingCache.set(cacheKey, vector);
  trimCache(embeddingCache, 250);

  return vector;
}

function getProfilesFingerprint(profiles, model) {
  return model + "::" + JSON.stringify(profiles || []);
}

async function ensureProfileEmbeddings() {
  if (!currentSettings) {
    currentSettings = await getSettings();
  }

  const fingerprint = getProfilesFingerprint(
    currentSettings.semanticProfiles,
    currentSettings.transformerModel
  );

  if (precomputePromise) {
    await precomputePromise;
    return;
  }

  precomputePromise = (async () => {
    const cacheKey = "cached_profile_embeddings";
    const localResult = await new Promise((resolve) => {
      chrome.storage.local.get([cacheKey], (res) => resolve(res[cacheKey]));
    });

    if (localResult && localResult.fingerprint === fingerprint) {
      profileEmbeddingsCache = localResult.embeddings;
      return;
    }

    const model = currentSettings.transformerModel;
    const profiles = currentSettings.semanticProfiles || [];
    const list = [];
    for (const profile of profiles) {
      const profileText = buildProfileText(profile);
      if (!profileText) {
        continue;
      }
      const embedding = await getEmbedding(profileText, model);
      list.push({ profile, embedding });
    }

    profileEmbeddingsCache = list;

    await new Promise((resolve) => {
      chrome.storage.local.set(
        {
          [cacheKey]: {
            fingerprint,
            embeddings: list
          }
        },
        resolve
      );
    });
  })();

  await precomputePromise;
}

async function scoreTextAgainstProfiles({ text, model, threshold }) {
  await ensureProfileEmbeddings();

  if (!currentSettings?.transformerEnabled || profileEmbeddingsCache.length === 0) {
    return null;
  }

  const textEmbedding = await getEmbedding(text, model);
  let best = null;

  for (const { profile, embedding } of profileEmbeddingsCache) {
    const score = dotProduct(textEmbedding, embedding);
    const minimum = Number(profile.threshold ?? threshold ?? 0.44);

    if (score < minimum) {
      continue;
    }

    if (!best || score > best.score) {
      best = {
        type: "transformer",
        label: profile.label,
        matchText: profile.label,
        score,
        threshold: minimum,
        reason: "embedding"
      };
    }
  }

  return best;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[STORAGE_KEY]) {
    return;
  }
  currentSettings = normalizeSettings(changes[STORAGE_KEY].newValue);
  precomputePromise = null;
  ensureProfileEmbeddings().catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "safe-browser-score-transformer") {
    return undefined;
  }

  (async () => {
    try {
      const match = await scoreTextAgainstProfiles(message.payload || {});
      sendResponse({ ok: true, match });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});
