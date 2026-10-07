# BimGo Web

**Try it:** https://ibrahimfahdah.github.io/BimGo/ · [open the sample model directly](https://ibrahimfahdah.github.io/BimGo/?model=/BimGo/samples/BimGo%20Sample%20Pavilion.bimgo)

BimGo for the browser: a TypeScript + WebGL2 port of the BimGo walkthrough app, hosted on GitHub Pages at https://ibrahimfahdah.github.io/BimGo/. No model yet? Press **TRY THE SAMPLE**. The plan and the notes for each phase are in `ai/261007_Web/`; the main README (§11) has the details.

```
npm install
npm run dev      # http://localhost:5173/BimGo/
npm test
npm run lint
npm run build    # static site in dist/
node scripts/make-sample.mjs   # regenerates public/samples/BimGo Sample Pavilion.bimgo
```

`.bimgo` files are opened from your disk and never uploaded. Live Revit sessions: in Revit, Go → tick **Open in the browser**.
