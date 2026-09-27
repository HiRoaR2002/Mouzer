const nut = require("@nut-tree-fork/nut-js");

(async () => {
  const w = await nut.screen.width();
  const h = await nut.screen.height();
  console.log("primary size:", w, "x", h);

  const pos = await nut.mouse.getPosition();
  console.log("cursor:", JSON.stringify(pos), "x/y:", pos.x, pos.y);

  for (const attempt of ["bare", "region"]) {
    try {
      const t0 = Date.now();
      const img =
        attempt === "bare"
          ? await nut.screen.capture()
          : await nut.screen.captureRegion(0, 0, 320, 240);
      const ms = Date.now() - t0;
      console.log(`capture(${attempt}) OK in ${ms}ms ->`, img && img.constructor && img.constructor.name);
      if (img && typeof img.getSize === "function") console.log("  size:", JSON.stringify(img.getSize()));
    } catch (e) {
      console.log(`capture(${attempt}) FAILED:`, e && e.message);
    }
  }
})().catch((e) => {
  console.error("HARD FAIL:", e && e.message);
  process.exitCode = 1;
});
