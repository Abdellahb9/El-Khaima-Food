(() => {
    const video = document.getElementById('hero-video');
    const fallback = document.getElementById('hero-video-fallback');
    if (!video || !fallback) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = true;
    let failed = false;

    function showFallback() {
        failed = true;
        video.pause();
        video.classList.add('hidden');
        fallback.classList.remove('hidden');
    }

    // The <video> element itself doesn't fire 'error' when <source> children fail;
    // the last <source> erroring means every candidate was rejected.
    const sources = video.querySelectorAll('source');
    if (sources.length) sources[sources.length - 1].addEventListener('error', showFallback);
    video.addEventListener('error', showFallback);

    video.addEventListener('loadeddata', () => video.classList.remove('opacity-0'));

    // Reduced motion: hold on the finished, stacked burger instead of the empty opening frame.
    video.addEventListener('loadedmetadata', () => {
        if (reducedMotion.matches && Number.isFinite(video.duration)) video.currentTime = Math.max(video.duration - 0.1, 0);
    });

    function sync() {
        if (failed) return;
        if (inView && !document.hidden && !reducedMotion.matches) {
            video.play().catch(() => {});
        } else {
            video.pause();
        }
    }

    new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        sync();
    }, { threshold: 0.1 }).observe(video);
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    sync();
})();
