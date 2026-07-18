const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

async function build() {
  console.log("Starting build process...");

  // 1. Ensure dist directory exists
  fs.mkdirSync("dist", { recursive: true });

  // 2. Copy manifest.json and adjust paths
  console.log("Copying and adapting manifest.json...");
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  manifest.background = {
    service_worker: "background.js"
  };
  manifest.content_scripts[0].js = ["content.js"];
  manifest.content_scripts[0].css = ["content.css"];
  fs.writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));

  // 3. Copy options.html and adjust script/style tags
  console.log("Adapting options.html...");
  let optionsHtml = fs.readFileSync("options.html", "utf8");
  // Remove the script tag for shared.js since it's bundled now
  optionsHtml = optionsHtml.replace(/<script src="src\/shared\.js"><\/script>\s*/, "");
  // Update src/options.js to options.js
  optionsHtml = optionsHtml.replace('src/options.js', 'options.js');
  // Update src/options.css to options.css
  optionsHtml = optionsHtml.replace('src/options.css', 'options.css');
  fs.writeFileSync("dist/options.html", optionsHtml);

  // 4. Copy CSS files
  console.log("Copying CSS files...");
  fs.copyFileSync("src/content.css", "dist/content.css");
  fs.copyFileSync("src/options.css", "dist/options.css");

  // 5. Copy ONNX runtime WASM/helper files
  console.log("Copying ONNX runtime assets from node_modules...");
  const onnxSrcDir = "node_modules/onnxruntime-web/dist";
  const onnxDstDir = "dist/onnx";
  fs.mkdirSync(onnxDstDir, { recursive: true });

  if (fs.existsSync(onnxSrcDir)) {
    const files = fs.readdirSync(onnxSrcDir);
    for (const file of files) {
      if (file.endsWith(".wasm") || file.endsWith(".mjs")) {
        fs.copyFileSync(path.join(onnxSrcDir, file), path.join(onnxDstDir, file));
      }
    }
  } else {
    throw new Error("Could not find onnxruntime-web files in node_modules!");
  }

  // 6. Bundle JS files
  console.log("Bundling JS entrypoints...");
  await esbuild.build({
    entryPoints: {
      background: "src/background.js",
      content: "src/generic-content.js",
      options: "src/options.js"
    },
    bundle: true,
    outdir: "dist",
    platform: "browser",
    format: "iife",
    minify: false,
    sourcemap: false
  });

  console.log("Build completed successfully in 'dist/' directory!");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
