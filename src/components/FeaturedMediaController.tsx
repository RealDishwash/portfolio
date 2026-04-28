import { useEffect } from 'preact/hooks';

type FeaturedMediaPayload = {
  title: string;
  subtitle: string;
  imageUrl?: string;
  tmdbUrl?: string;
};

type MediaViewState = {
  mediaState: 'loading' | 'error' | 'selected';
  stateLabel: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  tmdbUrl: string;
};

const DEFAULT_TMDB_URL = 'https://www.themoviedb.org/';
const ENDPOINT = '/api/featured-media';
const PLACEHOLDER_ART = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#1a1520'/><stop offset='1' stop-color='#0b111a'/></linearGradient></defs><rect width='64' height='64' fill='url(#g)'/><path d='M21 15h22a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H21a4 4 0 0 1-4-4V19a4 4 0 0 1 4-4Z' fill='none' stroke='#3b4558' stroke-width='2'/><path d='M27 25l13 7-13 7V25Z' fill='#3b4558'/></svg>"
)}`;

export default function FeaturedMediaController() {
  useEffect(() => {
    const tileNode = document.querySelector<HTMLElement>('#media-tile');
    const stateNode = document.querySelector<HTMLElement>('#media-state');
    const titleNode = document.querySelector<HTMLElement>('#media-title');
    const subtitleNode = document.querySelector<HTMLElement>('#media-subtitle');
    const metaNode = document.querySelector<HTMLElement>('#media-tile .spotify-meta');
    const artNode = document.querySelector<HTMLImageElement>('#media-art');
    const linkNodes = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-media-link]'));

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

    const applyView = (viewState: MediaViewState) => {
      tileNode.dataset.mediaState = viewState.mediaState;
      stateNode.textContent = viewState.stateLabel;
      titleNode.textContent = viewState.title;
      subtitleNode.textContent = viewState.subtitle;
      artNode.src = viewState.imageUrl;
      applyLink(viewState.tmdbUrl);
    };

    let lastViewState: MediaViewState | null = null;
    let swapTimeoutId: number | undefined;
    let motionResetTimeoutId: number | undefined;

    const setViewState = (nextViewState: MediaViewState) => {
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
        mediaState: 'loading',
        stateLabel: 'Loading',
        title: 'Checking TMDB...',
        subtitle: 'Fetching the selected title.',
        imageUrl: PLACEHOLDER_ART,
        tmdbUrl: DEFAULT_TMDB_URL,
      });
    };

    const setError = () => {
      setViewState({
        mediaState: 'error',
        stateLabel: 'Unavailable',
        title: 'TMDB unavailable',
        subtitle: 'Unable to load the selected title right now.',
        imageUrl: PLACEHOLDER_ART,
        tmdbUrl: DEFAULT_TMDB_URL,
      });
    };

    const setFeaturedMedia = (payload: FeaturedMediaPayload) => {
      setViewState({
        mediaState: 'selected',
        stateLabel: 'Selected',
        title: payload.title || 'Unknown title',
        subtitle: payload.subtitle || 'Movie or TV show',
        imageUrl: payload.imageUrl || PLACEHOLDER_ART,
        tmdbUrl: payload.tmdbUrl || DEFAULT_TMDB_URL,
      });
    };

    let destroyed = false;

    const loadFeaturedMedia = async () => {
      try {
        const response = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('featured media request failed');
        const payload = (await response.json()) as FeaturedMediaPayload;
        if (!payload || !payload.title || !payload.subtitle) throw new Error('invalid payload');
        if (!destroyed) setFeaturedMedia(payload);
      } catch {
        if (!destroyed) setError();
      }
    };

    setLoading();
    void loadFeaturedMedia();

    return () => {
      destroyed = true;
      window.clearTimeout(swapTimeoutId);
      window.clearTimeout(motionResetTimeoutId);
    };
  }, []);

  return null;
}
