# ChromeBlock

A minimal Manifest V3 browser extension that hides or blurs webpage content when it matches user-defined keywords.

## What it does

- Filters common feed, card, post, result, sidebar, and comment containers across websites
- Scans visible text nodes and resolves them to nearby content containers
- Applies page-level blocking when the URL/title and primary content match a blocked keyword
- Includes stronger selectors for X, LinkedIn, YouTube, and Reddit-style layouts
- Supports optional semantic profiles with aliases, related terms, and context terms
- Supports optional `Transformers.js` embedding scoring in the extension background worker
- Watches dynamic page updates with `MutationObserver`
- Stores settings with `chrome.storage.sync`

## Load locally

1. Run `npm run build:extension`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Click `Load unpacked`
5. Select the cloned project folder

## Reload after changes

1. Open `chrome://extensions`
2. Click `Reload` on the extension
3. Refresh the target webpage

## Configure

1. Open the extension details page
2. Click `Extension options`
3. Add one keyword or phrase per line
4. Choose whether matching items should be hidden or blurred
5. Optionally enable semantic profiles and paste JSON profiles
6. Optionally enable `Transformers.js` scoring for embedding-based profile matching

## Semantic profile example

```json
[
  {
    "label": "Manchester United",
    "aliases": ["man utd", "mufc"],
    "related": [
      "bruno fernandes",
      "old trafford",
      "andre onana",
      "ruben amorim"
    ],
    "context": ["football", "soccer", "premier league"],
    "threshold": 0.72
  }
]
```

This profile format powers both:
- the lightweight in-extension scorer, and
- the optional `Transformers.js` embedding scorer.

## Notes

- This is still an MVP. Browser-wide filtering depends on DOM heuristics, so some sites will still need selector tuning.
- Direct keyword matching is simple case-insensitive substring matching.
- Semantic profiles use weighted alias/related/context scoring by default.
- If `Transformers.js` scoring is enabled, the background worker also compares candidate text embeddings against profile embeddings using `Xenova/all-MiniLM-L6-v2` by default.
- The first transformer-backed match may take a while because the model files need to download.
- This unpacked extension now depends on the local `node_modules` folder being present.
- If the background worker changes, run `npm run build:extension` before reloading the extension.
- The extension runs on `http` and `https` pages in the browser, not native mobile apps.
