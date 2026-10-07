(() => {
    // ─── Tweakables ──────────────────────────────────────────────────────────
    const CONFIG = {
        // 'hold'      → play once, freeze on the stacked burger, live steam/spark overlay continues
        // 'crossfade' → loop, dissolving the end of the clip into its start
        // 'loop'      → plain native loop
        loopMode: 'hold',
        holdAt: null,               // seconds to freeze at in 'hold' mode; null = last frame
        crossfadeSeconds: 0.8,

        blendMode: 'screen',        // 'screen' | 'lighten' — makes the black background disappear

        // All "frame" coordinates are fractions of the video frame (0–1).
        focus: { x: 0.497, y: 0.6 },    // burger centre in the frame
        // Elliptical fade, in frame coords; must reach transparent before the clip's hard bottom/side edges.
        mask: { center: { x: 0.497, y: 0.51 }, radiusX: 0.28, radiusY: 0.43, solid: 0.82 },
        glow: { color: 'rgba(255, 163, 72, 0.22)', size: '40%', blur: 40 },

        // How big the frame is drawn (width as a multiple of the hero media box) and where
        // in that box the burger centre lands (fractions of the box).
        layout: {
            desktop: { width: 1.05, anchor: { x: 0.68, y: 0.34 } },
            mobile: { width: 1.6, anchor: { x: 0.5, y: 0.55 } },
        },

        mobileQuery: '(max-width: 767px)',
        sources: {
            desktop: {
                webm: 'public/videos/burger.min.webm',
                mp4: 'public/videos/burger.min.mp4',
                poster: 'public/videos/burger-poster.jpg',
            },
            mobile: null,           // { webm, mp4, poster } when burger-mobile.mp4 is provided
        },

        particles: {
            origin: { x: 0.497, y: 0.27 }, // where steam/sparks start, in frame coords (top of the bun)
            spread: 0.12,                  // horizontal spawn width, as a fraction of the rendered frame height
            steam: { count: 12, opacity: 0.08, riseSpeed: 0.11, life: [3, 4.5] },
            sparks: { count: 12, color: [255, 179, 71], size: [0.003, 0.007], riseSpeed: [0.12, 0.26], life: [1.8, 3.4] },
        },
    };
    // ─────────────────────────────────────────────────────────────────────────

    const media = document.getElementById('hero-media');
    const video = document.getElementById('hero-video');
    const canvas = document.getElementById('hero-particles');
    const fallback = document.getElementById('hero-video-fallback');
    if (!media || !video || !fallback) return;

    const mobileMq = window.matchMedia(CONFIG.mobileQuery);
    const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');

    const state = {
        posterOnly: false,
        failed: false,
        loaded: false,
        inView: false,
        finished: false,
        crossfading: false,
        set: null,
        active: video,
        standby: null,
    };

    const pct = (v) => `${v * 100}%`;
    media.style.setProperty('--hero-blend', CONFIG.blendMode);
    media.style.setProperty('--mask-x', pct(CONFIG.mask.center.x));
    media.style.setProperty('--mask-y', pct(CONFIG.mask.center.y));
    media.style.setProperty('--mask-rx', pct(CONFIG.mask.radiusX));
    media.style.setProperty('--mask-ry', pct(CONFIG.mask.radiusY));
    media.style.setProperty('--mask-inner', pct(CONFIG.mask.solid));
    media.style.setProperty('--glow-color', CONFIG.glow.color);
    media.style.setProperty('--glow-size', CONFIG.glow.size);
    media.style.setProperty('--glow-blur', `${CONFIG.glow.blur}px`);

    // Rendered frame rect inside #hero-media, shared with the particle overlay.
    const frameRect = { ox: 0, oy: 0, rw: 0, rh: 0 };
    let frameAspect = 16 / 9;

    function layout() {
        const L = mobileMq.matches ? CONFIG.layout.mobile : CONFIG.layout.desktop;
        const W = media.clientWidth;
        const H = media.clientHeight;
        const el = state.active;
        if (el.videoWidth && el.videoHeight) frameAspect = el.videoWidth / el.videoHeight;
        const rw = W * L.width;
        const rh = rw / frameAspect;
        Object.assign(frameRect, { ox: L.anchor.x * W - CONFIG.focus.x * rw, oy: L.anchor.y * H - CONFIG.focus.y * rh, rw, rh });
        for (const v of media.querySelectorAll('video')) {
            Object.assign(v.style, { left: `${frameRect.ox}px`, top: `${frameRect.oy}px`, width: `${rw}px`, height: `${rh}px` });
        }
        media.style.setProperty('--glow-x', pct(L.anchor.x));
        media.style.setProperty('--glow-y', pct(L.anchor.y));
    }
    new ResizeObserver(layout).observe(media);
    mobileMq.addEventListener('change', layout);

    function currentSet() {
        return mobileMq.matches && CONFIG.sources.mobile ? CONFIG.sources.mobile : CONFIG.sources.desktop;
    }

    function isSlowConnection() {
        const c = navigator.connection;
        return !!c && (c.saveData === true || /(^|-)2g$/.test(c.effectiveType || ''));
    }

    function showFallback() {
        state.failed = true;
        particles.stop();
        for (const v of [state.active, state.standby]) {
            if (!v) continue;
            v.pause();
            v.classList.add('hidden');
        }
        canvas.classList.add('hidden');
        fallback.classList.remove('hidden');
    }

    // ─── Poster-only (reduced motion / data saver) ───────────────────────────
    function showPoster() {
        state.posterOnly = true;
        const { poster } = currentSet();
        const probe = new Image();
        probe.onload = () => {
            frameAspect = probe.naturalWidth / probe.naturalHeight;
            layout();
            video.poster = poster;
            video.style.opacity = '1';
        };
        probe.onerror = showFallback;
        probe.src = poster;
    }

    // ─── Video loading ───────────────────────────────────────────────────────
    function attachSources(el, set) {
        el.replaceChildren();
        for (const [type, src] of [['video/webm', set.webm], ['video/mp4', set.mp4]]) {
            if (!src) continue;
            const s = document.createElement('source');
            s.src = src;
            s.type = type;
            el.appendChild(s);
        }
        // <video> doesn't fire 'error' for failed <source>s; the last one erroring means all were rejected.
        el.lastElementChild?.addEventListener('error', showFallback);
        el.addEventListener('loadedmetadata', layout, { once: true });
        el.load();
    }

    function prepareVideo(el) {
        el.muted = true;
        el.defaultMuted = true;
        el.playsInline = true;
        el.autoplay = true;
        el.preload = 'auto';
        el.loop = CONFIG.loopMode === 'loop';
        // The poster is the final frame; showing it before playback would flash the finished burger.
        el.removeAttribute('poster');
        el.style.opacity = '0';
        el.style.transition = 'opacity .7s ease';
    }

    function loadVideo() {
        if (state.loaded || state.posterOnly || state.failed) return;
        state.loaded = true;
        state.set = currentSet();
        prepareVideo(video);
        video.addEventListener('playing', () => { if (state.active === video && !state.crossfading) video.style.opacity = '1'; }, { once: true });
        video.addEventListener('error', showFallback);
        attachSources(video, state.set);

        if (CONFIG.loopMode === 'hold') setupHold(video);
        if (CONFIG.loopMode === 'crossfade') setupCrossfade();
        sync();
    }

    // ─── Hold: play once, freeze, keep it alive with particles ───────────────
    function finish() {
        if (state.finished) return;
        state.finished = true;
        state.active.pause();
        sync();
    }

    function setupHold(el) {
        if (CONFIG.holdAt == null) {
            el.addEventListener('ended', finish);
            return;
        }
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
            const check = (_now, meta) => {
                if (meta.mediaTime >= CONFIG.holdAt) finish();
                else if (!state.finished) el.requestVideoFrameCallback(check);
            };
            el.requestVideoFrameCallback(check);
        } else {
            el.addEventListener('timeupdate', () => { if (el.currentTime >= CONFIG.holdAt) finish(); });
        }
        el.addEventListener('ended', finish);
    }

    // ─── Crossfade loop: two stacked videos trading places ───────────────────
    function setupCrossfade() {
        const b = video.cloneNode(false);
        b.removeAttribute('id');
        b.removeAttribute('aria-label');
        b.setAttribute('aria-hidden', 'true');
        prepareVideo(b);
        b.autoplay = false;
        video.after(b);
        attachSources(b, state.set);
        state.standby = b;

        const fade = `opacity ${CONFIG.crossfadeSeconds}s linear`;
        const watch = (el) => {
            const tick = () => {
                if (state.active !== el || state.crossfading) return;
                if (el.duration && el.duration - el.currentTime <= CONFIG.crossfadeSeconds) startCrossfade();
            };
            el.addEventListener('timeupdate', tick);
            el.addEventListener('ended', () => { if (state.active === el) startCrossfade(); });
        };

        function startCrossfade() {
            const from = state.active;
            const to = state.standby;
            state.crossfading = true;
            to.currentTime = 0;
            to.play().catch(() => {});
            from.style.transition = fade;
            to.style.transition = fade;
            to.style.opacity = '1';
            from.style.opacity = '0';
            setTimeout(() => {
                from.pause();
                from.currentTime = 0;
                state.active = to;
                state.standby = from;
                state.crossfading = false;
            }, CONFIG.crossfadeSeconds * 1000);
        }

        watch(video);
        watch(b);
    }

    // ─── Breakpoint change: swap to the matching clip ────────────────────────
    mobileMq.addEventListener('change', () => {
        if (!CONFIG.sources.mobile || state.failed) return;
        if (state.posterOnly) { showPoster(); return; }
        if (!state.loaded) return;
        const next = currentSet();
        if (next === state.set) return;
        state.set = next;
        const t = state.active.currentTime;
        for (const el of [state.active, state.standby]) {
            if (!el) continue;
            attachSources(el, next);
            el.addEventListener('loadedmetadata', () => {
                if (el !== state.active) return;
                el.currentTime = state.finished ? (CONFIG.holdAt ?? el.duration - 0.05) : Math.min(t, el.duration);
                sync();
            }, { once: true });
        }
    });

    // ─── Steam + spark overlay ───────────────────────────────────────────────
    const particles = (() => {
        if (!canvas) return { start() {}, stop() {}, running: false };
        const ctx = canvas.getContext('2d');
        const P = CONFIG.particles;
        let W = 0, H = 0, dpr = 1;
        let raf = null;
        let last = 0;
        const steam = [];
        const sparks = [];

        function sprite(size, stops) {
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const g = c.getContext('2d');
            const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
            for (const [at, color] of stops) grad.addColorStop(at, color);
            g.fillStyle = grad;
            g.fillRect(0, 0, size, size);
            return c;
        }
        const [sr, sg, sb] = P.sparks.color;
        const steamSprite = sprite(128, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
        const sparkSprite = sprite(64, [[0, 'rgba(255,250,235,1)'], [0.15, `rgba(${sr},${sg},${sb},1)`], [0.45, `rgba(${sr},${sg},${sb},0.25)`], [1, `rgba(${sr},${sg},${sb},0)`]]);

        const rand = (a, b) => a + Math.random() * (b - a);

        function resize() {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            W = media.clientWidth;
            H = media.clientHeight;
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
        }

        const frame = () => frameRect;

        function spawnSteam(p, f, initial) {
            const u = f.rh;
            p.life = rand(...P.steam.life);
            p.age = initial ? Math.random() * p.life : 0;
            p.x0 = f.ox + P.origin.x * f.rw + rand(-1, 1) * P.spread * u;
            p.drift = rand(-0.04, 0.04) * u;
            p.phase = Math.random() * Math.PI * 2;
            p.size = rand(0.05, 0.08) * u;
            return p;
        }

        function spawnSpark(p, f, initial) {
            const u = f.rh;
            p.life = rand(...P.sparks.life);
            p.age = initial ? Math.random() * p.life : 0;
            p.x0 = f.ox + P.origin.x * f.rw + rand(-1.3, 1.3) * P.spread * u;
            p.speed = rand(...P.sparks.riseSpeed) * u;
            p.sway = rand(0.006, 0.02) * u;
            p.freq = rand(1.5, 4);
            p.flicker = rand(6, 14);
            p.phase = Math.random() * Math.PI * 2;
            p.size = Math.max(rand(...P.sparks.size) * u, 1.2);
            return p;
        }

        function seed() {
            const f = frame();
            steam.length = 0;
            sparks.length = 0;
            for (let i = 0; i < P.steam.count; i++) steam.push(spawnSteam({}, f, true));
            for (let i = 0; i < P.sparks.count; i++) sparks.push(spawnSpark({}, f, true));
        }

        function draw(now) {
            raf = requestAnimationFrame(draw);
            const dt = Math.min((now - last) / 1000, 0.1);
            last = now;
            const f = frame();
            const u = f.rh;
            const originY = f.oy + P.origin.y * f.rh;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);
            ctx.globalCompositeOperation = 'lighter';

            for (const p of steam) {
                p.age += dt;
                if (p.age >= p.life) spawnSteam(p, f, false);
                const t = p.age / p.life;
                const size = p.size * (1 + t * 2.4);
                const x = p.x0 + p.drift * t + Math.sin(p.phase + p.age * 0.9) * 0.025 * u;
                const y = originY - P.steam.riseSpeed * u * p.age;
                ctx.globalAlpha = P.steam.opacity * Math.sin(Math.PI * t);
                ctx.drawImage(steamSprite, x - size / 2, y - size * 0.7, size, size * 1.4);
            }

            for (const p of sparks) {
                p.age += dt;
                if (p.age >= p.life) spawnSpark(p, f, false);
                const t = p.age / p.life;
                const x = p.x0 + Math.sin(p.phase + p.age * p.freq) * p.sway;
                const y = originY - p.speed * p.age;
                const flicker = 0.65 + 0.35 * Math.sin(p.phase + p.age * p.flicker);
                ctx.globalAlpha = Math.min(1, t * 6) * (1 - t) * flicker;
                const d = p.size * 4;
                ctx.drawImage(sparkSprite, x - d / 2, y - d / 2, d, d);
            }
            ctx.globalAlpha = 1;
        }

        new ResizeObserver(() => { resize(); if (raf) seed(); }).observe(media);
        resize();

        return {
            get running() { return !!raf; },
            start() {
                if (raf || reducedMq.matches) return;
                if (!steam.length) seed();
                last = performance.now();
                raf = requestAnimationFrame(draw);
                canvas.style.opacity = '1';
            },
            stop() {
                if (!raf) return;
                cancelAnimationFrame(raf);
                raf = null;
            },
        };
    })();

    // ─── Visibility-driven playback ──────────────────────────────────────────
    function sync() {
        if (state.posterOnly || state.failed || !state.loaded) return;
        const visible = state.inView && !document.hidden;
        if (!visible) {
            state.active.pause();
            state.standby?.pause();
            particles.stop();
            return;
        }
        if (state.finished) {
            if (CONFIG.loopMode !== 'crossfade') particles.start();
            return;
        }
        state.active.play().catch((err) => { if (err.name === 'NotAllowedError') showFinalFrame(); });
        if (state.crossfading) state.standby.play().catch(() => {});
    }

    // Autoplay refused (e.g. iOS Low Power Mode): the poster was already dropped and the video is
    // transparent, so jump to the stacked burger and show it rather than leaving the hero empty.
    function showFinalFrame() {
        const el = state.active;
        const show = () => {
            el.currentTime = CONFIG.holdAt ?? Math.max(el.duration - 0.05, 0);
            el.style.opacity = '1';
            state.finished = true;
            sync();
        };
        if (el.readyState >= 1) show();
        else el.addEventListener('loadedmetadata', show, { once: true });
    }

    if (reducedMq.matches || isSlowConnection()) {
        showPoster();
    } else {
        new IntersectionObserver(([e]) => { if (e.isIntersecting) loadVideo(); }, { rootMargin: '200px 0px' }).observe(media);
        new IntersectionObserver(([e]) => { state.inView = e.isIntersecting; sync(); }, { threshold: 0.15 }).observe(media);
        document.addEventListener('visibilitychange', sync);
    }

    reducedMq.addEventListener('change', () => {
        if (!reducedMq.matches || state.posterOnly) return;
        particles.stop();
        canvas.style.opacity = '0';
        for (const v of [state.active, state.standby]) v?.pause();
        state.loaded = false;
        state.active.replaceChildren();
        state.active.load();
        state.standby?.remove();
        showPoster();
    });

    window.__heroVideo = {
        CONFIG,
        particles,
        get state() {
            return {
                mode: CONFIG.loopMode,
                posterOnly: state.posterOnly,
                failed: state.failed,
                loaded: state.loaded,
                finished: state.finished,
                playing: !state.active.paused,
                particlesRunning: particles.running,
                sources: state.set,
            };
        },
    };
})();
