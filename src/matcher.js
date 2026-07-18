export function findMatchingKeyword(text, keywords) {
  const haystack = String(text || "").toLowerCase();

  return keywords.find((keyword) => haystack.includes(keyword)) || null;
}

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function buildWordSet(text) {
  return new Set(tokenize(text));
}

export function scoreSemanticProfile(text, profile, defaultThreshold, wordsSet = null) {
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

export function findBestLocalMatch(text, settings) {
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
