import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ─── Tweakables ──────────────────────────────────────────────────────────────
const CONFIG = {
    modelUrl: 'public/models/burger.glb',
    dracoDecoderPath: 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/',

    // Model fit: the model is recentered and uniformly scaled to this height (world units)
    targetSize: 2,
    position: { x: 0, y: 0, z: 0 },
    cameraFov: 30,
    cameraElevationDeg: 14,
    framingPadding: 1.3,

    // Animation
    rotationSecondsPerTurn: 12,
    floatAmplitude: 0.06,
    floatSpeed: 1.1,
    parallaxMaxDeg: 6,
    parallaxLerp: 0.06,
    hoverScale: 1.05,
    hoverLerp: 0.1,
    introDuration: 1.2,
    introRise: 0.25,

    // Rendering
    exposure: 1.0,
    envIntensity: 0.55,
    maxPixelRatio: 2,
    lights: {
        key: { color: '#ffd9a8', intensity: 2.6, position: [-3, 5, 3] },
        rim: { color: '#a8d8ff', intensity: 4.5, position: [1.5, 3, -4.5] },
        fill: { color: '#fff1e0', intensity: 0.45, position: [4, 1.5, 3] },
    },
    shadow: { opacity: 0.45, radius: 12, blurSamples: 16, mapSize: 1024 },

    // Post-processing (kept subtle)
    post: {
        enabled: true,
        bloomStrength: 0.22,
        bloomRadius: 0.35,
        bloomThreshold: 0.9,
        dofEnabled: true,
        dofMaxBlurPx: 2.5,
        dofFocusRadius: 0.32,
    },

    steam: { enabled: true, count: 10, opacity: 0.07, riseSpeed: 0.28, height: 1.1 },
};
// ─────────────────────────────────────────────────────────────────────────────

const wrapper = document.getElementById('hero-burger');
const canvas = document.getElementById('hero-burger-canvas');
const loaderEl = document.getElementById('hero-burger-loader');
const progressRing = document.getElementById('hero-burger-progress');
const fallbackImg = document.getElementById('hero-burger-fallback');

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function showFallback(reason) {
    console.warn('[heroBurger] falling back to static image:', reason);
    canvas.classList.add('hidden');
    loaderEl.classList.add('hidden');
    fallbackImg.classList.remove('hidden');
}

function hideLoader() {
    loaderEl.style.opacity = '0';
    setTimeout(() => loaderEl.classList.add('hidden'), 500);
}

function setProgress(fraction) {
    if (!progressRing) return;
    const circumference = 2 * Math.PI * 24;
    progressRing.style.strokeDasharray = `${circumference}`;
    progressRing.style.strokeDashoffset = `${circumference * (1 - fraction)}`;
}

function hasWebGL() {
    try {
        const probe = document.createElement('canvas');
        return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
    } catch {
        return false;
    }
}

// Depth-of-field approximation that keeps the premultiplied alpha intact
// (three's BokehPass forces alpha = 1, which would paint the transparent background black).
const FocusBlurShader = {
    uniforms: {
        tDiffuse: { value: null },
        focus: { value: new THREE.Vector2(0.5, 0.5) },
        focusRadius: { value: CONFIG.post.dofFocusRadius },
        maxBlur: { value: CONFIG.post.dofMaxBlurPx },
        texel: { value: new THREE.Vector2() },
        aspect: { value: 1 },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 focus;
        uniform float focusRadius;
        uniform float maxBlur;
        uniform vec2 texel;
        uniform float aspect;
        varying vec2 vUv;
        void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec2 d = vUv - focus;
            d.x *= aspect;
            float amount = smoothstep(focusRadius, focusRadius + 0.45, length(d)) * maxBlur;
            if (amount < 0.05) { gl_FragColor = base; return; }
            vec4 sum = base;
            for (int i = 0; i < 12; i++) {
                float a = float(i) * 0.5235988;
                vec2 dir = vec2(cos(a), sin(a)) * texel * amount;
                sum += texture2D(tDiffuse, vUv + dir);
                sum += texture2D(tDiffuse, vUv + dir * 0.5);
            }
            gl_FragColor = sum / 25.0;
        }`,
};

function makeSteamTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;

function init() {
    if (!hasWebGL()) return showFallback('WebGL unavailable');

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
        return showFallback(err);
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CONFIG.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = CONFIG.envIntensity;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(CONFIG.cameraFov, 1, 0.05, 100);

    // Lights
    const { key, rim, fill } = CONFIG.lights;
    const keyLight = new THREE.DirectionalLight(key.color, key.intensity);
    keyLight.position.set(...key.position);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(CONFIG.shadow.mapSize, CONFIG.shadow.mapSize);
    keyLight.shadow.radius = CONFIG.shadow.radius;
    keyLight.shadow.blurSamples = CONFIG.shadow.blurSamples;
    keyLight.shadow.bias = -0.0005;
    const rimLight = new THREE.DirectionalLight(rim.color, rim.intensity);
    rimLight.position.set(...rim.position);
    const fillLight = new THREE.DirectionalLight(fill.color, fill.intensity);
    fillLight.position.set(...fill.position);
    scene.add(keyLight, keyLight.target, rimLight, fillLight);

    // Hierarchy: stage (float, tilt, hover scale) > spin (Y rotation) > model
    const stage = new THREE.Group();
    const spin = new THREE.Group();
    stage.add(spin);
    stage.position.set(CONFIG.position.x, CONFIG.position.y, CONFIG.position.z);
    scene.add(stage);

    const shadowPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.ShadowMaterial({ opacity: CONFIG.shadow.opacity, transparent: true, depthWrite: false })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    // Post-processing
    let composer = null;
    let dofPass = null;
    let bloomPass = null;
    if (CONFIG.post.enabled) {
        const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
        composer = new EffectComposer(renderer, rt);
        composer.addPass(new RenderPass(scene, camera));
        dofPass = new ShaderPass(FocusBlurShader);
        composer.addPass(dofPass);
        bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), CONFIG.post.bloomStrength, CONFIG.post.bloomRadius, CONFIG.post.bloomThreshold);
        // Stock composite writes alpha = strength everywhere, which would fog the transparent background.
        bloomPass.compositeMaterial.fragmentShader = bloomPass.compositeMaterial.fragmentShader.replace(
            /\}\s*$/,
            'gl_FragColor.a = clamp(max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b), 0.0, 1.0);\n}'
        );
        bloomPass.compositeMaterial.needsUpdate = true;
        composer.addPass(bloomPass);
        composer.addPass(new OutputPass());
    }

    // Steam
    const steamSprites = [];
    let steamBaseY = 0;
    if (CONFIG.steam.enabled) {
        const tex = makeSteamTexture();
        for (let i = 0; i < CONFIG.steam.count; i++) {
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xffffff,
            }));
            sprite.userData = { phase: i / CONFIG.steam.count, xOffset: (Math.random() - 0.5) * 0.6, drift: (Math.random() - 0.5) * 0.3 };
            sprite.visible = false;
            steamSprites.push(sprite);
            scene.add(sprite);
        }
    }

    // State
    let model = null;
    let fadeMaterials = [];
    let modelHeight = CONFIG.targetSize;
    let modelFootprint = CONFIG.targetSize;
    let introStart = null;
    let introDone = false;
    const pointer = { x: 0, y: 0 };
    let hovering = false;
    let reducedMotion = reducedMotionQuery.matches;
    let inView = true;
    let pageVisible = !document.hidden;
    let rafId = null;
    const clock = new THREE.Clock(false);
    let elapsed = 0;
    const focusVec = new THREE.Vector3();
    const hoverBox = new THREE.Box3();
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    function frameCamera() {
        const w = wrapper.clientWidth || 1;
        const h = wrapper.clientHeight || 1;
        camera.aspect = w / h;
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const fitHeight = (modelHeight * CONFIG.framingPadding) / 2 / Math.tan(vFov / 2);
        const fitWidth = (modelFootprint * CONFIG.framingPadding) / 2 / Math.tan(hFov / 2);
        const dist = Math.max(fitHeight, fitWidth) + modelFootprint / 2;
        const elev = THREE.MathUtils.degToRad(CONFIG.cameraElevationDeg);
        const lookY = modelHeight * 0.45;
        camera.position.set(0, lookY + Math.sin(elev) * dist, Math.cos(elev) * dist);
        camera.lookAt(0, lookY, 0);
        camera.updateProjectionMatrix();
    }

    function resize() {
        const w = wrapper.clientWidth;
        const h = wrapper.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        if (composer) {
            composer.setPixelRatio(renderer.getPixelRatio());
            composer.setSize(w, h);
            const pr = renderer.getPixelRatio();
            dofPass.uniforms.texel.value.set(1 / (w * pr), 1 / (h * pr));
            dofPass.uniforms.aspect.value = w / h;
            dofPass.enabled = CONFIG.post.dofEnabled && window.innerWidth >= 768;
        }
        frameCamera();
        if (!rafId) renderOnce();
    }

    function render() {
        if (composer) {
            if (model && dofPass.enabled) {
                focusVec.set(0, modelHeight * 0.5, 0);
                stage.localToWorld(focusVec).project(camera);
                dofPass.uniforms.focus.value.set(focusVec.x * 0.5 + 0.5, focusVec.y * 0.5 + 0.5);
            }
            composer.render();
        } else {
            renderer.render(scene, camera);
        }
    }

    function renderOnce() {
        if (model) render();
    }

    function updateSteam(dt) {
        const top = steamBaseY;
        for (const s of steamSprites) {
            const u = s.userData;
            u.phase = (u.phase + dt * CONFIG.steam.riseSpeed / CONFIG.steam.height) % 1;
            const p = u.phase;
            s.position.set(u.xOffset + Math.sin(elapsed * 0.8 + u.xOffset * 10) * 0.08 + u.drift * p, top + p * CONFIG.steam.height, 0.1);
            const scale = 0.25 + p * 0.6;
            s.scale.set(scale, scale * 1.4, 1);
            s.material.opacity = CONFIG.steam.opacity * Math.sin(Math.PI * p) * (introDone ? 1 : 0);
            s.visible = true;
        }
    }

    function tick() {
        rafId = requestAnimationFrame(tick);
        advance(Math.min(clock.getDelta(), 0.1));
    }

    function advance(dt) {
        elapsed += dt;

        // Intro
        let introT = 1;
        if (!introDone) {
            if (introStart === null) introStart = elapsed;
            introT = Math.min((elapsed - introStart) / CONFIG.introDuration, 1);
            const e = easeOutCubic(introT);
            for (const { material, opacity } of fadeMaterials) material.opacity = opacity * e;
            if (introT >= 1) {
                introDone = true;
                for (const { material, opacity, transparent, depthWrite } of fadeMaterials) {
                    material.opacity = opacity;
                    material.transparent = transparent;
                    material.depthWrite = depthWrite;
                    material.needsUpdate = true;
                }
            }
        }
        const introOffset = (1 - easeOutCubic(introT)) * -CONFIG.introRise;

        spin.rotation.y += (Math.PI * 2 / CONFIG.rotationSecondsPerTurn) * dt;
        const float = Math.sin(elapsed * CONFIG.floatSpeed) * CONFIG.floatAmplitude;
        stage.position.y = CONFIG.position.y + float + introOffset;

        const maxTilt = THREE.MathUtils.degToRad(CONFIG.parallaxMaxDeg);
        stage.rotation.x = lerp(stage.rotation.x, -pointer.y * maxTilt, CONFIG.parallaxLerp);
        stage.rotation.z = lerp(stage.rotation.z, -pointer.x * maxTilt, CONFIG.parallaxLerp);

        const targetScale = hovering ? CONFIG.hoverScale : 1;
        stage.scale.setScalar(lerp(stage.scale.x, targetScale, CONFIG.hoverLerp));

        if (steamSprites.length) updateSteam(dt);
        render();
    }

    function updateLoop() {
        const shouldRun = model && inView && pageVisible && !reducedMotion;
        if (shouldRun && !rafId) {
            clock.start();
            clock.getDelta();
            tick();
        } else if (!shouldRun && rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
            clock.stop();
        }
    }

    function applyReducedMotion() {
        reducedMotion = reducedMotionQuery.matches;
        if (reducedMotion && model) {
            if (!introDone) {
                introDone = true;
                for (const { material, opacity, transparent, depthWrite } of fadeMaterials) {
                    material.opacity = opacity;
                    material.transparent = transparent;
                    material.depthWrite = depthWrite;
                    material.needsUpdate = true;
                }
            }
            stage.rotation.set(0, 0, 0);
            stage.scale.setScalar(1);
            stage.position.y = CONFIG.position.y;
            spin.rotation.y = -Math.PI / 6;
            for (const s of steamSprites) s.visible = false;
        }
        updateLoop();
        if (!rafId) renderOnce();
    }

    function onModelLoaded(gltf) {
        model = gltf.scene;

        const maxAniso = renderer.capabilities.getMaxAnisotropy();
        const textureSlots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
        const seen = new Set();
        model.traverse((obj) => {
            if (!obj.isMesh) return;
            obj.castShadow = true;
            obj.receiveShadow = true;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (seen.has(m)) continue;
                seen.add(m);
                for (const slot of textureSlots) {
                    if (m[slot]) {
                        m[slot].anisotropy = maxAniso;
                        m[slot].needsUpdate = true;
                    }
                }
                fadeMaterials.push({ material: m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite });
                m.transparent = true;
                m.opacity = 0;
            }
        });

        // Auto-center and auto-scale regardless of source units
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = CONFIG.targetSize / Math.max(size.y, size.x * 0.75, size.z * 0.75, 1e-6);
        model.scale.setScalar(scale);
        box.setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.set(-center.x, -box.min.y, -center.z);
        box.setFromObject(model);
        modelHeight = box.max.y - box.min.y;
        const footprint = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        modelFootprint = footprint;
        spin.add(model);

        shadowPlane.scale.setScalar(footprint * 4);
        const sc = keyLight.shadow.camera;
        const r = footprint * 1.2;
        sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
        sc.near = 0.1; sc.far = 30;
        sc.updateProjectionMatrix();

        steamBaseY = modelHeight * 0.92;

        hideLoader();
        resize();
        applyReducedMotion();
        if (reducedMotion) renderOnce();
    }

    // Input
    window.addEventListener('pointermove', (e) => {
        pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
        if (!model) return;
        const rect = canvas.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (!inside) { hovering = false; return; }
        ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        hoverBox.setFromObject(model);
        hovering = raycaster.ray.intersectsBox(hoverBox);
    }, { passive: true });
    document.addEventListener('pointerleave', () => { hovering = false; });

    new ResizeObserver(resize).observe(wrapper);
    new IntersectionObserver((entries) => {
        inView = entries[0].isIntersecting;
        updateLoop();
    }, { threshold: 0.01 }).observe(wrapper);
    document.addEventListener('visibilitychange', () => {
        pageVisible = !document.hidden;
        updateLoop();
    });
    reducedMotionQuery.addEventListener('change', applyReducedMotion);

    // Load
    const draco = new DRACOLoader().setDecoderPath(CONFIG.dracoDecoderPath);
    const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    setProgress(0.05);
    loader.load(
        CONFIG.modelUrl,
        (gltf) => { setProgress(1); onModelLoaded(gltf); draco.dispose(); },
        (evt) => { if (evt.lengthComputable && evt.total) setProgress(0.05 + 0.95 * (evt.loaded / evt.total)); },
        (err) => { renderer.dispose(); showFallback(err); }
    );

    resize();

    window.__heroBurger = {
        CONFIG, scene, camera, renderer,
        get running() { return !!rafId; },
        get loaded() { return !!model; },
        pause() { inView = false; updateLoop(); },
        resume() { inView = true; updateLoop(); },
        resize,
        step(seconds = 1 / 60, frames = 1) { if (model) for (let i = 0; i < frames; i++) advance(seconds); },
    };
}

init();
