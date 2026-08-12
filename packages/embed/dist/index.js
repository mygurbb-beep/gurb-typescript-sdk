// src/index.ts
var DEFAULT_BASE_URL = "https://mygurb.com";
function resolveTarget(target) {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el || !(el instanceof HTMLElement)) {
    throw new Error(`Gurb embed: target ${typeof target === "string" ? target : ""} not found`);
  }
  return el;
}
function assertNotASecret(token) {
  if (token.startsWith("gurb_")) {
    throw new Error(
      "Gurb embed: that is a secret API key, not an embed token. Never send an API key to the browser \u2014 mint an embed token on your server with @gurb/server."
    );
  }
  if (token.length === 0) {
    throw new Error("Gurb embed: empty embed token");
  }
}
function mount(options) {
  const {
    slug,
    section,
    baseUrl = DEFAULT_BASE_URL,
    initialHeight = 600,
    autoResize = true
  } = options;
  const container = resolveTarget(options.target);
  const origin = new URL(baseUrl).origin;
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = `${initialHeight}px`;
  iframe.style.border = "0";
  iframe.setAttribute("title", `Gurb \u2014 ${section}`);
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  );
  const onMessage = (event) => {
    if (event.origin !== origin) return;
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== "gurb-embed") return;
    if (data.type === "resize" && autoResize && typeof data.height === "number") {
      const height = Math.min(Math.max(data.height, 120), 2e4);
      iframe.style.height = `${height}px`;
      return;
    }
    if (data.type === "ready") {
      options.onReady?.();
      return;
    }
    if (data.type === "error") {
      options.onError?.(new Error(data.message ?? "Gurb embed failed"));
    }
  };
  window.addEventListener("message", onMessage);
  container.appendChild(iframe);
  const applyToken = (token) => {
    assertNotASecret(token);
    iframe.src = `${baseUrl.replace(/\/+$/, "")}/embed/${encodeURIComponent(slug)}/${section}#t=${encodeURIComponent(token)}`;
  };
  if (options.token !== void 0) {
    applyToken(options.token);
  } else if (options.fetchToken) {
    options.fetchToken().then(applyToken, (cause) => {
      options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    });
  } else {
    window.removeEventListener("message", onMessage);
    iframe.remove();
    throw new Error("Gurb embed: pass either { token } or { fetchToken }");
  }
  return {
    iframe,
    destroy() {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    }
  };
}
export {
  mount
};
