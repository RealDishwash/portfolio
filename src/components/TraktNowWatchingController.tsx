import { useEffect } from 'preact/hooks';

type TraktNowWatchingPayload = {
  isWatching: boolean;
  title: string;
  subtitle: string;
  mediaType?: 'movie' | 'episode';
  imageUrl?: string;
  traktUrl?: string;
};

type TraktViewState = {
  traktState: 'loading' | 'error' | 'watching' | 'idle';
  stateLabel: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  traktUrl: string;
};

const DEFAULT_TRAKT_URL = 'https://trakt.tv/users/realdishwash';
const POLL_INTERVAL_MS = 60_000;
const ENDPOINT = '/api/trakt-now-watching';
const PLACEHOLDER_ART = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#1a1520'/><stop offset='1' stop-color='#0b111a'/></linearGradient></defs><rect width='64' height='64' fill='url(#g)'/><path d='M21 15h22a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H21a4 4 0 0 1-4-4V19a4 4 0 0 1 4-4Z' fill='none' stroke='#3b4558' stroke-width='2'/><path d='M27 25l13 7-13 7V25Z' fill='#3b4558'/></svg>"
)}`;

export default function TraktNowWatchingController() {
  useEffect(() => {
    const tileNode = document.querySelector<HTMLElement>('#trakt-tile');
    const stateNode = document.querySelector<HTMLElement>('#trakt-state');
    const titleNode = document.querySelector<HTMLElement>('#trakt-title');
    const subtitleNode = document.querySelector<HTMLElement>('#trakt-subtitle');
    const metaNode = document.querySelector<HTMLElement>('#trakt-tile .spotify-meta');
    const artNode = document.querySelector<HTMLImageElement>('#trakt-art');
    const linkNodes = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-trakt-link]'));

    if (!tileNode || !stateNode || !titleNode || !subtitleNode || !metaNode || !artNode || !linkNodes.length) {
      return;
    }

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const applyLink = (url: string) => {
      for (const node of linkNodes) {
        node.href = url;
      }
    };

    const clearMotionClasses = () => {
      artNode.classList.remove('is-swapping');
      metaNode.classList.remove('is-swapping');
    };

    const applyView = (viewState: TraktViewState) => {
      tileNode.dataset.traktState = viewState.traktState;
      stateNode.textContent = viewState.stateLabel;
      titleNode.textContent = viewState.title;
      subtitleNode.textContent = viewState.subtitle;
      artNode.src = viewState.imageUrl;
      applyLink(viewState.traktUrl);
    };

    let lastViewState: TraktViewState | null = null;
    let swapTimeoutId: number | undefined;
    let motionResetTimeoutId: number | undefined;

    const setViewState = (nextViewState: TraktViewState) => {
      const hasPrevious = Boolean(lastViewState);
      const stateChanged = lastViewState?.stateLabel !== nextViewState.stateLabel;
      const textChanged =
        lastViewState?.title !== nextViewState.title || lastViewState?.subtitle !== nextViewState.subtitle;
      const artChanged = lastViewState?.imageUrl !== nextViewState.imageUrl;
      const shouldAnimate = hasPrevious && !prefersReducedMotion && (stateChanged || textChanged || artChanged);

      window.clearTimeout(swapTimeoutId);
      window.clearTimeout(motionResetTimeoutId);
      stateNode.classList.remove('is-state-bump');
      clearMotionClasses();

      if (!shouldAnimate) {
        applyView(nextViewState);
        lastViewState = nextViewState;
        return;
      }

      if (stateChanged) stateNode.classList.add('is-state-bump');
      if (artChanged) artNode.classList.add('is-swapping');
      if (textChanged) metaNode.classList.add('is-swapping');

      swapTimeoutId = window.setTimeout(() => {
        applyView(nextViewState);
        motionResetTimeoutId = window.setTimeout(() => {
          stateNode.classList.remove('is-state-bump');
          clearMotionClasses();
        }, 130);
      }, 110);

      lastViewState = nextViewState;
    };

    const setLoading = () => {
      setViewState({
        traktState: 'loading',
        stateLabel: 'Loading',
        title: 'Checking Trakt...',
        subtitle: 'Fetching your watch status.',
        imageUrl: PLACEHOLDER_ART,
        traktUrl: DEFAULT_TRAKT_URL,
      });
    };

    const setError = () => {
      setViewState({
        traktState: 'error',
        stateLabel: 'Unavailable',
        title: 'Trakt unavailable',
        subtitle: 'Unable to load watch status right now.',
        imageUrl: PLACEHOLDER_ART,
        traktUrl: DEFAULT_TRAKT_URL,
      });
    };

    const setNowWatching = (payload: TraktNowWatchingPayload) => {
      setViewState({
        traktState: payload.isWatching ? 'watching' : 'idle',
        stateLabel: payload.isWatching ? 'Live' : 'Last watched',
        title: payload.title || 'Unknown title',
        subtitle: payload.subtitle || 'Unknown watch status',
        imageUrl: payload.imageUrl || PLACEHOLDER_ART,
        traktUrl: payload.traktUrl || DEFAULT_TRAKT_URL,
      });
    };

    let isRequestInFlight = false;
    let destroyed = false;

    const loadNowWatching = async () => {
      if (isRequestInFlight || destroyed) return;
      isRequestInFlight = true;

      try {
        const response = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('trakt request failed');
        const payload = (await response.json()) as TraktNowWatchingPayload;
        if (!payload || !payload.title || !payload.subtitle) throw new Error('invalid payload');
        setNowWatching(payload);
      } catch {
        setError();
      } finally {
        isRequestInFlight = false;
      }
    };

    setLoading();
    void loadNowWatching();
    const intervalId = window.setInterval(() => {
      void loadNowWatching();
    }, POLL_INTERVAL_MS);

    return () => {
      destroyed = true;
      window.clearInterval(intervalId);
      window.clearTimeout(swapTimeoutId);
      window.clearTimeout(motionResetTimeoutId);
    };
  }, []);

  return null;
}
