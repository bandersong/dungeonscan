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
      return { ocr: false, classify: false, ollama: false, native: !!N() };
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
    async saveFile(o) {
      if (N() && N().saveFile) { try { return await N().saveFile(o); } catch (e) { return { ok: false }; } }
      const a = document.createElement('a');
      if (o.dataUrl) a.href = o.dataUrl;
      else a.href = 'data:' + (o.kind === 'vtt' ? 'application/json' : 'text/plain') + ';charset=utf-8,' + encodeURIComponent(o.text || '');
      a.download = o.suggestedName || 'map'; a.click();
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
