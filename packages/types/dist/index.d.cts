/**
 * Shared types for the Gurb API surface exposed to SDK consumers.
 *
 * HAND-WRITTEN ON PURPOSE (v1). The backend's swagger-jsdoc spec covers admin
 * routes and is not served in production, so it is documentation rather than a
 * contract. When the backend emits a curated `openapi.public.json` artifact and
 * gates it in CI, this file is replaced wholesale by `openapi-typescript`
 * output. Keep it structural — no classes, no helpers — so that swap is a
 * deletion, not a migration.
 */
/** A community-scoped API key. Always `gurb_<keyId>_<secret>`. */
type GurbApiKey = string;
/**
 * The sections a host site may embed. One section per iframe by design: a
 * chrome-less pane composes into the host's layout, where a full app does not.
 */
declare const EMBED_SECTIONS: readonly ["tweets", "events", "blogs", "albums"];
type EmbedSection = (typeof EMBED_SECTIONS)[number];
interface Paginated<T> {
    items: T[];
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
}
interface PaginationParams {
    page?: number;
    limit?: number;
}
interface Community {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    logoUrl: string | null;
    bannerUrl: string | null;
    /** Visibility is `type` alone. There is no `isPublic` field; derive it if you need a boolean. */
    type: 'PUBLIC' | 'PRIVATE';
    memberCount: number;
    createdAt: string;
}
interface Author {
    /**
     * The platform-level user id.
     *
     * Note for anyone porting this to another language: several backend tables
     * store a `CommunityMember.id` in a column named `authorId`. This field is
     * always the `User.id` — the API normalises it before it crosses the wire.
     */
    userId: string;
    displayName: string;
    avatarUrl: string | null;
}
interface Tweet {
    id: string;
    content: string;
    author: Author;
    imageUrls: string[];
    likeCount: number;
    commentCount: number;
    createdAt: string;
    editedAt: string | null;
}
interface Event {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    coverUrl: string | null;
    startsAt: string;
    endsAt: string | null;
    attendeeCount: number;
}
interface Blog {
    id: string;
    title: string;
    excerpt: string | null;
    coverUrl: string | null;
    author: Author;
    publishedAt: string | null;
    createdAt: string;
}
interface Album {
    id: string;
    title: string;
    description: string | null;
    coverUrl: string | null;
    photoCount: number;
    createdAt: string;
}
interface Member {
    userId: string;
    memberId: string;
    displayName: string;
    avatarUrl: string | null;
    role: 'ADMIN' | 'MODERATOR' | 'MEMBER';
    joinedAt: string;
}
/**
 * What the host's backend sends to mint an embed session.
 *
 * There is deliberately no `role` field. The host cannot elevate a user; every
 * embedded identity lands as a plain MEMBER. Adding a role field here would
 * make a leaked key a way to manufacture moderators.
 */
interface CreateEmbedSessionInput {
    /**
     * The host's own id for this user. Opaque to Gurb, stable forever: it is the
     * join key, so reusing one for a different human hands them that account.
     */
    externalUserId: string;
    displayName: string;
    email?: string;
    avatarUrl?: string;
}
interface EmbedSession {
    /**
     * Single-use, ~120s, `aud: "embed"`. Accepted by exactly one endpoint (the
     * exchange). Put it in a URL fragment, never a query string.
     */
    token: string;
    expiresAt: string;
    /** The Gurb user this external identity resolved to (created on first sight). */
    userId: string;
}
/**
 * Stable, machine-readable error codes. Backend messages are English by
 * project convention; consumers own their own translation.
 */
type GurbErrorCode = 'INVALID_API_KEY' | 'API_KEY_REVOKED' | 'FORBIDDEN_SURFACE' | 'INSUFFICIENT_SCOPE' | 'FEATURE_NOT_AVAILABLE' | 'NOT_FOUND' | 'RATE_LIMITED' | 'VALIDATION_ERROR' | 'NETWORK_ERROR' | 'UNKNOWN';
interface GurbErrorBody {
    success: false;
    error?: string;
    message?: string;
    requestId?: string;
}

export { type Album, type Author, type Blog, type Community, type CreateEmbedSessionInput, EMBED_SECTIONS, type EmbedSection, type EmbedSession, type Event, type GurbApiKey, type GurbErrorBody, type GurbErrorCode, type Member, type Paginated, type PaginationParams, type Tweet };
