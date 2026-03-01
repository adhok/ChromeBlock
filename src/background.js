import { env, pipeline } from "@huggingface/transformers";

env.allowRemoteModels = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL(
  "node_modules/onnxruntime-web/dist/"
);

let currentModel = null;
let extractorPromise = null;
const embeddingCache = new Map();

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

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
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

async function scoreTextAgainstProfiles({ text, profiles, model, threshold }) {
  const textEmbedding = await getEmbedding(text, model);
  let best = null;

  for (const profile of profiles) {
    const profileText = buildProfileText(profile);
    if (!profileText) {
      continue;
    }

    const profileEmbedding = await getEmbedding(profileText, model);
    const score = cosineSimilarity(textEmbedding, profileEmbedding);
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
