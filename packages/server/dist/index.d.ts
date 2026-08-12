import { Community, PaginationParams, Paginated, Tweet, Event, Blog, Album, Member, CreateEmbedSessionInput, EmbedSession, EmbedSection, GurbErrorCode } from '@gurb/api-types';
export * from '@gurb/api-types';

interface GurbClientOptions {
    apiKey: string;
    /**
     * Origin only — no `/api` suffix. The client appends `api/` itself, matching
     * how the web app's own `apiUrl()` helper behaves. Passing `/api/v1` here
     * produces requests to routes that do not exist, and because unmatched
     * `/api/*` paths fall through to root-mounted routers they answer 400/401
     * rather than 404 — which sends you to debug auth instead of the URL.
     */
    baseUrl?: string;
    /** Injected for tests. Defaults to the platform `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Per-request timeout in ms. Default 15s. */
    timeoutMs?: number;
}
declare class GurbClient {
    #private;
    constructor(options: GurbClientOptions);
    /** The community this key is pinned to. A key can never read another one. */
    community: {
        get: () => Promise<Community>;
    };
    tweets: {
        list: (params?: PaginationParams) => Promise<Paginated<Tweet>>;
    };
    events: {
        list: (params?: PaginationParams & {
            upcoming?: boolean;
        }) => Promise<Paginated<Event>>;
    };
    blogs: {
        list: (params?: PaginationParams) => Promise<Paginated<Blog>>;
    };
    albums: {
        list: (params?: PaginationParams) => Promise<Paginated<Album>>;
    };
    members: {
        list: (params?: PaginationParams) => Promise<Paginated<Member>>;
    };
    embed: {
        /**
         * Mint a short-lived, single-use token for one of your logged-in users.
         *
         * Call this from your backend, per page load, and hand the token to the
         * browser. Do not cache it: it is valid for ~120 seconds and dies on first
         * use, which is exactly what makes it safe to put in a URL fragment.
         */
        createSession: (input: CreateEmbedSessionInput) => Promise<EmbedSession>;
        /**
         * Build the iframe URL for a minted token.
         *
         * The token goes in the fragment, never the query string. Fragments are not
         * sent to the server, so the token stays out of nginx logs, `Referer`
         * headers, and any analytics the host page runs.
         */
        buildUrl: (args: {
            slug: string;
            section: EmbedSection;
            token: string;
        }) => string;
    };
}
declare function createGurbClient(options: GurbClientOptions): GurbClient;

/**
 * The only error this SDK throws.
 *
 * One class, not a hierarchy: a consumer writing `catch (e)` should need one
 * `instanceof` check and then branch on `code`. Transport failures are mapped
 * into it too (`NETWORK_ERROR`) so that "the request failed" and "the server
 * said no" are not two different shapes to handle.
 */
declare class GurbApiError extends Error {
    readonly code: GurbErrorCode;
    readonly status: number;
    readonly requestId: string | undefined;
    constructor(args: {
        message: string;
        code: GurbErrorCode;
        status: number;
        requestId?: string | undefined;
    });
    /** Retrying only ever helps for these. Anything else is a client-side bug. */
    get isRetryable(): boolean;
}

export { GurbApiError, GurbClient, type GurbClientOptions, createGurbClient };
