const { installI18n, translatePattern } = require('../../features/i18n');

// The only renderer payload: reversible DOM localisation. Nothing is reported back.
function rendererSource(dictionary, settings) {
  return `(() => {
    if (window !== window.top) return;
    const generation = (window.__aglMountGeneration || 0) + 1;
    window.__aglMountGeneration = generation;
    function mount() {
      if (window.__aglMountGeneration !== generation) return;
      (${installI18n.toString()})(window, document, ${JSON.stringify(dictionary)}, ${settings.enableI18n === true}, (${translatePattern.toString()}));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  })();`;
}

const disposeSource = 'window.__aglMountGeneration = (window.__aglMountGeneration || 0) + 1; window.__aglI18n?.dispose();';
module.exports = { rendererSource, disposeSource };
