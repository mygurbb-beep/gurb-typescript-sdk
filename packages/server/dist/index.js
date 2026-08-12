// src/errors.ts
var GurbApiError = class _GurbApiError extends Error {
  code;
  status;
  requestId;
  constructor(args) {
    super(args.message);
    this.name = "GurbApiError";
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
    Object.setPrototypeOf(this, _GurbApiError.prototype);
  }
  /** Retrying only ever helps for these. Anything else is a client-side bug. */
  get isRetryable() {
    return this.code === "NETWORK_ERROR" || this.code === "RATE_LIMITED" || this.status >= 500;
  }
};
var KNOWN_CODES = /* @__PURE__ */ new Set([
  "INVALID_API_KEY",
  "API_KEY_REVOKED",
  "FORBIDDEN_SURFACE",
  "INSUFFICIENT_SCOPE",
  "FEATURE_NOT_AVAILABLE",
  "NOT_FOUND",
  "RATE_LIMITED",
  "VALIDATION_ERROR"
]);
function toApiError(status, body) {
  const parsed = body ?? {};
  const declared = typeof parsed.error === "string" ? parsed.error : void 0;
  let code = "UNKNOWN";
  if (declared && KNOWN_CODES.has(declared)) {
    code = declared;
  } else if (status === 401) {
    code = "INVALID_API_KEY";
  } else if (status === 403) {
    code = "FORBIDDEN_SURFACE";
  } else if (status === 404) {
    code = "NOT_FOUND";
  } else if (status === 429) {
    code = "RATE_LIMITED";
  } else if (status === 400 || status === 422) {
    code = "VALIDATION_ERROR";
  }
  return new GurbApiError({
    message: parsed.message ?? declared ?? `Gurb API request failed with status ${status}`,
    code,
    status,
    requestId: parsed.requestId
  });
}

// src/key.ts
var KEY_PATTERN = /^gurb_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/;
function assertValidApiKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new GurbApiError({
      message: "A Gurb API key is required. Pass { apiKey } to createGurbClient().",
      code: "INVALID_API_KEY",
      status: 0
    });
  }
  if (!KEY_PATTERN.test(key)) {
    const looksLikeJwt = key.startsWith("eyJ");
    throw new GurbApiError({
      message: looksLikeJwt ? "That is a session JWT, not an API key. API keys look like gurb_<id>_<secret> and are minted from the community dashboard." : "Malformed Gurb API key. Expected the format gurb_<id>_<secret>.",
      code: "INVALID_API_KEY",
      status: 0
    });
  }
}
function assertServerEnvironment() {
  if (typeof window !== "undefined" || typeof document !== "undefined") {
    throw new GurbApiError({
      message: "@gurb/server must never run in a browser \u2014 it holds your secret API key. Use @gurb/embed on the client and mint embed sessions from your own backend.",
      code: "INVALID_API_KEY",
      status: 0
    });
  }
}

// src/client.ts
var DEFAULT_BASE_URL = "https://mygurb.com";
var DEFAULT_TIMEOUT_MS = 15e3;
var GurbClient = class {
  #apiKey;
  #baseUrl;
  #fetch;
  #timeoutMs;
  constructor(options) {
    assertServerEnvironment();
    assertValidApiKey(options.apiKey);
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof this.#fetch !== "function") {
      throw new GurbApiError({
        message: "No fetch implementation available. Node 20+ is required, or pass { fetch }.",
        code: "NETWORK_ERROR",
        status: 0
      });
    }
  }
  async #request(method, path, opts = {}) {
    const url = new URL(`${this.#baseUrl}/api/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== void 0) url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await this.#fetch(url.toString(), {
        method,
        headers: {
          // The key never goes in a query string: those land in access logs.
          "X-Api-Key": this.#apiKey,
          Accept: "application/json",
          ...opts.body === void 0 ? {} : { "Content-Type": "application/json" }
        },
        ...opts.body === void 0 ? {} : { body: JSON.stringify(opts.body) },
        signal: controller.signal
      });
    } catch (cause) {
      throw new GurbApiError({
        message: cause instanceof Error && cause.name === "AbortError" ? `Request to ${path} timed out after ${this.#timeoutMs}ms` : `Network request to ${path} failed`,
        code: "NETWORK_ERROR",
        status: 0
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new GurbApiError({
        message: `Gurb API returned a non-JSON response (status ${response.status})`,
        code: response.ok ? "UNKNOWN" : "NETWORK_ERROR",
        status: response.status
      });
    }
    if (!response.ok) throw toApiError(response.status, parsed);
    const envelope = parsed;
    return envelope.data !== void 0 ? envelope.data : parsed;
  }
  // ─── Community ─────────────────────────────────────────────────────────────
  /** The community this key is pinned to. A key can never read another one. */
  community = {
    get: () => this.#request("GET", "sdk/community")
  };
  // ─── Content ───────────────────────────────────────────────────────────────
  tweets = {
    list: (params = {}) => this.#request("GET", "sdk/tweets", { query: { ...params } })
  };
  events = {
    list: (params = {}) => this.#request("GET", "sdk/events", {
      query: {
        page: params.page,
        limit: params.limit,
        upcoming: params.upcoming === void 0 ? void 0 : String(params.upcoming)
      }
    })
  };
  blogs = {
    list: (params = {}) => this.#request("GET", "sdk/blogs", { query: { ...params } })
  };
  albums = {
    list: (params = {}) => this.#request("GET", "sdk/albums", { query: { ...params } })
  };
  members = {
    list: (params = {}) => this.#request("GET", "sdk/members", { query: { ...params } })
  };
  // ─── Embed ─────────────────────────────────────────────────────────────────
  embed = {
    /**
     * Mint a short-lived, single-use token for one of your logged-in users.
     *
     * Call this from your backend, per page load, and hand the token to the
     * browser. Do not cache it: it is valid for ~120 seconds and dies on first
     * use, which is exactly what makes it safe to put in a URL fragment.
     */
    createSession: (input) => this.#request("POST", "embed/sessions", { body: input }),
    /**
     * Build the iframe URL for a minted token.
     *
     * The token goes in the fragment, never the query string. Fragments are not
     * sent to the server, so the token stays out of nginx logs, `Referer`
     * headers, and any analytics the host page runs.
     */
    buildUrl: (args) => {
      const { slug, section, token } = args;
      return `${this.#baseUrl}/embed/${encodeURIComponent(slug)}/${section}#t=${encodeURIComponent(token)}`;
    }
  };
};
function createGurbClient(options) {
  return new GurbClient(options);
}

// src/index.ts
export * from "@gurb/api-types";
export {
  GurbApiError,
  GurbClient,
  createGurbClient
};
