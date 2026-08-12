import { EmbedSection } from '@gurb/api-types';
export { EmbedSection } from '@gurb/api-types';

/**
 * @gurb/embed — mounts a Gurb community section inside your page.
 *
 * This package is the browser half of the SDK and it is deliberately incapable
 * of holding a secret: the only credential it accepts is a short-lived embed
 * token minted by YOUR backend via `@gurb/server`. There is no `apiKey` option
 * to fill in by mistake.
 */

interface MountOptions {
    /** Where to put the iframe. A CSS selector or the element itself. */
    target: string | HTMLElement;
    /** Your community's slug on Gurb. */
    slug: string;
    /** Which single section to render. One section per frame by design. */
    section: EmbedSection;
    /**
     * A token from your backend, or a callback that fetches one.
     *
     * Prefer the callback: tokens live ~120 seconds and are single-use, so a
     * token baked into server-rendered HTML is often already dead by the time a
     * user gets to it. The callback lets the frame ask for a fresh one.
     */
    token?: string;
    fetchToken?: () => Promise<string>;
    /** Gurb origin. Override only for staging. */
    baseUrl?: string;
    /** Initial height before the frame reports its own. Default 600. */
    initialHeight?: number;
    /** Let the frame drive its own height. Default true. */
    autoResize?: boolean;
    onReady?: () => void;
    onError?: (error: Error) => void;
}
interface EmbedHandle {
    /** The created iframe, for styling. Do not read its contentWindow — cross-origin. */
    readonly iframe: HTMLIFrameElement;
    /** Remove the frame and stop listening. Always call this on unmount. */
    destroy(): void;
}
declare function mount(options: MountOptions): EmbedHandle;

export { type EmbedHandle, type MountOptions, mount };
