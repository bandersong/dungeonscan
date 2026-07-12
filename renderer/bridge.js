/*
 * Bridge to the native layer. In the real app `window.native` is injected by the
 * Swift WKWebView shell (Vision OCR + CoreML classify + native file panels). In a
 * plain browser (dev/testing) we fall back to file input / download and no-op ML.
 */
(function () {
  'use strict';
  const N = () => window.native;

  window.DSBridge = {
    async capabilities() {
      try { if (N() && N().capabilities) return await N().capabilities(); } catch (_) {}
      return { ocr: false, classify: false, terrain: false, ollama: false, native: !!N() };
    },
    async openImage() {
      if (N() && N().openImage) {
        const r = await N().openImage();
        return r && r.dataUrl ? { name: r.name || 'photo', dataUrl: r.dataUrl } : null;
      }
      return new Promise((res) => {
        const inp = document.getElementById('file');
        inp.onchange = (e) => {
          const f = e.target.files[0]; inp.value = '';
          if (!f) return res(null);
          const rd = new FileReader(); rd.onload = () => res({ name: f.name, dataUrl: rd.result }); rd.readAsDataURL(f);
        };
        inp.click();
      });
    },
    // Rasterize a PDF (its first page) to a PNG data URL via the native layer.
    // Returns null in a plain browser (no PDFKit) — callers fall back with a hint.
    async rasterizePdf(dataUrl) {
      if (N() && N().rasterizePdf) {
        try { const r = await N().rasterizePdf(dataUrl); return r && r.dataUrl ? r.dataUrl : null; }
        catch (e) { return null; }
      }
      return null;
    },
    // Open a saved .dungeonscan / .json project as text. Native panel when the
    // Swift bridge is present, else a hidden <input type=file> fallback.
    async openProject() {
      if (N() && N().openProject) {
        try {
          const r = await N().openProject();
          return r && r.text ? { name: r.name || 'project.dungeonscan', text: r.text } : null;
        } catch (e) { return null; }
      }
      return new Promise((res) => {
        const inp = document.getElementById('projFile');
        if (!inp) return res(null);
        inp.onchange = (e) => {
          const f = e.target.files[0]; inp.value = '';
          if (!f) return res(null);
          const rd = new FileReader(); rd.onload = () => res({ name: f.name, text: String(rd.result) }); rd.readAsText(f);
        };
        inp.click();
      });
    },
    async saveFile(o) {
      if (N() && N().saveFile) { try { return await N().saveFile(o); } catch (e) { return { ok: false }; } }
      const a = document.createElement('a');
      let objUrl = null;
      try {
        if (o.dataUrl) {
          // Binary data URLs (e.g. data:application/pdf;base64,…) download far
          // more reliably as a Blob than as a raw href in some browsers.
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(o.dataUrl);
          if (m && m[2] && typeof Blob !== 'undefined' && typeof atob !== 'undefined') {
            const mime = m[1] || 'application/octet-stream';
            const bin = atob(m[3]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            objUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
            a.href = objUrl;
          } else {
            a.href = o.dataUrl;
          }
        } else {
          a.href = 'data:' + (o.kind === 'vtt' || o.kind === 'json' ? 'application/json' : 'text/plain') + ';charset=utf-8,' + encodeURIComponent(o.text || '');
        }
        a.download = o.suggestedName || 'map';
        document.body.appendChild(a); a.click(); a.remove();
      } finally {
        if (objUrl) setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
      }
      return { ok: true, browser: true };
    },
    async ocr(imageDataUrl) {
      if (N() && N().ocr) { try { return await N().ocr(imageDataUrl); } catch (e) { return []; } }
      return [];
    },
    async classify(cropDataUrls, model) {
      if (N() && N().classify) { try { return await N().classify(cropDataUrls, model); } catch (e) {} }
      return cropDataUrls.map(() => ({ label: 'unknown', confidence: 0 }));
    },
    // optional local vision-LLM (Ollama) — Developer-ID build only; sandbox/MAS returns null
    async vlm(imageDataUrl, prompt) {
      if (N() && N().vlm) { try { return await N().vlm(imageDataUrl, prompt); } catch (e) { return null; } }
      return null;
    }
  };
})();
