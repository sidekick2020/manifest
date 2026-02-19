    import * as THREE from 'three';
    import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

    let scene, camera, renderer, points, controls;
    let rotating = false; // Start paused for better UX
    let frameCount = 0;
    let lastTime = performance.now();
    let fps = 0;
    let mouse = new THREE.Vector2();
    let raycaster = new THREE.Raycaster();
    // Drag detection — suppress click when mouse moved > DRAG_THRESHOLD px
    let _mouseDownX = 0, _mouseDownY = 0, _isDrag = false;
    const DRAG_THRESHOLD = 5; // pixels
    let hoveredPoint = null;

    // Search optimization: debouncing and caching
    let searchTimeout = null;
    const searchCache = new Map(); // Cache key: query string, value: {results, timestamp, version}
    const SEARCH_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    const SEARCH_CACHE_MAX = 30;                  // cap entries so cache doesn't grow unbounded
    const SEARCH_CACHE_VERSION = 2; // Bump to invalidate old cache (e.g. stale profile picture data)
    const SEARCH_DEBOUNCE_DELAY = 300; // 300ms debounce

    // Debounce utility function
    function debounce(func, delay) {
      return function(...args) {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => func.apply(this, args), delay);
      };
    }

    export function init(containerElement) {
      _sceneDisposed = false;
      // Scene
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0a0a1a);
      scene.fog = new THREE.Fog(0x0a0a1a, 50, 200);

      // Camera
      camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      camera.position.set(120, 0, 80);
      camera.lookAt(0, 0, 0);

      // Renderer — mount in container when provided (React) else body (standalone HTML)
      const isMobileView = window.innerWidth <= 768;
      const maxPR = isMobileView ? 1.5 : 2;
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPR));
      (containerElement || document.body).appendChild(renderer.domElement);

      // OrbitControls for smooth navigation
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 0.1;  // Allow EXTREME close zoom for star detail (was 0.5)
      controls.maxDistance = 1000;  // Allow much farther zoom (was 800)
      controls.autoRotate = false;
      controls.autoRotateSpeed = 0.5;

      // Mouse/touch interaction (passive touchstart = no scroll blocking, better responsiveness)
      renderer.domElement.addEventListener('mousemove', onMouseMove);
      renderer.domElement.addEventListener('mousedown', onMouseDown);
      renderer.domElement.addEventListener('click', onMouseClick);
      renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: true });

      // Animation loop
      animate();

      // Generate some initial test points so screen isn't black
      // generatePoints(1000); // REMOVED: Only show real users from Back4App

      // Auto-start loading real data in background
      const dataLoadTimeoutId = setTimeout(() => {
        startLoadRealDataJob();
      }, 500);

      // Window resize
      window.addEventListener('resize', onResize);

      // Keyboard shortcuts
      window.addEventListener('keydown', onKeyDown);

      // When URL path changes (back/forward or manual edit), select that user if in universe
      window.addEventListener('popstate', applyUserFromUrl);

      // If navigating directly to a user via URL, show loading screen until we're ready (min 2s)
      if (getSlugFromUrl()) {
        const loadingEl = document.getElementById('loading-screen');
        if (loadingEl) loadingEl.classList.add('visible');
        _initialUrlUserPending = true;
        _loadingScreenShownAt = Date.now();
        if (_loadingScreenTimeoutId != null) clearTimeout(_loadingScreenTimeoutId);
        _loadingScreenTimeoutId = setTimeout(() => {
          _loadingScreenTimeoutId = null;
          if (!_initialUrlUserPending) return;
          _initialUrlUserPending = false;
          _pendingFlyToIndex = null;
          const el = document.getElementById('loading-screen');
          if (el) { el.classList.remove('visible'); el.classList.add('hidden'); }
          if (points && pointMetadata.length > 0) applyUserFromUrl();
        }, LOADING_SCREEN_MAX_MS);
      }

      // Bottom controls suggestions: hide when user starts using controls
      function dismissControlsSuggestions() {
        const el = document.getElementById('controls-suggestions');
        if (!el || el.classList.contains('hidden')) return;
        el.classList.add('hidden');
        try { sessionStorage.setItem('controlsSuggestionsDismissed', '1'); } catch (e) {}
        controls.removeEventListener('start', dismissControlsSuggestions);
      }
      if (!sessionStorage.getItem('controlsSuggestionsDismissed')) {
        controls.addEventListener('start', dismissControlsSuggestions);
        renderer.domElement.addEventListener('wheel', dismissControlsSuggestions, { once: true, passive: true });
        renderer.domElement.addEventListener('click', dismissControlsSuggestions, { once: true });
      } else {
        const el = document.getElementById('controls-suggestions');
        if (el) el.classList.add('hidden');
      }
      // Navigation state: pause beam animation and hide planets while rotating/panning
      controls.addEventListener('start', () => { _isNavigating = true; });
      controls.addEventListener('end', () => { _isNavigating = false; });

      // Delegated click on search dropdown so selecting a result works (inline onclick can fail in React)
      function onSearchDropdownClick(e) {
        const item = e.target.closest('.search-result-item');
        if (!item) return;
        const idxStr = item.getAttribute('data-index');
        if (idxStr == null) return;
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx) && typeof window.selectSearchResultByIndex === 'function') {
          e.preventDefault();
          window.selectSearchResultByIndex(idx);
        }
      }
      const searchDropdownEl = document.getElementById('search-dropdown');
      if (searchDropdownEl) searchDropdownEl.addEventListener('click', onSearchDropdownClick);

      // Delegated click on supporter cards (detail panel) so cards are clickable when DOM is driven by React
      function onSupporterCardClick(e) {
        const container = document.getElementById('supporter-cards-container');
        if (!container || !container.contains(e.target)) return;
        const card = e.target.closest('.supporter-card');
        if (!card) return;
        const id = card.getAttribute('data-member-id');
        if (!id) return;
        const idx = memberIndexMap.get(id);
        if (idx !== undefined) {
          e.preventDefault();
          flashPoint(idx);
        }
      }
      document.addEventListener('click', onSupporterCardClick);

      function onLoadMorePostsClick(e) {
        const btn = e.target.closest('.posts-load-more-btn');
        if (!btn) return;
        e.preventDefault();
        const postsGrid = document.getElementById('posts-grid');
        if (!postsGrid || !_currentPostsForGrid || _currentPostsUserId == null) return;
        const from = _postsGridShownCount;
        const to = Math.min(from + POST_GRID_LOAD_MORE, _currentPostsForGrid.length);
        const chunk = _currentPostsForGrid.slice(from, to);
        const wrap = postsGrid.querySelector('.posts-load-more-wrap');
        const fragment = document.createDocumentFragment();
        chunk.forEach((p) => {
          const div = document.createElement('div');
          div.innerHTML = buildPostItemHTML(p, _currentPostsUserId);
          fragment.appendChild(div.firstElementChild);
        });
        postsGrid.insertBefore(fragment, wrap);
        _postsGridShownCount = to;
        if (_postsGridShownCount >= _currentPostsForGrid.length && wrap) wrap.remove();
      }
      document.addEventListener('click', onLoadMorePostsClick);

      // Return cleanup for React unmount (e.g. Strict Mode remount or route change)
      return function cleanup() {
        _sceneDisposed = true;
        if (_animateRafId != null) {
          cancelAnimationFrame(_animateRafId);
          _animateRafId = null;
        }
        if (_mouseMoveRaf != null) {
          cancelAnimationFrame(_mouseMoveRaf);
          _mouseMoveRaf = null;
        }
        clearTimeout(dataLoadTimeoutId);
        if (_loadingScreenTimeoutId != null) {
          clearTimeout(_loadingScreenTimeoutId);
          _loadingScreenTimeoutId = null;
        }
        window.removeEventListener('resize', onResize);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('popstate', applyUserFromUrl);
        const searchDrop = document.getElementById('search-dropdown');
        if (searchDrop && onSearchDropdownClick) searchDrop.removeEventListener('click', onSearchDropdownClick);
        document.removeEventListener('click', onSupporterCardClick);
        document.removeEventListener('click', onLoadMorePostsClick);
        if (controls) {
          controls.dispose();
        }
        if (renderer && renderer.domElement && containerElement && containerElement.contains(renderer.domElement)) {
          containerElement.removeChild(renderer.domElement);
        }
        if (renderer) {
          renderer.dispose();
        }
        scene = null;
        camera = null;
        renderer = null;
        points = null;
        controls = null;
      };
    }

    // Store point metadata for interaction
    let pointMetadata = [];
    let selectedMemberIndex = null;
    // True when page loaded with a user in URL — we show loading screen and do God-view fly-in when ready
    let _initialUrlUserPending = false;
    let _loadingScreenShownAt = 0;
    let _pendingFlyToIndex = null;
    const LOADING_SCREEN_MAX_MS = 15000; // Force-hide after 15s so mobile never sticks (slow/failed load)
    let _loadingScreenTimeoutId = null;

    // Incremental enrichment tracking
    const loadedMemberIds = new Set();
    const memberIndexMap = new Map(); // objectId -> array index
    const usernameToIndexMap = new Map(); // lowercase username -> array index (for URL lookup)
    // Single active connection line (one star at a time, updates live with positions)
    let activeConnectionLine = null; // { lineSegments, sourceId, targetIds }
    const connectionLines = new Map(); // kept as empty stub so clearConnectionLines still works

    // Orbiting post-planets (one shared Points object, ≤100 vertices)
    let orbitingPosts = null;       // THREE.Points
    let orbitData = [];             // [{ angle, speed, radius, tiltX, tiltZ, postId, createdAt }]
    let orbitHostId = null;         // which member's posts are orbiting
    let selectedPlanetIndex = -1;   // which planet is halo'd (-1 = none)

    // Selected-member overlay: floating label + profile picture sprite
    let selectedLabel = null;       // DOM div — username floating over star
    let selectedSprite = null;      // THREE.Sprite — profile pic rendered on star
    const _projectVec = new THREE.Vector3(); // reused each frame — no alloc in hot path

    // Performance: throttle beam/planet updates to keep FPS up during rotate
    let _heavyUpdateTick = 0;
    // True while user is dragging/orbiting; beam pulse animation pauses
    let _isNavigating = false;
    // True only during camera fly-to (travel) to a member; hide beams/planets and skip their updates
    let _isTraveling = false;

    // Animated counters for detail panel (beams/planets) — cancel when switching user
    let _detailBeamsRaf = null;
    let _detailPlanetsRaf = null;
    let _detailBeamsCurrent = 0;
    let _detailPlanetsCurrent = 0;
    const DETAIL_COUNTER_DURATION_MS = 600;
    const DETAIL_COUNTER_THROTTLE_MS = 400;
    let _lastDetailBeamsCountUpdate = 0;

    function animateDetailCounter(elementId, targetValue) {
      const el = document.getElementById(elementId);
      if (!el) return;
      const isBeams = elementId === 'detail-beams-count';
      if (isBeams) {
        if (_detailBeamsRaf != null) cancelAnimationFrame(_detailBeamsRaf);
        _detailBeamsRaf = null;
      } else {
        if (_detailPlanetsRaf != null) cancelAnimationFrame(_detailPlanetsRaf);
        _detailPlanetsRaf = null;
      }
      let current = isBeams ? _detailBeamsCurrent : _detailPlanetsCurrent;
      const start = current;
      const startTime = performance.now();
      function tick(now) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / DETAIL_COUNTER_DURATION_MS);
        const ease = 1 - Math.pow(1 - t, 2);
        current = Math.round(start + (targetValue - start) * ease);
        if (current > targetValue) current = targetValue;
        el.textContent = current;
        if (isBeams) _detailBeamsCurrent = current; else _detailPlanetsCurrent = current;
        if (current < targetValue) {
          const raf = requestAnimationFrame(tick);
          if (isBeams) _detailBeamsRaf = raf; else _detailPlanetsRaf = raf;
        } else {
          if (isBeams) _detailBeamsRaf = null; else _detailPlanetsRaf = null;
        }
      }
      const raf = requestAnimationFrame(tick);
      if (isBeams) _detailBeamsRaf = raf; else _detailPlanetsRaf = raf;
    }

    function updateDetailBeamsCount(userId, count) {
      if (selectedMemberIndex == null || !pointMetadata[selectedMemberIndex] || pointMetadata[selectedMemberIndex].id !== userId) return;
      animateDetailCounter('detail-beams-count', count);
    }

    function updateDetailPlanetsCount(userId, count) {
      if (selectedMemberIndex == null || !pointMetadata[selectedMemberIndex] || pointMetadata[selectedMemberIndex].id !== userId) return;
      animateDetailCounter('detail-planets-count', count);
    }

    // Background jobs system
    let jobs = [];
    let jobIdCounter = 0;

    // Custom shaders for star appearance
    const starVertexShader = `
      attribute float size;
      attribute vec3 color;
      attribute float activity;
      attribute float vertexIndex;

      varying vec3 vColor;
      varying float vActivity;
      varying float vIsSelected;
      varying float vCamDist;

      uniform float time;
      uniform float selectedIndex;

      void main() {
        vColor = color;
        vActivity = activity;
        vIsSelected = (vertexIndex == selectedIndex) ? 1.0 : 0.0;

        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float camDist = length(mvPosition.xyz);
        vCamDist = camDist;

        // Distance-based LOD
        // Far (250+): larger minimum so stars stay visible and bright from distance
        // Close (30-): boost for detail
        float lodFactor = smoothstep(250.0, 30.0, camDist);
        float finalSize = size * mix(2.0, 6.0, lodFactor); // min raised 0.6→2.0 for far visibility

        // Add extra boost for close-up views (within 30 units)
        if (camDist < 30.0) {
          float closeBoost = smoothstep(30.0, 0.1, camDist);
          finalSize *= mix(1.0, 33.0, closeBoost); // Up to 100x total when very close
        }

        // Enforce minimum size of 1.5px (subtle dots at extreme distances)
        finalSize = max(finalSize, 1.5);

        // Activity pulsing (subtle)
        float pulsePhase = position.x + position.y; // Randomize timing
        float pulse = sin(time * 1.5 + pulsePhase) * 0.15 + 0.85;
        finalSize *= mix(1.0, pulse, vActivity * 0.3);

        // Boost size for selected star
        if (vIsSelected > 0.5) {
          finalSize *= 1.8; // 80% larger
        }

        gl_PointSize = finalSize;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const starFragmentShader = `
      varying vec3 vColor;
      varying float vActivity;
      varying float vIsSelected;
      varying float vCamDist;

      uniform float time;

      void main() {
        vec2 coord = gl_PointCoord * 2.0 - 1.0;
        float dist = length(coord);
        if (dist > 0.85) discard;

        float core      = 1.0 - smoothstep(0.0,  0.2,  dist);
        float innerGlow = 1.0 - smoothstep(0.2,  0.5,  dist);
        float outerGlow = 1.0 - smoothstep(0.5,  0.85, dist);

        float distBoost = smoothstep(30.0, 250.0, vCamDist);
        float brightMult = mix(1.0, 3.0, distBoost);
        float brightness = (core * 1.8 + innerGlow * 0.5 + outerGlow * 0.35) * brightMult;
        float alpha      = (core * 1.0 + innerGlow * 0.8 + outerGlow * 0.4)  * brightMult;

        float depth = gl_FragCoord.z / gl_FragCoord.w;
        alpha *= (1.0 - smoothstep(80.0, 400.0, depth) * 0.35);

        vec3 finalColor = vColor * brightness;
        if (vIsSelected > 0.5) {
          float selGlow = 1.0 - smoothstep(0.0, 1.0, dist);
          alpha += selGlow * 0.4;
          finalColor *= 1.25;
        }
        gl_FragColor = vec4(finalColor, clamp(alpha, 0.0, 1.0));
      }
    `;

    function generatePoints(count) {
      console.time(`generate-${count}`);

      // Remove old points
      if (points) {
        scene.remove(points);
        points.geometry.dispose();
        points.material.dispose();
      }

      // Clear metadata
      pointMetadata = [];

      // Create buffers
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const sizes = new Float32Array(count);
      const activities = new Float32Array(count);
      const vertexIndices = new Float32Array(count);

      // Generate random spherical distribution (mimics real data)
      for (let i = 0; i < count; i++) {
        // Spherical coords with clustering
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 50 + Math.random() * 60; // radius 50-110 (wider spread)

        // Add some clustering (simulate neighborhoods)
        const clusterId = Math.floor(Math.random() * 10);
        const clusterOffset = clusterId * 24;
        const clusterTheta = Math.random() * Math.PI * 2;
        const clusterR = Math.random() * 18;

        const x = r * Math.sin(phi) * Math.cos(theta) + clusterR * Math.cos(clusterTheta);
        const y = r * Math.sin(phi) * Math.sin(theta) + clusterR * Math.sin(clusterTheta);
        const z = r * Math.cos(phi) + clusterOffset;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        // Color gradient (blue -> cyan -> yellow -> red = risk gradient)
        const risk = Math.random();
        let riskLevel = 'low';
        if (risk < 0.33) {
          // Blue to Cyan
          const t = risk * 3;
          colors[i * 3] = 0;
          colors[i * 3 + 1] = t;
          colors[i * 3 + 2] = 1;
          riskLevel = 'low';
        } else if (risk < 0.66) {
          // Cyan to Yellow
          const t = (risk - 0.33) * 3;
          colors[i * 3] = t;
          colors[i * 3 + 1] = 1;
          colors[i * 3 + 2] = 1 - t;
          riskLevel = 'medium';
        } else {
          // Yellow to Red
          const t = (risk - 0.66) * 3;
          colors[i * 3] = 1;
          colors[i * 3 + 1] = 1 - t;
          colors[i * 3 + 2] = 0;
          riskLevel = 'high';
        }

        // Size variation (based on "activity")
        const activity = Math.floor(Math.random() * 100);
        sizes[i] = 2 + Math.log(activity + 1) * 0.5;
        activities[i] = activity / 100; // Normalize to 0-1
        vertexIndices[i] = i; // Sequential index

        // Store metadata for this point
        pointMetadata.push({
          id: `member_${i}`,
          username: `User${i}`,
          profilePicture: null, // Synthetic data has no profile pictures
          position: { x, y, z }, // Store as numbers for zoom functionality
          risk: (risk * 100).toFixed(0),
          riskLevel,
          activity,
          sobrietyDays: Math.floor(Math.random() * 365),
          cluster: `Cluster ${clusterId}`,
        });
      }

      // Create geometry
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
      geometry.setAttribute('activity', new THREE.BufferAttribute(activities, 1));
      geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(vertexIndices, 1));

      // Create custom shader material
      const material = new THREE.ShaderMaterial({
        vertexShader: starVertexShader,
        fragmentShader: starFragmentShader,
        uniforms: {
          time: { value: 0 },
          selectedIndex: { value: -1.0 }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending, // Changed from AdditiveBlending to prevent white ball effect
      });

      // Create points
      points = new THREE.Points(geometry, material);
      scene.add(points);

      // Update stats
      document.getElementById('count').textContent = count.toLocaleString();

      // Calculate memory (rough estimate)
      const geomMemory = (positions.byteLength + colors.byteLength + sizes.byteLength) / 1024 / 1024;
      document.getElementById('geom').textContent = geomMemory.toFixed(2) + ' MB';

      console.timeEnd(`generate-${count}`);
    }

    let _mouseMoveRaf = null;
    function onMouseMove(event) {
      mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

      // Throttle beam hover check to next frame (avoid raycaster on every mousemove for FPS)
      if (activeConnectionLine && renderer) {
        if (_mouseMoveRaf != null) return;
        _mouseMoveRaf = requestAnimationFrame(() => {
          _mouseMoveRaf = null;
          if (!activeConnectionLine || !renderer) return;
          raycaster.setFromCamera(mouse, camera);
          const prevT = raycaster.params.Line.threshold;
          raycaster.params.Line.threshold = 1.2;
          let hits = [];
          const batches = activeConnectionLine.batches;
          if (batches) {
            for (let i = 0; i < batches.length; i++) {
              if (batches[i].lineSegments) {
                hits = hits.concat(raycaster.intersectObject(batches[i].lineSegments));
              }
            }
          } else if (activeConnectionLine.lineSegments) {
            hits = raycaster.intersectObject(activeConnectionLine.lineSegments);
          }
          raycaster.params.Line.threshold = prevT;
          renderer.domElement.style.cursor = hits.length > 0 ? 'pointer' : '';
        });
      }
    }

    function onMouseDown(event) {
      _mouseDownX = event.clientX;
      _mouseDownY = event.clientY;
      _isDrag = false;
    }

    function onMouseClick(event) {
      // Suppress if this was a drag (orbit/pan gesture)
      const dx = event.clientX - _mouseDownX;
      const dy = event.clientY - _mouseDownY;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) return;

      if (!points) return;

      raycaster.setFromCamera(mouse, camera);

      // Check orbiting planets first — only full-detail sprites (LOD overflow points are not clickable)
      if (orbitingPosts && orbitingPosts.children.length > 0) {
        const spriteChildren = orbitingPosts.children.filter((c) => c.isSprite);
        const planetHits = raycaster.intersectObjects(spriteChildren, false);
        if (planetHits.length > 0) {
          const sprite = planetHits[0].object;
          const idx = sprite.userData.index;
          // Highlight selected planet (scale up applied in animate loop so it works with distance LOD)
          if (selectedPlanetIndex >= 0 && selectedPlanetIndex < orbitingPosts.children.length) {
            const prev = orbitingPosts.children[selectedPlanetIndex];
            if (prev && prev.userData._baseScale != null) prev.scale.setScalar(prev.userData._baseScale);
          }
          selectedPlanetIndex = idx;

          const od = orbitData[idx];
          if (od && od.postId) {
            expandPost(od.postId, orbitHostId);
          }
          return; // don't also select the star behind it
        }
      }

      // Check connection beams — clicking a beam travels to the target star
      if (activeConnectionLine) {
        const prevLineThreshold = raycaster.params.Line.threshold;
        raycaster.params.Line.threshold = 1.2; // generous hit area for thick glow beams
        let bestHit = null;
        let bestTargetIdx = undefined;
        const batches = activeConnectionLine.batches;
        if (batches) {
          for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            if (!batch.lineSegments) continue;
            const batchHits = raycaster.intersectObject(batch.lineSegments);
            if (batchHits.length > 0 && (!bestHit || batchHits[0].distance < bestHit.distance)) {
              bestHit = batchHits[0];
              const segIdx = Math.floor(batchHits[0].index / 2);
              bestTargetIdx = batch.targetIndices[segIdx];
            }
          }
        } else if (activeConnectionLine.lineSegments) {
          const beamHits = raycaster.intersectObject(activeConnectionLine.lineSegments);
          if (beamHits.length > 0) {
            bestHit = beamHits[0];
            const segIdx = Math.floor(beamHits[0].index / 2);
            bestTargetIdx = activeConnectionLine.targetIndices[segIdx];
          }
        }
        raycaster.params.Line.threshold = prevLineThreshold;
        if (bestHit && bestTargetIdx !== undefined) {
          flashPoint(bestTargetIdx);
          return;
        }
      }

      // Otherwise check member stars
      const intersects = raycaster.intersectObject(points);

      if (intersects.length > 0) {
        const point = intersects[0];
        const index = point.index;
        flashPoint(index);
      }
    }

    function onTouchStart(event) {
      if (event.touches.length === 1) {
        mouse.x = (event.touches[0].clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.touches[0].clientY / window.innerHeight) * 2 + 1;
      }
    }

    // Build a circular canvas texture from an image URL for the sprite (aspect-fill / cover)
    function createProfileSprite(imageUrl, username, forMemberIndex) {
      const SIZE = 128;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      const cx = SIZE / 2;
      const R = (SIZE / 2) * (2 / 3);
      const PAD = SIZE / 2 - R;
      const diam = SIZE - PAD * 2;

      function finalize(drawFn) {
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cx, R, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        drawFn(PAD, R);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cx, R, 0, Math.PI * 2);
        ctx.stroke();

        const texture = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: THREE.NormalBlending,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 10;
        sprite.scale.set(0.7, 0.7, 1.0);
        return sprite;
      }

      function drawImageCover(img, pad, r) {
        const w = img.naturalWidth || img.width || 1;
        const h = img.naturalHeight || img.height || 1;
        const scale = Math.max(diam / w, diam / h);
        const dw = w * scale;
        const dh = h * scale;
        ctx.drawImage(img, cx - dw / 2, cx - dh / 2, dw, dh);
      }

      function tryPlaceSprite(sprite) {
        if (forMemberIndex !== undefined && selectedMemberIndex !== forMemberIndex) {
          sprite.material.map.dispose();
          sprite.material.dispose();
          return;
        }
        placeSprite(sprite);
      }

      if (imageUrl) {
        const img = new Image();
        loadImageWithBlobFallback(img, imageUrl,
          () => {
            try {
              const sprite = finalize(() => drawImageCover(img, PAD, R));
              tryPlaceSprite(sprite);
            } catch (e) {
              const sprite = finalize((pad) => drawInitialsOnCanvas(ctx, SIZE, pad, username));
              tryPlaceSprite(sprite);
            }
          },
          () => {
            const sprite = finalize((pad) => drawInitialsOnCanvas(ctx, SIZE, pad, username));
            tryPlaceSprite(sprite);
          },
          { forCanvas: true }
        );
      } else {
        const sprite = finalize((pad) => drawInitialsOnCanvas(ctx, SIZE, pad, username));
        tryPlaceSprite(sprite);
      }
    }

    function drawInitialsOnCanvas(ctx, size, pad, username) {
      // Fill only the inset area
      ctx.fillStyle = '#1a1a3a';
      ctx.fillRect(pad, pad, size - pad * 2, size - pad * 2);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${(size - pad * 2) * 0.38}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(getInitials(username), size / 2, size / 2);
    }

    function placeSprite(sprite) {
      // Only place if this sprite is still the active one (user may have changed)
      if (!selectedSprite || selectedSprite._disposed) {
        // selectedSprite was cleared — dispose this late-arriving sprite
        sprite.material.map.dispose();
        sprite.material.dispose();
        return;
      }
      // Remove and dispose whatever sprite is currently placed (placeholder or real initials)
      if (selectedSprite !== sprite) {
        scene.remove(selectedSprite);
        if (!selectedSprite._placeholder && selectedSprite.material) {
          if (selectedSprite.material.map) selectedSprite.material.map.dispose();
          selectedSprite.material.dispose();
        }
        selectedSprite._disposed = true;
      }
      selectedSprite = sprite;
      // Position at current host location
      if (selectedMemberIndex !== null && points) {
        const posArr = points.geometry.attributes.position.array;
        sprite.position.set(
          posArr[selectedMemberIndex * 3],
          posArr[selectedMemberIndex * 3 + 1],
          posArr[selectedMemberIndex * 3 + 2]
        );
      }
      scene.add(sprite);
    }

    let _currentProfileBlobUrl = null;

    function clearSelectedOverlay() {
      if (_currentProfileBlobUrl) {
        URL.revokeObjectURL(_currentProfileBlobUrl);
        _currentProfileBlobUrl = null;
      }
      if (selectedSprite) {
        scene.remove(selectedSprite);
        if (selectedSprite.material) {
          if (selectedSprite.material.map) selectedSprite.material.map.dispose();
          selectedSprite.material.dispose();
        }
        selectedSprite._disposed = true;
        selectedSprite = null;
      }
      const lbl = document.getElementById('star-label');
      if (lbl) lbl.style.display = 'none';
      selectedLabel = null;
    }

    /** URL is path-based: / for root, /username for a user. No hash or test-point-cloud in path. */
    function getSlugFromUrl() {
      const path = location.pathname.replace(/^\//, '').split('/')[0] || '';
      if (!path || path === 'test-point-cloud.html' || path === 'index.html') return null;
      try {
        return decodeURIComponent(path) || null;
      } catch (_) {
        return path || null;
      }
    }

    /** Resolve URL slug (id or username, case-insensitive) to member index, or undefined. */
    function getMemberIndexFromSlug(slug) {
      if (!slug) return undefined;
      const decoded = decodeURIComponent(slug).trim();
      const byId = memberIndexMap.get(decoded);
      if (byId !== undefined) return byId;
      const byUsername = usernameToIndexMap.get(decoded.toLowerCase());
      return byUsername;
    }

    function syncUsernameToIndexMap() {
      usernameToIndexMap.clear();
      if (!pointMetadata || pointMetadata.length === 0) return;
      for (let i = 0; i < pointMetadata.length; i++) {
        const m = pointMetadata[i];
        const un = (m && m.username) ? String(m.username).trim().toLowerCase() : '';
        if (un && un !== 'anonymous' && !/^user\d+$/.test(un)) {
          usernameToIndexMap.set(un, i);
        }
      }
    }

    function setUrlForUser(userId, username) {
      const root = '/';
      if (!userId) {
        history.replaceState(null, '', root + location.search);
        return;
      }
      const raw = (username && username !== 'Anonymous' && !/^User\d+$/i.test(String(username)))
        ? username
        : userId;
      const slug = String(raw).trim();
      history.replaceState(null, '', root + encodeURIComponent(slug) + location.search);
    }

    const GOD_VIEW_POSITION = { x: 120, y: 0, z: 80 };
    const GOD_VIEW_TARGET = { x: 0, y: 0, z: 0 };
    const FLY_TO_USER_DURATION_MS = 2800;

    function hideLoadingScreenThenFlyToUser(idx) {
      if (_loadingScreenTimeoutId != null) {
        clearTimeout(_loadingScreenTimeoutId);
        _loadingScreenTimeoutId = null;
      }
      const loadingEl = document.getElementById('loading-screen');
      if (loadingEl) {
        loadingEl.classList.remove('visible');
        loadingEl.classList.add('hidden');
        loadingEl.setAttribute('aria-busy', 'false');
      }
      if (!points || !points.geometry || !points.geometry.attributes.position) return;
      camera.position.set(GOD_VIEW_POSITION.x, GOD_VIEW_POSITION.y, GOD_VIEW_POSITION.z);
      controls.target.set(GOD_VIEW_TARGET.x, GOD_VIEW_TARGET.y, GOD_VIEW_TARGET.z);
      controls.update();
      flashPoint(idx, { fromGodView: true });
    }

    /** Fetch one user by username or objectId and add them to the point cloud; returns new index or null. */
    async function loadUserBySlug(slug) {
      if (!points || !points.geometry) return null;
      const decoded = decodeURIComponent(slug).trim();
      const where = { $or: [{ username: decoded }, { objectId: decoded }] };
      const params = new URLSearchParams({
        where: JSON.stringify(where),
        limit: '1',
        keys: 'objectId,username,sobrietyDate,createdAt,proPic,profilePicture,updatedAt,TotalComments',
      });
      const B4A_HEADERS = {
        'X-Parse-Application-Id': 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
        'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq',
      };
      let res;
      try {
        res = await fetch(`https://parseapi.back4app.com/classes/_User?${params}`, { method: 'GET', headers: B4A_HEADERS });
      } catch (e) {
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const results = data.results || [];
      if (results.length === 0) return null;
      const u = results[0];
      const id = u.objectId;
      if (memberIndexMap.get(id) !== undefined) return memberIndexMap.get(id);

      const proPicUrl = (u.proPic && (typeof u.proPic === 'string' ? u.proPic : u.proPic.url)) || (u.profilePicture && (typeof u.profilePicture === 'string' ? u.profilePicture : u.profilePicture.url)) || null;
      const codecModule = await import('../../lib/codec.js');
      const { createState, evolve, DEFAULT_PARAMS } = codecModule;
      const state = createState();
      state.members.set(id, {
        username: u.username || 'Anonymous',
        sobriety: u.sobrietyDate?.iso ?? null,
        created: u.createdAt,
        proPic: proPicUrl,
        totalComments: u.TotalComments != null ? Number(u.TotalComments) : null,
        mass: 1,
        position: null,
        opacity: 0,
        scale: 0,
      });
      evolve(state, DEFAULT_PARAMS);
      const member = state.members.get(id);
      const pos = member && member.position ? member.position : codecModule.seedToPos(id, 80);
      const px = typeof pos.x === 'number' ? pos.x : 0;
      const py = typeof pos.y === 'number' ? pos.y : 0;
      const pz = typeof pos.z === 'number' ? pos.z : 0;

      const nextIndex = points.geometry.attributes.position.count;
      if (nextIndex >= MAX_POINTS_DISPLAYED) return null;

      const risk = Math.random();
      const color = getRiskColor(risk);
      const oldPos = points.geometry.attributes.position.array;
      const oldCol = points.geometry.attributes.color.array;
      const oldSize = points.geometry.attributes.size.array;
      const oldAct = points.geometry.attributes.activity.array;
      const oldIdx = points.geometry.attributes.vertexIndex.array;
      const newPos = new Float32Array(oldPos.length + 3);
      const newCol = new Float32Array(oldCol.length + 3);
      const newSize = new Float32Array(oldSize.length + 1);
      const newAct = new Float32Array(oldAct.length + 1);
      const newIdxArr = new Float32Array(oldIdx.length + 1);
      newPos.set(oldPos); newPos[oldPos.length] = px; newPos[oldPos.length + 1] = py; newPos[oldPos.length + 2] = pz;
      newCol.set(oldCol); newCol[oldCol.length] = color.r; newCol[oldCol.length + 1] = color.g; newCol[oldCol.length + 2] = color.b;
      newSize.set(oldSize); newSize[oldSize.length] = 2;
      newAct.set(oldAct); newAct[oldAct.length] = 0;
      newIdxArr.set(oldIdx); newIdxArr[oldIdx.length] = nextIndex;
      points.geometry.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
      points.geometry.setAttribute('color', new THREE.BufferAttribute(newCol, 3));
      points.geometry.setAttribute('size', new THREE.BufferAttribute(newSize, 1));
      points.geometry.setAttribute('activity', new THREE.BufferAttribute(newAct, 1));
      points.geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(newIdxArr, 1));
      const sobrietyIso = u.sobrietyDate?.iso ?? (typeof u.sobrietyDate === 'string' ? u.sobrietyDate : null);
      const sobrietyDays = sobrietyIso ? Math.floor((Date.now() - new Date(sobrietyIso).getTime()) / 86400000) : 0;
      pointMetadata.push({
        id,
        username: u.username || 'Anonymous',
        profilePicture: proPicUrl,
        position: { x: px, y: py, z: pz },
        risk: (risk * 100).toFixed(0),
        riskLevel: risk < 0.33 ? 'low' : risk < 0.66 ? 'medium' : 'high',
        activity: 0,
        sobrietyDays,
        sobrietyDate: sobrietyIso || null,
        cluster: 'Real Data',
      });
      memberIndexMap.set(id, nextIndex);
      loadedMemberIds.add(id);
      syncUsernameToIndexMap();
      return nextIndex;
    }

    function applyUserFromUrl() {
      if (!points || !pointMetadata.length) return;
      const slug = getSlugFromUrl();
      if (!slug) return;
      const idx = getMemberIndexFromSlug(slug);
      if (_initialUrlUserPending) {
        if (idx === undefined) {
          // URL user not in current batch — fetch them and add to point cloud, then fly to them
          loadUserBySlug(slug).then((newIdx) => {
            if (_loadingScreenTimeoutId != null) { clearTimeout(_loadingScreenTimeoutId); _loadingScreenTimeoutId = null; }
            _initialUrlUserPending = false;
            _pendingFlyToIndex = null;
            if (newIdx != null) {
              _pendingFlyToIndex = newIdx;
              const minShowMs = 2000;
              const elapsed = Date.now() - _loadingScreenShownAt;
              const delay = Math.max(0, minShowMs - elapsed);
              setTimeout(() => {
                if (_pendingFlyToIndex != null) {
                  const targetIdx = _pendingFlyToIndex;
                  _pendingFlyToIndex = null;
                  hideLoadingScreenThenFlyToUser(targetIdx);
                }
              }, delay);
            } else {
              const loadingEl = document.getElementById('loading-screen');
              if (loadingEl) { loadingEl.classList.remove('visible'); loadingEl.classList.add('hidden'); loadingEl.setAttribute('aria-busy', 'false'); }
              camera.position.set(GOD_VIEW_POSITION.x, GOD_VIEW_POSITION.y, GOD_VIEW_POSITION.z);
              controls.target.set(GOD_VIEW_TARGET.x, GOD_VIEW_TARGET.y, GOD_VIEW_TARGET.z);
              controls.update();
            }
          });
          return;
        }
        _initialUrlUserPending = false;
        _pendingFlyToIndex = idx;
        const minShowMs = 2000;
        const elapsed = Date.now() - _loadingScreenShownAt;
        const delay = Math.max(0, minShowMs - elapsed);
        setTimeout(() => {
          if (_pendingFlyToIndex != null) {
            const targetIdx = _pendingFlyToIndex;
            _pendingFlyToIndex = null;
            hideLoadingScreenThenFlyToUser(targetIdx);
          }
        }, delay);
      } else {
        if (idx === undefined || idx === selectedMemberIndex) return;
        flashPoint(idx);
      }
    }

    function flashPoint(index, options) {
      // Show detail panel
      const metadata = pointMetadata[index];
      if (!metadata) return;
      _dbgLog('flashPoint idx=' + index + ' id=' + metadata.id);

      // Close any expanded post view — switching star goes back to member view
      const expandedView = document.getElementById('post-expanded');
      if (expandedView) expandedView.classList.remove('visible');

      // Reset supporter cards while new profile loads
      const suppSec = document.getElementById('supporters-section');
      if (suppSec) suppSec.style.display = 'none';

      // Reset Beams/Planets counters and cancel any in-flight animations
      if (_detailBeamsRaf != null) cancelAnimationFrame(_detailBeamsRaf);
      if (_detailPlanetsRaf != null) cancelAnimationFrame(_detailPlanetsRaf);
      _detailBeamsRaf = null;
      _detailPlanetsRaf = null;
      _detailBeamsCurrent = 0;
      _detailPlanetsCurrent = 0;
      const beamsEl = document.getElementById('detail-beams-count');
      const planetsEl = document.getElementById('detail-planets-count');
      if (beamsEl) beamsEl.textContent = '0';
      if (planetsEl) planetsEl.textContent = '0';

      const detailEl = document.getElementById('detail');
      const alreadyOpen = detailEl && detailEl.classList.contains('visible');
      if (alreadyOpen && detailEl) {
        detailEl.classList.add('content-transitioning');
      }

      const prevIndex = selectedMemberIndex;
      selectedMemberIndex = index;

      // Update shader uniform for selection halo
      if (points && points.material && points.material.uniforms) {
        points.material.uniforms.selectedIndex.value = index;
      }

      // Clear any existing overlay from previous selection
      clearSelectedOverlay();

      // Show floating username label (positioned every frame in animate)
      const lblEl = document.getElementById('star-label');
      const lblText = document.getElementById('star-label-text');
      const lblPip = document.getElementById('star-label-pip');
      selectedLabel = lblEl;

      // Update profile picture/avatar with smooth loading
      const avatar = document.getElementById('detail-avatar');
      const username = metadata.username || metadata.id;

      const imageUrl = getProfilePictureUrl(metadata.profilePicture);

      // Set up floating label color to match risk level
      const riskColors = { low: '#3CDC78', medium: '#FFD580', high: '#FF5038' };
      const pipColor = riskColors[metadata.riskLevel] || '#ffffff';
      if (lblText) lblText.textContent = '@' + username;
      if (lblPip) lblPip.style.background = pipColor;
      if (lblEl) lblEl.style.display = 'block';

      selectedSprite = { _placeholder: true, _disposed: false };

      if (imageUrl) {
        if (avatar) {
          avatar.classList.add('loading');
          avatar.textContent = '';
        }
        const cachedBlobUrl = getCachedProfileBlobUrl(imageUrl);
        if (cachedBlobUrl) {
          const img = document.createElement('img');
          img.alt = username;
          if (avatar) avatar.appendChild(img);
          img.onload = () => {
            if (selectedMemberIndex !== index) return;
            if (avatar) { avatar.classList.remove('loading'); img.classList.add('loaded'); }
          };
          img.onerror = () => {
            if (avatar) { avatar.classList.remove('loading'); avatar.innerHTML = ''; avatar.textContent = getInitials(username); }
          };
          img.src = cachedBlobUrl;
          createProfileSprite(cachedBlobUrl, username, index);
        } else {
        fetch(getProfileImageFetchUrl(imageUrl) || imageUrl, { mode: 'cors' })
          .then(r => r.ok ? r.blob() : Promise.reject(r.status))
          .then(blob => {
            if (selectedMemberIndex !== index) return;
            const blobUrl = setProfileImageCache(imageUrl, blob) || URL.createObjectURL(new Blob([blob], { type: 'image/jpeg' }));
            if (_currentProfileBlobUrl) URL.revokeObjectURL(_currentProfileBlobUrl);
            _currentProfileBlobUrl = blobUrl;

            const img = document.createElement('img');
            img.alt = username;
            if (avatar) avatar.appendChild(img);
            img.onload = () => {
              if (selectedMemberIndex !== index) return;
              if (avatar) { avatar.classList.remove('loading'); img.classList.add('loaded'); }
            };
            img.onerror = () => {
              if (avatar) { avatar.classList.remove('loading'); avatar.innerHTML = ''; avatar.textContent = getInitials(username); }
            };
            img.src = blobUrl;
            createProfileSprite(blobUrl, username, index);
          })
          .catch(() => {
            if (selectedMemberIndex !== index) return;
            const cached = getCachedProfileBlobUrl(imageUrl);
            if (cached) {
              const img = document.createElement('img');
              img.alt = username;
              if (avatar) avatar.appendChild(img);
              img.onload = () => { if (avatar) avatar.classList.remove('loading'); img.classList.add('loaded'); };
              img.src = cached;
              createProfileSprite(cached, username, index);
              return;
            }
            createProfileSprite(imageUrl, username, index);
            const img = document.createElement('img');
            img.alt = username;
            if (avatar) avatar.appendChild(img);
            loadImageWithBlobFallback(img, imageUrl,
              () => { if (avatar) avatar.classList.remove('loading'); img.classList.add('loaded'); },
              () => { if (avatar) { avatar.classList.remove('loading'); avatar.innerHTML = ''; avatar.textContent = getInitials(username); } },
              { forCanvas: false }
            );
          });
        }
      } else {
        if (avatar) {
          avatar.classList.remove('loading');
          avatar.innerHTML = '';
          avatar.textContent = getInitials(username);
        }

        // Lazy-fetch proPic for stub users that have no profile picture yet.
        // If found, update the 3D sprite and sidebar avatar while this user is still selected.
        if (metadata.id) {
          const lazyIndex = index; // capture for stale-check
          const lazyParams = new URLSearchParams({
            where: JSON.stringify({ objectId: metadata.id }),
            keys: 'objectId,proPic,profilePicture',
            limit: '1',
          });
          fetch(`https://parseapi.back4app.com/classes/_User?${lazyParams}`, {
            headers: {
              'X-Parse-Application-Id': B4A_APP_ID,
              'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq',
            }
          })
          .then(r => r.json())
          .then(data => {
            const u = data.results && data.results[0];
            if (!u) return;
            const url = getProfilePictureUrl(u.proPic || u.profilePicture);
            if (!url) return;
            if (pointMetadata[lazyIndex]) pointMetadata[lazyIndex].profilePicture = url;
            if (selectedMemberIndex !== lazyIndex) return;
            const cachedForLazy = getCachedProfileBlobUrl(url);
            if (cachedForLazy) {
              if (avatar) { avatar.innerHTML = ''; avatar.classList.add('loading'); }
              const lazyImg = document.createElement('img');
              lazyImg.alt = username;
              if (avatar) avatar.appendChild(lazyImg);
              lazyImg.onload = () => { if (avatar) avatar.classList.remove('loading'); lazyImg.classList.add('loaded'); };
              lazyImg.src = cachedForLazy;
              createProfileSprite(cachedForLazy, username, lazyIndex);
            } else {
            fetch(getProfileImageFetchUrl(url) || url, { mode: 'cors' })
              .then(r => r.ok ? r.blob() : Promise.reject(r.status))
              .then(blob => {
                if (selectedMemberIndex !== lazyIndex) return;
                const blobUrl = setProfileImageCache(url, blob) || URL.createObjectURL(new Blob([blob], { type: 'image/jpeg' }));
                if (_currentProfileBlobUrl) URL.revokeObjectURL(_currentProfileBlobUrl);
                _currentProfileBlobUrl = blobUrl;
                if (avatar) { avatar.innerHTML = ''; avatar.classList.add('loading'); }
                const lazyImg = document.createElement('img');
                lazyImg.alt = username;
                if (avatar) avatar.appendChild(lazyImg);
                lazyImg.onload = () => { if (avatar) avatar.classList.remove('loading'); lazyImg.classList.add('loaded'); };
                lazyImg.onerror = () => { if (avatar) { avatar.classList.remove('loading'); avatar.innerHTML = ''; avatar.textContent = getInitials(username); } };
                lazyImg.src = blobUrl;
                createProfileSprite(blobUrl, username, lazyIndex);
              })
              .catch(() => {
                if (selectedMemberIndex !== lazyIndex) return;
                const cached = getCachedProfileBlobUrl(url);
                if (cached) {
                  if (avatar) { avatar.innerHTML = ''; avatar.classList.add('loading'); }
                  const lazyImg = document.createElement('img');
                  lazyImg.alt = username;
                  if (avatar) avatar.appendChild(lazyImg);
                  lazyImg.onload = () => { if (avatar) avatar.classList.remove('loading'); lazyImg.classList.add('loaded'); };
                  lazyImg.src = cached;
                  createProfileSprite(cached, username, lazyIndex);
                  return;
                }
                if (avatar) { avatar.innerHTML = ''; avatar.classList.add('loading'); }
                const lazyImg = document.createElement('img');
                lazyImg.alt = username;
                if (avatar) avatar.appendChild(lazyImg);
                loadImageWithBlobFallback(lazyImg, url, () => { if (avatar) avatar.classList.remove('loading'); lazyImg.classList.add('loaded'); }, () => { if (avatar) { avatar.classList.remove('loading'); avatar.innerHTML = ''; avatar.textContent = getInitials(username); } }, { forCanvas: false });
                createProfileSprite(url, username, lazyIndex);
              });
            }
          })
          .catch(() => { /* ignore */ });
        }
      }

      const setDetail = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
      setDetail('detail-id', metadata.id);
      setDetail('detail-username', `@${username}`);
      setDetail('detail-username-full', `@${username}`);

      // Safely handle position display (position can be null or have null x/y/z from feed)
      const pos = metadata.position;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number') {
        setDetail('detail-pos', `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
      } else {
        setDetail('detail-pos', 'N/A');
      }

      const riskSpan = document.getElementById('detail-risk');
      if (riskSpan) {
        riskSpan.textContent = `${metadata.risk}% (${metadata.riskLevel})`;
        riskSpan.className = `risk-${metadata.riskLevel}`;
      }

      // Show/hide risk explanation based on risk level
      const riskExplanation = document.getElementById('risk-explanation');
      const riskExplanationText = document.getElementById('risk-explanation-text');
      if (riskExplanation && riskExplanationText) {
        if (metadata.riskLevel === 'high') {
          const explanation = generateRiskExplanation(metadata);
          riskExplanationText.textContent = explanation;
          riskExplanation.style.display = 'block';
        } else {
          riskExplanation.style.display = 'none';
        }
      }

      setDetail('detail-activity', `${metadata.activity} posts/comments`);
      setDetail('detail-cluster', metadata.cluster);
      setDetail('detail-sobriety', metadata.sobrietyDays > 0
        ? `${metadata.sobrietyDays.toLocaleString()} days`
        : (metadata.sobrietyDate || metadata.sobriety ? '< 1 day' : 'Not set'));

      if (detailEl) detailEl.classList.add('visible');
      if (detailEl && window.innerWidth <= 768) {
        detailEl.classList.remove('detail-expanded');
      }

      setUrlForUser(metadata.id, metadata.username);

      // Unblur quickly (single rAF) so panel is interactive sooner
      if (alreadyOpen && detailEl) {
        requestAnimationFrame(() => {
          if (detailEl) detailEl.classList.remove('content-transitioning');
        });
      }

      // Defer heavy work so panel paint and next click can run first
      const PROFILE_PRIORITY_DELAY_MS = 400;
      const userIdForBeams = metadata.id;
      setTimeout(() => {
        loadUserPosts(metadata.id);
      }, PROFILE_PRIORITY_DELAY_MS);

      // Defer zoom and beams to next tick so panel paints and stays responsive to clicks
      setTimeout(() => {
        if (!points || !points.geometry || !points.geometry.attributes.position) return;
        const positions = points.geometry.attributes.position.array;
        if (selectedMemberIndex !== index || index * 3 + 2 >= positions.length) return;

        const targetPos = new THREE.Vector3(
          positions[index * 3],
          positions[index * 3 + 1],
          positions[index * 3 + 2]
        );

        const distToTarget = camera.position.distanceTo(targetPos);
        if (prevIndex === index && distToTarget <= 12) {
          drawConnectionLines(metadata.id);
          return;
        }

        const distToCenter = targetPos.length();
        const CAMERA_DISTANCE_FROM_MEMBER = 10 / 3;
        let endPos, endTarget;
        if (distToCenter < 0.01) {
          endPos = targetPos.clone().add(new THREE.Vector3(1, 1, 5 / 3));
          endTarget = targetPos.clone();
        } else {
          const dirFromCenter = targetPos.clone().normalize();
          endPos = targetPos.clone().add(dirFromCenter.multiplyScalar(CAMERA_DISTANCE_FROM_MEMBER));
          endTarget = targetPos.clone();
        }

        const fromGodView = options && options.fromGodView;
        const startPos = fromGodView
          ? new THREE.Vector3(GOD_VIEW_POSITION.x, GOD_VIEW_POSITION.y, GOD_VIEW_POSITION.z)
          : camera.position.clone();
        const startTarget = fromGodView
          ? new THREE.Vector3(GOD_VIEW_TARGET.x, GOD_VIEW_TARGET.y, GOD_VIEW_TARGET.z)
          : controls.target.clone();

        if (fromGodView) {
          camera.position.copy(startPos);
          controls.target.copy(startTarget);
          controls.update();
        }

        _isTraveling = true;
        if (fromGodView) {
          const startTime = performance.now();
          const animateZoom = () => {
            const elapsed = performance.now() - startTime;
            const tLinear = Math.min(1, elapsed / FLY_TO_USER_DURATION_MS);
            const t = 1 - Math.pow(1 - tLinear, 3);
            camera.position.lerpVectors(startPos, endPos, t);
            controls.target.lerpVectors(startTarget, endTarget, t);
            controls.update();
            if (t >= 1) {
              _isTraveling = false;
              drawConnectionLines(metadata.id);
              return;
            }
            requestAnimationFrame(animateZoom);
          };
          animateZoom();
        } else {
          let t = 0;
          const animateZoom = () => {
            t += 0.03;
            if (t > 1) t = 1;
            camera.position.lerpVectors(startPos, endPos, t);
            controls.target.lerpVectors(startTarget, endTarget, t);
            controls.update();
            if (t >= 1) {
              _isTraveling = false;
              drawConnectionLines(metadata.id);
              return;
            }
            requestAnimationFrame(animateZoom);
          };
          animateZoom();
        }
      }, 0);
    }

    function generateRiskExplanation(metadata) {
      const factors = [];

      // Low sobriety days
      if (metadata.sobrietyDays < 90) {
        factors.push('early recovery stage (under 90 days)');
      }

      // Low activity
      if (metadata.activity < 10) {
        factors.push('minimal community engagement');
      }

      // High risk score
      if (metadata.risk > 70) {
        factors.push('elevated risk indicators from behavior patterns');
      }

      // Default explanation if no specific factors
      if (factors.length === 0) {
        return 'This user shows multiple risk indicators that suggest they may benefit from additional support and monitoring.';
      }

      // Build explanation
      const factorList = factors.join(', ');
      return `This user is flagged as high risk due to ${factorList}. They may benefit from closer community support and outreach.`;
    }

    window.closeDetail = () => {
      const detailEl = document.getElementById('detail');
      detailEl.classList.remove('visible', 'detail-expanded');
      selectedMemberIndex = null;

      // Clear user from URL so root URL shows no selection
      setUrlForUser(null);

      // Clear selection halo
      if (points && points.material && points.material.uniforms) {
        points.material.uniforms.selectedIndex.value = -1.0;
      }

      // Remove orbiting post-planets
      clearOrbitingPosts();

      // Remove floating label and profile sprite
      clearSelectedOverlay();

      // Remove connection lines
      clearActiveConnectionLine();

      // Hide supporter cards
      const suppSec = document.getElementById('supporters-section');
      if (suppSec) suppSec.style.display = 'none';
    };

    function initDetailBottomSheet() {
      const detailEl = document.getElementById('detail');
      const handle = document.getElementById('detail-drag-handle');
      if (!detailEl || !handle) return;
      const MOBILE_BREAKPOINT = 768;
      let dragStartY = 0;
      let dragStartExpanded = false;
      let dragDidExpand = false;
      let dragDidCollapse = false;
      let dragDidClose = false;

      function isMobile() {
        return window.innerWidth <= MOBILE_BREAKPOINT;
      }

      handle.addEventListener('pointerdown', (e) => {
        if (!isMobile() || !detailEl.classList.contains('visible')) return;
        e.preventDefault();
        dragStartY = e.clientY;
        dragStartExpanded = detailEl.classList.contains('detail-expanded');
        dragDidExpand = false;
        dragDidCollapse = false;
        dragDidClose = false;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!isMobile() || !detailEl.classList.contains('visible')) return;
        const dy = e.clientY - dragStartY;
        if (dragStartExpanded) {
          if (dy > 25 && !dragDidCollapse) {
            detailEl.classList.remove('detail-expanded');
            dragDidCollapse = true;
          }
        } else {
          if (dy < -20 && !dragDidExpand) {
            detailEl.classList.add('detail-expanded');
            dragDidExpand = true;
          } else if (dy > 80 && !dragDidClose) {
            closeDetail();
            dragDidClose = true;
          }
        }
      });
      handle.addEventListener('pointerup', (e) => {
        handle.releasePointerCapture(e.pointerId);
      });

      detailEl.addEventListener('scroll', () => {
        if (!isMobile() || !detailEl.classList.contains('visible')) return;
        if (detailEl.classList.contains('detail-expanded') && detailEl.scrollTop <= 0) {
          detailEl.dataset.atTop = '1';
        } else {
          delete detailEl.dataset.atTop;
        }
        // Scroll up (content scrolling up) → expand to full screen
        if (!detailEl.classList.contains('detail-expanded') && detailEl.scrollTop > 40) {
          detailEl.classList.add('detail-expanded');
        }
      }, { passive: true });
      detailEl.addEventListener('touchstart', (e) => {
        if (!isMobile() || !detailEl.classList.contains('visible')) return;
        detailEl.dataset.touchStartY = e.touches[0].clientY;
        detailEl.dataset.touchStartScroll = String(detailEl.scrollTop);
      }, { passive: true });
      detailEl.addEventListener('touchmove', (e) => {
        if (!isMobile() || !detailEl.classList.contains('visible')) return;
        const atTop = detailEl.scrollTop <= 0;
        const startY = Number(detailEl.dataset.touchStartY);
        const dy = e.touches[0].clientY - startY;
        if (detailEl.classList.contains('detail-expanded')) {
          // At top + scroll down → minimize
          if (atTop && dy > 30) {
            detailEl.classList.remove('detail-expanded');
            detailEl.dataset.touchStartY = e.touches[0].clientY;
          }
        } else {
          // Scroll up from panel (e.g. drag up from handle or top) → expand to full screen
          if (dy < -35) {
            detailEl.classList.add('detail-expanded');
            detailEl.dataset.touchStartY = e.touches[0].clientY;
          } else if (atTop && dy > 60) closeDetail();
        }
      }, { passive: true });
    }
    initDetailBottomSheet();

    let currentSearchResults = [];
    let selectedSearchIndex = -1;

    let searchAbortController = null;

    // Actual search function (will be debounced)
    async function performSearch(query, dropdown) {
      const queryLower = query.toLowerCase();

      // Check cache first (version must match so we don't use stale profile picture shape)
      const cacheKey = queryLower;
      const cached = searchCache.get(cacheKey);
      if (cached && cached.version === SEARCH_CACHE_VERSION && (Date.now() - cached.timestamp) < SEARCH_CACHE_DURATION) {
        currentSearchResults = cached.results;
        selectedSearchIndex = -1;
        renderSearchResults(currentSearchResults, queryLower);
        dropdown.classList.add('visible');
        return;
      }

      // Cancel previous search
      if (searchAbortController) {
        searchAbortController.abort();
      }
      searchAbortController = new AbortController();

      // Keep existing results visible while loading — just add a subtle indicator
      // (don't blank the dropdown — keeps it populated on new search)
      if (currentSearchResults.length === 0) {
        dropdown.innerHTML = '<div style="padding: 12px; text-align: center; color: #999; font-size: 13px;">Searching…</div>';
        dropdown.classList.add('visible');
      } else {
        // Already showing results — add a faint "refreshing" indicator at the top
        const existing = dropdown.querySelector('.search-refreshing');
        if (!existing) {
          const indicator = document.createElement('div');
          indicator.className = 'search-refreshing';
          indicator.style.cssText = 'padding: 4px 16px; font-size: 11px; color: rgba(167,139,250,0.6); border-bottom: 1px solid rgba(255,255,255,0.04);';
          indicator.textContent = 'Updating…';
          dropdown.prepend(indicator);
        }
        dropdown.classList.add('visible');
      }

      try {
        // Search Back4App for members (use GET, order by TotalComments for engagement-based ranking)
        const params = new URLSearchParams({
          where: JSON.stringify({
            username: {
              $regex: queryLower,
              $options: 'i'
            }
          }),
          order: '-TotalComments',
          limit: '10',
          keys: 'username,objectId,proPic,profilePicture,sobrietyDate,TotalComments'
        });

        const response = await fetch(`https://parseapi.back4app.com/classes/_User?${params}`, {
          method: 'GET',
          headers: {
            'X-Parse-Application-Id': 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
            'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq'
          },
          signal: searchAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error('Search failed:', response.status, errorData);
          throw new Error(`Search failed: ${response.status} ${errorData.error || response.statusText}`);
        }

        const data = await response.json();
        const matches = data.results.map(member => {
          const id = member.objectId;
          const existingIndex = memberIndexMap.has(id) ? memberIndexMap.get(id) : -1;
          const fileObj = member.proPic || member.profilePicture;
          return {
            member: {
              id,
              username: member.username || 'Anonymous',
              profilePicture: fileObj || null,
              sobrietyDate: member.sobrietyDate?.iso ?? null,
              sobrietyDays: member.sobrietyDate?.iso
                ? Math.floor((Date.now() - new Date(member.sobrietyDate.iso).getTime()) / 86400000)
                : 0,
              cluster: 'Search Result',
              activity: 0,
              risk: 50,
              riskLevel: 'medium',
              totalComments: member.TotalComments || 0
            },
            index: existingIndex,
            isNew: existingIndex === -1
          };
        });

        // Sort by relevance: exact match > starts with > contains, then by TotalComments
        matches.sort((a, b) => {
          const usernameA = (a.member.username || '').toLowerCase();
          const usernameB = (b.member.username || '').toLowerCase();
          const query = queryLower;

          // Exact match priority
          const exactA = usernameA === query ? 3 : 0;
          const exactB = usernameB === query ? 3 : 0;
          if (exactA !== exactB) return exactB - exactA;

          // Starts with priority
          const startsA = usernameA.startsWith(query) ? 2 : 0;
          const startsB = usernameB.startsWith(query) ? 2 : 0;
          if (startsA !== startsB) return startsB - startsA;

          // Then by engagement (TotalComments descending)
          return (b.member.totalComments || 0) - (a.member.totalComments || 0);
        });

        currentSearchResults = matches;
        selectedSearchIndex = -1;

        // Cache the results (cap size so cache doesn't grow unbounded)
        while (searchCache.size >= SEARCH_CACHE_MAX) {
          const firstKey = searchCache.keys().next().value;
          if (firstKey == null) break;
          searchCache.delete(firstKey);
        }
        searchCache.set(queryLower, {
          results: matches,
          timestamp: Date.now(),
          version: SEARCH_CACHE_VERSION
        });

        if (currentSearchResults.length > 0) {
          renderSearchResults(currentSearchResults, queryLower);
          dropdown.classList.add('visible');
        } else {
          dropdown.innerHTML = '<div style="padding: 12px; text-align: center; color: #999; font-size: 13px;">No users found</div>';
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Search error:', error);
          // On error: keep previous results if available, just remove updating indicator
          const indicator = dropdown.querySelector('.search-refreshing');
          if (indicator) indicator.remove();
          if (currentSearchResults.length === 0) {
            dropdown.innerHTML = '<div style="padding: 12px; text-align: center; color: #ff4444; font-size: 13px;">Search error</div>';
          }
        }
      }
    }

    // Debounced search handler
    const debouncedSearch = debounce(performSearch, SEARCH_DEBOUNCE_DELAY);

    // Helper: retry loading an <img> via fetch+blob when direct src fails due to wrong
    // MIME type (e.g. images stored with _image.txt extension served as text/plain).
    // Fallback text is read from data-fallback attribute on the parent element to avoid
    // quote-escaping issues when embedding text in inline onerror handlers.
    window._imgBlobFallback = (imgEl) => {
      const url = imgEl.getAttribute('data-src') || imgEl.src;
      const fallbackText = imgEl.parentElement ? (imgEl.parentElement.getAttribute('data-fallback-text') || '') : '';
      const fallbackHtml = fallbackText ? `<div class="post-text">${fallbackText}</div>` : '';
      if (!url || imgEl._blobAttempted) { if (fallbackHtml) imgEl.outerHTML = fallbackHtml; return; }
      imgEl._blobAttempted = true;
      const fetchUrl = getParseFilesProxyUrl(url) || url;
      fetch(fetchUrl, { mode: 'cors' })
        .then(r => r.ok ? r.blob() : Promise.reject(r.status))
        .then(blob => {
          const objectUrl = URL.createObjectURL(new Blob([blob], { type: 'image/jpeg' }));
          imgEl.onload = () => {};
          imgEl.onerror = () => { URL.revokeObjectURL(objectUrl); if (fallbackHtml) imgEl.outerHTML = fallbackHtml; };
          imgEl.src = objectUrl;
        })
        .catch(() => { if (fallbackHtml) imgEl.outerHTML = fallbackHtml; });
    };

    /**
     * Load an image into an img element. Use forCanvas: true only when drawing to canvas (sprite, planets).
     * - forCanvas false (display only): no crossOrigin — image can load from CDNs that don't send CORS for GET.
     * - forCanvas true: crossOrigin anonymous + blob fallback for wrong MIME; required so canvas is not tainted.
     */
    function loadImageWithBlobFallback(img, url, onLoad, onError, options) {
      const forCanvas = options && options.forCanvas;
      if (!url) { if (onError) onError(); return; }
      const fetchUrl = (typeof getProfileImageFetchUrl === 'function' ? getProfileImageFetchUrl(url) : null) || url;
      if (forCanvas) img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (img._blobUrl) { URL.revokeObjectURL(img._blobUrl); img._blobUrl = null; }
        if (onLoad) onLoad();
      };
      img.onerror = () => {
        if (!forCanvas) { if (onError) onError(); return; }
        if (img._blobAttempted) { if (onError) onError(); return; }
        img._blobAttempted = true;
        fetch(fetchUrl, { mode: 'cors' })
          .then(r => r.ok ? r.blob() : Promise.reject(r.status))
          .then(blob => {
            const objectUrl = (typeof setProfileImageCache === 'function' && setProfileImageCache(url, blob)) || URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type: 'image/jpeg' }));
            img._blobUrl = objectUrl;
            img.onload = () => {
              if (img._blobUrl && (!profileImageCache || profileImageCache.get(url)?.blobUrl !== img._blobUrl)) URL.revokeObjectURL(img._blobUrl);
              img._blobUrl = null;
              if (onLoad) onLoad();
            };
            img.onerror = () => {
              if (img._blobUrl && (!profileImageCache || profileImageCache.get(url)?.blobUrl !== img._blobUrl)) URL.revokeObjectURL(img._blobUrl);
              img._blobUrl = null;
              if (onError) onError();
            };
            img.src = objectUrl;
          })
          .catch(() => { if (onError) onError(); });
      };
      img.src = forCanvas && fetchUrl !== url ? fetchUrl : url;
    }

    const B4A_APP_ID = 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by';
    const B4A_PARSEFILES_BASE = 'https://parsefiles.back4app.com/' + B4A_APP_ID + '/';
    const PARSEFILES_ORIGIN = 'https://parsefiles.back4app.com';

    /**
     * Rewrite Parse CDN URLs to same-origin proxy on localhost to avoid CORS (Parse CDN sends no Access-Control-Allow-Origin).
     * Use for every place we load images from parsefiles.back4app.com: profile pics, post grid/expanded, planet textures, blob fallbacks.
     * Rule: new code that sets img.src or fetch() for a Parse CDN URL must use this (or getProfileImageFetchUrl). See README "CORS and Parse CDN images".
     */
    function getParseFilesProxyUrl(url) {
      if (!url || typeof url !== 'string') return url;
      const origin = window.location.origin;
      const isLocal = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
      if (!isLocal || !url.startsWith(PARSEFILES_ORIGIN + '/')) return url;
      return '/parsefiles-proxy/' + url.slice((PARSEFILES_ORIGIN + '/').length);
    }

    function getProfileImageFetchUrl(url) {
      return getParseFilesProxyUrl(url) || url;
    }

    /** Shared profile image cache: URL -> { blobUrl, blob }. Blob URLs work for both <img> and canvas/sprite. */
    const PROFILE_IMAGE_CACHE_MAX = 80;
    const profileImageCache = new Map(); // url -> { blobUrl, blob }

    function getCachedProfileBlobUrl(url) {
      if (!url) return null;
      const entry = profileImageCache.get(url);
      if (!entry) return null;
      return entry.blobUrl;
    }

    function setProfileImageCache(url, blob) {
      if (!url || !blob) return null;
      const existing = profileImageCache.get(url);
      if (existing) return existing.blobUrl;
      while (profileImageCache.size >= PROFILE_IMAGE_CACHE_MAX) {
        const firstKey = profileImageCache.keys().next().value;
        const old = profileImageCache.get(firstKey);
        if (old && old.blobUrl) URL.revokeObjectURL(old.blobUrl);
        profileImageCache.delete(firstKey);
      }
      const blobUrl = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type: 'image/jpeg' }));
      profileImageCache.set(url, { blobUrl, blob });
      return blobUrl;
    }

    /** Get profile picture URL from Parse File (proPic/profilePicture). Prefer .url from the Parse file. */
    function getProfilePictureUrl(fileObj) {
      if (!fileObj) return null;
      if (typeof fileObj === 'string' && fileObj) return fileObj;
      if (fileObj && typeof fileObj === 'object') {
        if (fileObj.url) return fileObj.url;
        if (fileObj.uri) return fileObj.uri;
        if (fileObj.name) return B4A_PARSEFILES_BASE + encodeURIComponent(fileObj.name);
      }
      return null;
    }

    // Main search member function with keyboard navigation
    window.searchMember = async (event) => {
      const query = event.target.value.trim();
      const dropdown = document.getElementById('search-dropdown');

      // Handle keyboard navigation (don't debounce these)
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectedSearchIndex = Math.min(selectedSearchIndex + 1, currentSearchResults.length - 1);
        updateSearchSelection();
        return;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectedSearchIndex = Math.max(selectedSearchIndex - 1, -1);
        updateSearchSelection();
        return;
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (selectedSearchIndex >= 0 && currentSearchResults[selectedSearchIndex]) {
          await selectSearchResult(currentSearchResults[selectedSearchIndex]);
        } else if (currentSearchResults.length > 0) {
          await selectSearchResult(currentSearchResults[0]);
        }
        return;
      } else if (event.key === 'Escape') {
        dropdown.classList.remove('visible');
        event.target.blur();
        return;
      }

      // Filter members as user types
      if (query.length === 0) {
        dropdown.classList.remove('visible');
        currentSearchResults = [];
        clearTimeout(searchTimeout); // Cancel pending searches
        return;
      }

      if (query.length < 2) return; // Require at least 2 characters

      // Debounced search
      debouncedSearch(query, dropdown);
    };

    function renderSearchResults(results, query) {
      const dropdown = document.getElementById('search-dropdown');
      dropdown.innerHTML = results.map((result, idx) => {
        const { member, isNew } = result;
        const username = member.username || member.id;
        const initials = getInitials(username);

        const highlightedUsername = highlightText(username, query);
        const badge = isNew ? '<span style="font-size: 10px; color: #a78bfa; margin-left: 6px;">+ Add</span>' : '';

        return `
          <div class="search-result-item ${idx === selectedSearchIndex ? 'selected' : ''}"
               onclick="window.selectSearchResultByIndex(${idx})"
               data-index="${idx}">
            <div class="search-result-avatar loading" data-avatar-id="avatar-${idx}" data-user-id="${member.id}">
              ${initials}
            </div>
            <div class="search-result-info">
              <div class="search-result-username">@${highlightedUsername}${badge}</div>
              <div class="search-result-meta">
                ${member.sobrietyDays} days sober • ${member.totalComments || 0} comments
              </div>
            </div>
          </div>
        `;
      }).join('');

      // 1) Use search response URLs immediately (display-only, no CORS so CDN works).
      results.forEach((result, idx) => {
        const url = getProfilePictureUrl(result.member.profilePicture);
        const avatarId = `avatar-${idx}`;
        const username = result.member.username || result.member.id;
        if (url) loadAvatarImage(url, avatarId, username, result.member.id);
      });
      // 2) Batch-fetch full _User docs in parallel; fill in any that didn't load from search.
      fetchSearchResultProPicsBatch(results);
    }

    /** Batch fetch proPic; only update avatars that are still loading (no image loaded yet). */
    function fetchSearchResultProPicsBatch(results) {
      if (!results.length) return;
      const ids = results.map(r => r.member.id);
      const params = new URLSearchParams({
        where: JSON.stringify({ objectId: { $in: ids } }),
        limit: String(ids.length),
      });
      fetch(`https://parseapi.back4app.com/classes/_User?${params}`, {
        headers: {
          'X-Parse-Application-Id': B4A_APP_ID,
          'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq',
        },
      })
        .then(r => r.json())
        .then(data => {
          const picById = {};
          (data.results || []).forEach(u => {
            const url = getProfilePictureUrl(u.proPic || u.profilePicture);
            if (url) picById[u.objectId] = url;
          });
          results.forEach((result, idx) => {
            const userId = result.member.id;
            const username = result.member.username || result.member.id;
            const url = picById[userId];
            const avatar = document.querySelector(`[data-avatar-id="avatar-${idx}"][data-user-id="${userId}"]`);
            if (!avatar || !url) {
              if (avatar && !url) {
                avatar.classList.remove('loading');
                avatar.textContent = getInitials(username);
              }
              return;
            }
            if (!avatar.classList.contains('loading')) return;
            const img = avatar.querySelector('img.loaded');
            if (img) return;
            loadAvatarImage(url, `avatar-${idx}`, username, userId);
          });
        })
        .catch(() => {
          results.forEach((result, idx) => {
            const userId = result.member.id;
            const avatar = document.querySelector(`[data-avatar-id="avatar-${idx}"][data-user-id="${userId}"]`);
            if (avatar && avatar.classList.contains('loading') && !avatar.querySelector('img.loaded')) {
              avatar.classList.remove('loading');
              avatar.textContent = getInitials(result.member.username || result.member.id);
            }
          });
        });
    }

    function loadAvatarImage(src, avatarId, username, expectedUserId) {
      const selector = expectedUserId
        ? `[data-avatar-id="${avatarId}"][data-user-id="${expectedUserId}"]`
        : `[data-avatar-id="${avatarId}"]`;
      const avatar = document.querySelector(selector);
      if (!avatar) return;

      const imageUrl = getProfilePictureUrl(src) || (typeof src === 'string' ? src : null);

      if (!imageUrl) {
        avatar.classList.remove('loading');
        avatar.textContent = getInitials(username);
        return;
      }

      avatar.querySelectorAll('img').forEach(el => el.remove());
      const img = document.createElement('img');
      img.alt = username;
      avatar.appendChild(img);
      const checkStale = () => {
        if (expectedUserId && avatar.getAttribute('data-user-id') !== expectedUserId) return true;
        return false;
      };
      loadImageWithBlobFallback(img, imageUrl,
        () => {
          if (checkStale()) return;
          avatar.classList.remove('loading');
          img.classList.add('loaded');
        },
        () => {
          if (checkStale()) return;
          avatar.classList.remove('loading');
          avatar.textContent = getInitials(username);
        },
        { forCanvas: false }
      );
    }

    function highlightText(text, query) {
      if (!query) return text;
      const regex = new RegExp(`(${query})`, 'gi');
      return text.replace(regex, '<span class="search-result-highlight">$1</span>');
    }

    function getInitials(name) {
      return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    }

    function updateSearchSelection() {
      const items = document.querySelectorAll('.search-result-item');
      items.forEach((item, idx) => {
        if (idx === selectedSearchIndex) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          item.classList.remove('selected');
        }
      });
    }

    // Helper function to select search result by index (called from onclick)
    window.selectSearchResultByIndex = async function(index) {
      if (currentSearchResults && currentSearchResults[index]) {
        await selectSearchResult(currentSearchResults[index]);
      }
    };

    async function selectSearchResult(result) {
      const dropdown = document.getElementById('search-dropdown');
      const searchInput = document.querySelector('#search input');
      if (dropdown) dropdown.classList.remove('visible');
      if (searchInput) searchInput.value = '';

      let indexToFlash = -1;
      if (result.isNew) {
        indexToFlash = await addMemberToUniverse(result.member);
      } else {
        // Resolve index at click time (universe may have loaded since search ran)
        const id = result.member && result.member.id;
        const resolvedIndex = (id != null && memberIndexMap.has(id)) ? memberIndexMap.get(id) : result.index;
        if (resolvedIndex >= 0 && resolvedIndex < pointMetadata.length) {
          const meta = pointMetadata[resolvedIndex];
          if (meta && !meta.profilePicture && result.member.profilePicture) {
            meta.profilePicture = result.member.profilePicture;
          }
          indexToFlash = resolvedIndex;
        }
      }
      if (indexToFlash >= 0 && pointMetadata[indexToFlash]) {
        flashPoint(indexToFlash);
      } else if (result.isNew) {
        console.warn('[Search] Universe not ready — could not add user. Try again after the scene has loaded.');
      }
    }

    async function addMemberToUniverse(member) {
      if (!points || !points.geometry) {
        console.warn('[Search] Points not initialized — cannot add user to universe yet.');
        return undefined;
      }

      // Generate random position in the universe
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 30 + Math.random() * 40;

      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      // Get current arrays
      const oldPositions = points.geometry.attributes.position.array;
      const oldColors = points.geometry.attributes.color.array;
      const oldSizes = points.geometry.attributes.size.array;
      const oldActivities = points.geometry.attributes.activity.array;
      const oldVertexIndices = points.geometry.attributes.vertexIndex.array;

      const newIndex = oldPositions.length / 3;

      // Create new larger arrays
      const newPositions = new Float32Array(oldPositions.length + 3);
      const newColors = new Float32Array(oldColors.length + 3);
      const newSizes = new Float32Array(oldSizes.length + 1);
      const newActivities = new Float32Array(oldActivities.length + 1);
      const newVertexIndices = new Float32Array(oldVertexIndices.length + 1);

      // Copy old data
      newPositions.set(oldPositions);
      newColors.set(oldColors);
      newSizes.set(oldSizes);
      newActivities.set(oldActivities);
      newVertexIndices.set(oldVertexIndices);

      // Add new member
      newPositions[newIndex * 3] = x;
      newPositions[newIndex * 3 + 1] = y;
      newPositions[newIndex * 3 + 2] = z;

      // Color based on risk
      const risk = member.risk / 100 || 0.5;
      if (risk < 0.33) {
        newColors[newIndex * 3] = 0;
        newColors[newIndex * 3 + 1] = risk * 3;
        newColors[newIndex * 3 + 2] = 1;
      } else if (risk < 0.66) {
        const t = (risk - 0.33) * 3;
        newColors[newIndex * 3] = t;
        newColors[newIndex * 3 + 1] = 1;
        newColors[newIndex * 3 + 2] = 1 - t;
      } else {
        const t = (risk - 0.66) * 3;
        newColors[newIndex * 3] = 1;
        newColors[newIndex * 3 + 1] = 1 - t;
        newColors[newIndex * 3 + 2] = 0;
      }

      newSizes[newIndex] = 2 + Math.log(member.activity + 1) * 0.5;
      newActivities[newIndex] = Math.min(member.activity / 100, 1);
      newVertexIndices[newIndex] = newIndex;

      // Update geometry
      points.geometry.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
      points.geometry.setAttribute('color', new THREE.BufferAttribute(newColors, 3));
      points.geometry.setAttribute('size', new THREE.BufferAttribute(newSizes, 1));
      points.geometry.setAttribute('activity', new THREE.BufferAttribute(newActivities, 1));
      points.geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(newVertexIndices, 1));

      // Add to metadata
      pointMetadata.push({
        ...member,
        position: { x, y, z }
      });

      // Register in memberIndexMap so planets orbit at the right position
      memberIndexMap.set(member.id, newIndex);
      loadedMemberIds.add(member.id);
      const un = (member.username && String(member.username).trim()) ? String(member.username).trim().toLowerCase() : '';
      if (un && un !== 'anonymous' && !/^user\d+$/.test(un)) {
        usernameToIndexMap.set(un, newIndex);
      }

      console.log(`Added ${member.username} at index ${newIndex}`);
      return newIndex;
    }

    function timeAgo(iso) {
      if (!iso) return '';
      const diff = Date.now() - new Date(iso).getTime();
      const s = Math.floor(diff / 1000);
      if (s < 60)  return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60)  return m + 'm ago';
      const h = Math.floor(m / 60);
      if (h < 24)  return h + 'h ago';
      const d = Math.floor(h / 24);
      if (d < 30)  return d + 'd ago';
      const mo = Math.floor(d / 30);
      if (mo < 12) return mo + 'mo ago';
      return Math.floor(mo / 12) + 'y ago';
    }

    // Planet texture cache: postId → THREE.CanvasTexture (avoids re-fetching on re-select)
    const _planetTextureCache = new Map();

    function _makePlanetCanvas(size, hue) {
      // Solid colored circle — used as placeholder while image loads
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const cx = size / 2;
      ctx.clearRect(0, 0, size, size);
      // Glow: dim in the inner 2/3 (where the image will sit), bright only in outer ring
      const grd = ctx.createRadialGradient(cx, cx, cx * 0.1, cx, cx, cx);
      grd.addColorStop(0,    `hsla(${hue},60%,30%,0.3)`);  // dark centre — won't wash image
      grd.addColorStop(0.55, `hsla(${hue},70%,40%,0.5)`);  // transition at 2/3 boundary
      grd.addColorStop(0.7,  `hsla(${hue},85%,65%,0.9)`);  // bright outer ring starts
      grd.addColorStop(1.0,  `hsla(${hue},70%,30%,0.0)`);  // fade to transparent edge
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cx, cx, 0, Math.PI * 2);
      ctx.fill();
      return c;
    }

    function _makePlanetTextureFromImage(imgUrl, size, hue, sprite) {
      // Load post image async; update sprite texture when ready
      // No crossOrigin — Back4App CDN doesn't always send CORS headers; without it
      // the image loads from cache and canvas draw succeeds. THREE.CanvasTexture
      // doesn't need readPixels so a tainted canvas is fine.
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = size;
          const ctx = c.getContext('2d');
          const cx = size / 2;

          // 1. Draw planet glow background — dim centre so image is clearly visible
          const grd = ctx.createRadialGradient(cx, cx, cx * 0.1, cx, cx, cx);
          grd.addColorStop(0,    `hsla(${hue},60%,30%,0.3)`);
          grd.addColorStop(0.55, `hsla(${hue},70%,40%,0.5)`);
          grd.addColorStop(0.7,  `hsla(${hue},85%,65%,0.9)`);
          grd.addColorStop(1.0,  `hsla(${hue},70%,30%,0.0)`);
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(cx, cx, cx, 0, Math.PI * 2);
          ctx.fill();

          // 2. Draw image inset (clipped to inner 2/3 radius circle), cover-fit
          ctx.save();
          const imgR = cx * (2 / 3);
          ctx.beginPath();
          ctx.arc(cx, cx, imgR, 0, Math.PI * 2);
          ctx.clip();
          const ar = img.width / img.height;
          const diam = imgR * 2;
          let sw = diam, sh = diam;
          if (ar > 1) { sw = diam * ar; } else { sh = diam / ar; }
          ctx.drawImage(img, cx - sw / 2, cx - sh / 2, sw, sh);
          ctx.restore();

          // 3. White ring border between glow and image
          ctx.strokeStyle = 'rgba(255,255,255,0.60)';
          ctx.lineWidth = size * 0.04;
          ctx.beginPath();
          ctx.arc(cx, cx, imgR, 0, Math.PI * 2);
          ctx.stroke();

          if (sprite && sprite.material) {
            try { ctx.getImageData(0, 0, 1, 1); } catch(taintErr) { return; }
            const oldMap = sprite.material.map;
            if (oldMap) { oldMap.dispose(); }
            const tex = new THREE.CanvasTexture(c);
            sprite.material.map = tex;
            sprite.material.needsUpdate = true;
          }
        } catch(e) { /* canvas draw error — keep placeholder glow */ }
      };
      img.onerror = () => {}; // keep placeholder on error
      img.src = getParseFilesProxyUrl(imgUrl) || imgUrl;
    }

    let _dbgEvents = []; // ring buffer of events for HUD display
    function _dbgLog(msg) {
      const t = (performance.now()/1000).toFixed(1);
      _dbgEvents.push(t + ' ' + msg);
      if (_dbgEvents.length > 12) _dbgEvents.shift();
      console.warn('[DBG] ' + t + ' ' + msg);
    }

    function clearOrbitingPosts() {
      _dbgLog('clearOrbitingPosts had=' + (orbitingPosts ? orbitingPosts.children.length : 'null') + ' host=' + orbitHostId);
      if (orbitingPosts) {
        // LOD: dispose overflow Points if present (single mesh for planets beyond sprite tier)
        const overflow = orbitingPosts.userData.overflowPoints;
        if (overflow) {
          if (overflow.geometry) overflow.geometry.dispose();
          if (overflow.material) {
            if (overflow.material.map) overflow.material.map.dispose();
            overflow.material.dispose();
          }
          orbitingPosts.remove(overflow);
          orbitingPosts.userData.overflowPoints = null;
        }
        orbitingPosts.userData.numPlanetSprites = 0;
        // Sprites (full-detail planets)
        orbitingPosts.children.slice().forEach(s => {
          if (s.material) {
            if (s.material.map) s.material.map.dispose();
            s.material.dispose();
          }
          orbitingPosts.remove(s);
        });
        scene.remove(orbitingPosts);
        orbitingPosts = null;
      }
      orbitData = [];
      orbitHostId = null;
      selectedPlanetIndex = -1;
    }

    function spawnOrbitingPosts(userId, postCount, postCommentCounts, postIds, postDates, postImages) {
      _dbgLog('spawnOrbitingPosts userId=' + userId + ' n=' + postCount);
      clearOrbitingPosts();
      if (!points || postCount === 0) return;

      // LOD: no cap — show all planets (sprites for first N, rest as one Points mesh)
      const count = postCount;
      const numSprites = Math.min(count, PLANET_SPRITE_LOD);
      orbitHostId = userId;

      // Order posts by creation date: earliest first → inner orbits, newest → outer
      const orderIndices = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
        const ta = postDates && postDates[a] ? new Date(postDates[a]).getTime() : 0;
        const tb = postDates && postDates[b] ? new Date(postDates[b]).getTime() : 0;
        return ta - tb;
      });

      // ── Compute max safe orbit radius (half distance to nearest neighbour) ──
      // This prevents planets from drifting closer to a different star than the host.
      let maxSafeRadius = 2.5; // default fallback (world units)
      const hostIndex = memberIndexMap.get(userId);
      if (hostIndex !== undefined && points.geometry) {
        const posArr = points.geometry.attributes.position.array;
        const hx = posArr[hostIndex * 3];
        const hy = posArr[hostIndex * 3 + 1];
        const hz = posArr[hostIndex * 3 + 2];
        let nearestDist = Infinity;
        const total = points.geometry.attributes.position.count;
        // Sample up to 2000 stars to find nearest — avoid O(N²) on large datasets
        const step = Math.max(1, Math.floor(total / 2000));
        for (let j = 0; j < total; j += step) {
          if (j === hostIndex) continue;
          const dx = posArr[j * 3] - hx;
          const dy = posArr[j * 3 + 1] - hy;
          const dz = posArr[j * 3 + 2] - hz;
          const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (d < nearestDist) nearestDist = d;
        }
        if (nearestDist < Infinity) {
          maxSafeRadius = nearestDist * 0.55; // stay within 55% of way to nearest star (planets further out)
        }
      }
      // Cap at 2.8 world units — allows larger orbits, planets further from stars
      maxSafeRadius = Math.min(maxSafeRadius, 2.8);

      // ── Fixed world-space planet size cap ──────────────────────────────────────
      // Planet sizes are fixed in world space so they look correct at any zoom level.
      // Basing size on star's data-driven `size` attribute (0–1 from activity/engagement)
      // rather than camera-distance-dependent LOD math, which caused planets spawned
      // from far away to be tiny when zoomed in (and vice versa).
      // Hard cap: 0.18 world units diameter — big enough to see, small enough to orbit neatly.
      const starSizeAttr = (hostIndex !== undefined && points.geometry)
        ? (points.geometry.attributes.size.array[hostIndex] || 1)
        : 1;
      // Scale: star size attribute typically 1–20; map to 0.25–0.55 world units planet max.
      // Planets are fixed world-space size so they look correct at any zoom level.
      const maxPlanetSize = Math.min(0.25 + starSizeAttr * 0.015, 0.55);
      // Also expose starWorldRadius as a fixed estimate for orbit gap calculations
      const starWorldRadius = maxPlanetSize * 0.8; // rough host star radius estimate

      // ── Pre-compute planet sizes and non-overlapping orbit radii ──────────────
      // Planet sprites are billboards — their world-space "radius" is wSize/2.
      // To prevent planet-planet overlap: consecutive orbit shells must be at
      // least (wSize_a/2 + wSize_b/2) apart (sum of radii).
      // To prevent planet-star overlap: innermost orbit must be > wSize/2 away
      // from host (which sits at r=0 in orbit space).
      // To prevent planet reaching other stars: orbit + wSize/2 < maxSafeRadius.
      const planetSizes = [];
      for (let i = 0; i < count; i++) {
        const idx = orderIndices[i];
        const cc = (postCommentCounts && postCommentCounts[idx]) || 0;
        // Base size 0.18 world units; grows with comment count up to maxPlanetSize cap
        const rawSize = 0.18 + Math.log(cc + 1) * 0.04;
        planetSizes.push(Math.min(rawSize, maxPlanetSize));
      }

      // Build orbit radii greedily: start from innermost safe position,
      // step outward by enough to clear the previous planet and the current one.
      const orbitRadii = [];
      const HOST_STAR_R = starWorldRadius; // use actual star world radius
      let r = HOST_STAR_R + planetSizes[0] / 2 + 0.15; // first orbit clears star with more padding
      for (let i = 0; i < count; i++) {
        const ps = planetSizes[i];
        // Ensure this planet clears the previous planet
        if (i > 0) {
          const prevEdge = orbitRadii[i - 1] + planetSizes[i - 1] / 2;
          r = Math.max(r, prevEdge + ps / 2 + 0.04);
        }
        // Cap: planet outer edge must not exceed safe boundary
        const rCapped = Math.min(r, maxSafeRadius - ps / 2);
        orbitRadii.push(rCapped);
        r = rCapped + ps / 2; // advance for next iteration
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Group holds sprites (LOD tier 1) and optionally one Points mesh (LOD tier 2)
      orbitingPosts = new THREE.Group();
      orbitingPosts.frustumCulled = false;
      orbitingPosts.renderOrder = 10;
      orbitingPosts.visible = true;
      orbitingPosts.userData.numPlanetSprites = numSprites;
      scene.add(orbitingPosts);

      const CANVAS_SIZE = 256;
      const GOLDEN = Math.PI * (3 - Math.sqrt(5));

      const deferredImageLoads = [];

      for (let i = 0; i < count; i++) {
        const idx = orderIndices[i];
        const hue   = 30 + (i * 37) % 60;
        const wSize = planetSizes[i];

        // Orbit params for all (used by sprites and by overflow Points)
        const t = count > 1 ? i / (count - 1) : 0;
        const radius = orbitRadii[i];
        orbitData.push({
          angle:    i * GOLDEN,
          speed:    0.04 - t * 0.015,
          radius,
          tiltX:    (i * 0.9) % Math.PI,
          tiltZ:    (i * 1.4) % Math.PI,
          postId:   postIds   ? postIds[idx]   : null,
          createdAt: postDates ? postDates[idx] : null,
        });

        // LOD: full sprites only for first PLANET_SPRITE_LOD; rest drawn as Points below
        if (i >= numSprites) continue;

        const canvas  = _makePlanetCanvas(CANVAS_SIZE, hue);
        const texture = new THREE.CanvasTexture(canvas);

        const mat = new THREE.SpriteMaterial({
          map:         texture,
          transparent: true,
          depthWrite:  false,
          depthTest:   false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 10;
        sprite.scale.set(wSize, wSize, 1);
        sprite.frustumCulled = false;
        sprite.userData = { index: i, postId: postIds ? postIds[idx] : null, _baseScale: wSize };
        orbitingPosts.add(sprite);

        const imgUrl = postImages && postImages[idx];
        if (imgUrl) {
          deferredImageLoads.push({ imgUrl, hue, sprite });
        }
      }

      // LOD tier 2: one Points mesh for planets beyond sprite count (single draw call)
      if (count > numSprites) {
        const overflowCount = count - numSprites;
        const geo = new THREE.BufferGeometry();
        const posArr = new Float32Array(overflowCount * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        geo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);

        const dotCanvas = _makePlanetCanvas(64, 45);
        const dotTexture = new THREE.CanvasTexture(dotCanvas);

        const pointsMat = new THREE.PointsMaterial({
          size: 0.12,
          map: dotTexture,
          transparent: false,
          depthTest: false,
          depthWrite: false,
          sizeAttenuation: true,
        });
        const overflowPoints = new THREE.Points(geo, pointsMat);
        overflowPoints.renderOrder = 10;
        overflowPoints.frustumCulled = false;
        orbitingPosts.add(overflowPoints);
        orbitingPosts.userData.overflowPoints = overflowPoints;
      }

      // Planet image batches: start after profile picture has had time to load (prioritize profile pic).
      const BATCH_SIZE = 4;
      const PLANET_IMAGE_DELAY_MS = 450;
      function _runImageBatch(startIdx) {
        if (startIdx >= deferredImageLoads.length) return;
        const batch = deferredImageLoads.slice(startIdx, startIdx + BATCH_SIZE);
        let remaining = batch.length;
        const onDone = () => { remaining--; if (remaining === 0) _runImageBatch(startIdx + BATCH_SIZE); };
        batch.forEach(({ imgUrl, hue, sprite }) => {
          const fetchUrl = getParseFilesProxyUrl(imgUrl) || imgUrl;
          // Helper: given a loaded Image, draw it onto a canvas sprite
          const drawToSprite = (img, objectUrl) => {
            try {
              const c = document.createElement('canvas');
              c.width = c.height = CANVAS_SIZE;
              const ctx = c.getContext('2d');
              const cx = CANVAS_SIZE / 2;
              const grd = ctx.createRadialGradient(cx, cx, cx * 0.1, cx, cx, cx);
              grd.addColorStop(0,    `hsla(${hue},60%,30%,0.3)`);
              grd.addColorStop(0.55, `hsla(${hue},70%,40%,0.5)`);
              grd.addColorStop(0.7,  `hsla(${hue},85%,65%,0.9)`);
              grd.addColorStop(1.0,  `hsla(${hue},70%,30%,0.0)`);
              ctx.fillStyle = grd;
              ctx.beginPath();
              ctx.arc(cx, cx, cx, 0, Math.PI * 2);
              ctx.fill();
              ctx.save();
              const imgR = cx * (2 / 3);
              ctx.beginPath();
              ctx.arc(cx, cx, imgR, 0, Math.PI * 2);
              ctx.clip();
              const ar = img.width / img.height;
              const diam = imgR * 2;
              let sw = diam, sh = diam;
              if (ar > 1) { sw = diam * ar; } else { sh = diam / ar; }
              ctx.drawImage(img, cx - sw / 2, cx - sh / 2, sw, sh);
              ctx.restore();
              ctx.strokeStyle = 'rgba(255,255,255,0.60)';
              ctx.lineWidth = CANVAS_SIZE * 0.04;
              ctx.beginPath();
              ctx.arc(cx, cx, imgR, 0, Math.PI * 2);
              ctx.stroke();
              if (sprite && sprite.material && sprite.parent === orbitingPosts) {
                const oldMap = sprite.material.map;
                if (oldMap) oldMap.dispose();
                const tex = new THREE.CanvasTexture(c);
                tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
                sprite.material.map = tex;
                sprite.material.needsUpdate = true;
              }
            } catch(e) { /* canvas draw error — keep placeholder */ }
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            onDone();
          };

          // Fetch via blob to force image MIME type — handles wrong extensions (e.g. _image.txt)
          fetch(fetchUrl, { mode: 'cors' })
            .then(r => r.ok ? r.blob() : Promise.reject(r.status))
            .then(blob => {
              const img = new Image();
              function tryType(mime) {
                const objectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
                img.onload = () => drawToSprite(img, objectUrl);
                img.onerror = () => {
                  URL.revokeObjectURL(objectUrl);
                  if (mime === 'image/jpeg') tryType('image/png');
                  else onDone();
                };
                img.src = objectUrl;
              }
              tryType('image/jpeg');
            })
            .catch(() => {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => drawToSprite(img, null);
              img.onerror = () => onDone();
              img.src = fetchUrl;
            });
        });
      }
      setTimeout(() => _runImageBatch(0), PLANET_IMAGE_DELAY_MS);
    }

    let _loadingPostsForUser = null; // guard against concurrent fetches for same user
    const MAX_POSTS_FETCH = 250;       // cap fetch for members with huge post counts (performance)
    const POST_GRID_INITIAL = 48;      // show this many in grid first; "Load more" for the rest
    const POST_GRID_LOAD_MORE = 48;
    let _postsAbortController = null;
    let _currentPostsForGrid = null;
    let _currentPostsUserId = null;
    let _postsGridShownCount = POST_GRID_INITIAL;

    function buildPostItemHTML(post, userId) {
      let mediaUrl = typeof post.image === 'string' ? post.image : (post.image && post.image.url) ? post.image.url : null;
      const mediaUrlForSrc = getParseFilesProxyUrl(mediaUrl) || mediaUrl;
      const hasMedia = mediaUrl && mediaUrl.length > 0;
      const text = (post.content || '').slice(0, 100).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      if (hasMedia) {
        return `<div class="post-item loading" data-post-id="${post.objectId}" data-fallback-text="${text}" onclick="expandPost('${post.objectId}', '${userId}')"><img src="${mediaUrlForSrc}" data-src="${mediaUrl}" crossorigin="anonymous" alt="Post" onload="this.classList.add('loaded'); this.parentElement.classList.remove('loading');" onerror="_imgBlobFallback(this)" /></div>`;
      }
      return `<div class="post-item" data-post-id="${post.objectId}" onclick="expandPost('${post.objectId}', '${userId}')"><div class="post-text">${text || '(no text)'}</div></div>`;
    }

    async function loadUserPosts(userId) {
      _dbgLog('loadUserPosts userId=' + userId + ' host=' + orbitHostId + ' loadingFor=' + _loadingPostsForUser);
      // If planets are already showing for this user, don't re-spawn them
      if (orbitHostId === userId && orbitingPosts && orbitingPosts.children.length > 0) { _dbgLog('loadUserPosts: GUARD-already-showing'); return; }
      // Prevent duplicate concurrent fetches for same user
      if (_loadingPostsForUser === userId) { _dbgLog('loadUserPosts: GUARD-already-loading'); return; }

      const postsGrid = document.getElementById('posts-grid');

      // Use per-user cache when valid — fewer API calls while navigating
      const cachedPosts = postCacheByUser.get(userId);
      if (cachedPosts && (Date.now() - cachedPosts.timestamp < POST_CACHE_TTL_MS)) {
        const allResults = cachedPosts.posts;
        if (allResults.length === 0) {
          postsGrid.innerHTML = '<div class="posts-loading">No posts yet</div>';
          updateDetailPlanetsCount(userId, 0);
          return;
        }
        allResults.forEach((p) => {
          const id = p.objectId;
          if (!id) return;
          const creator = p.creator?.objectId || p.creator || userId;
          postDataCache.set(id, { creator, content: p.content || '', commentCount: p.commentCount || 0, created: p.createdAt || p.created, image: typeof p.image === 'string' ? p.image : (p.image && typeof p.image === 'object' && p.image.url) ? p.image.url : null });
        });
        const postCommentCounts = allResults.map(p => p.commentCount || 0);
        const postIds = allResults.map(p => p.objectId);
        const postDates = allResults.map(p => p.createdAt || null);
        const postImages = allResults.map(p => (typeof p.image === 'string' && p.image) ? p.image : (p.image && typeof p.image === 'object' && p.image.url) ? p.image.url : null);
        spawnOrbitingPosts(userId, allResults.length, postCommentCounts, postIds, postDates, postImages);
        _currentPostsForGrid = allResults;
        _currentPostsUserId = userId;
        _postsGridShownCount = POST_GRID_INITIAL;
        const initial = allResults.slice(0, POST_GRID_INITIAL);
        const cappedMsg = cachedPosts.capped ? `<p class="posts-capped-msg">Showing first ${allResults.length} posts</p>` : '';
        const loadMoreBtn = allResults.length > POST_GRID_INITIAL
          ? `<div class="posts-load-more-wrap"><button type="button" class="btn btn-secondary posts-load-more-btn" data-user-id="${userId}">Load more posts</button></div>` : '';
        postsGrid.innerHTML = cappedMsg + initial.map((p) => buildPostItemHTML(p, userId)).join('') + loadMoreBtn;
        updateDetailPlanetsCount(userId, allResults.length);
        return;
      }

      _loadingPostsForUser = userId;
      postsGrid.innerHTML = '<div class="posts-loading">Loading posts...</div>';

      if (_postsAbortController) _postsAbortController.abort();
      const aborter = new AbortController();
      _postsAbortController = aborter;

      try {
        // Fetch user's posts from Back4App in chunks so we can load more than 100.
        const POST_HEADERS = {
          'X-Parse-Application-Id': 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
          'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq'
        };
        const POST_PAGE_SIZE = 40;
        const keys = 'objectId,content,image,createdAt,commentCount';
        const wherePointer = { creator: { __type: 'Pointer', className: '_User', objectId: userId } };
        const wherePlain = { creator: userId };

        const fetchPage = async (skip, usePointer) => {
          if (aborter.signal.aborted) return null;
          const where = usePointer ? wherePointer : wherePlain;
          const params = new URLSearchParams({
            where: JSON.stringify(where),
            order: '-createdAt',
            limit: String(POST_PAGE_SIZE),
            skip: String(skip),
            keys,
          });
          const response = await fetch(`https://parseapi.back4app.com/classes/post?${params}`, {
            method: 'GET', headers: POST_HEADERS, signal: aborter.signal
          });
          if (!response.ok) return null;
          return response.json();
        };

        let allResults = [];
        let skip = 0;
        let usePointer = true;
        let postsCapped = false;

        while (true) {
          if (selectedMemberIndex == null || !pointMetadata[selectedMemberIndex] || pointMetadata[selectedMemberIndex].id !== userId) {
            aborter.abort();
            return;
          }
          let data = await fetchPage(skip, usePointer);
          if (aborter.signal.aborted) return;
          if (!data || !data.results) {
            if (skip === 0 && usePointer) {
              usePointer = false;
              continue;
            }
            if (skip === 0) {
              console.error('Post loading failed for user', userId);
              throw new Error('Failed to load posts');
            }
            break;
          }
          const page = data.results;
          allResults = allResults.concat(page);
          if (allResults.length >= MAX_POSTS_FETCH) {
            postsCapped = true;
            allResults = allResults.slice(0, MAX_POSTS_FETCH);
            break;
          }
          updateDetailPlanetsCount(userId, allResults.length);
          if (page.length < POST_PAGE_SIZE) {
            // If first page was empty with Pointer query, try plain creator fallback (same as original)
            if (skip === 0 && page.length === 0 && usePointer) {
              usePointer = false;
              continue;
            }
            break;
          }
          skip += page.length;
        }

        if (allResults.length === 0) {
          postsGrid.innerHTML = '<div class="posts-loading">No posts yet</div>';
          updateDetailPlanetsCount(userId, 0);
          return;
        }

        // Cache for this user so revisiting doesn't trigger API calls while navigating
        evictPostCachesIfNeeded();
        postCacheByUser.set(userId, { posts: allResults, timestamp: Date.now(), capped: postsCapped });

        // Feed posts into codec cache so next evolve() has better mass/post counts (see README "Codec, beams, and planets")
        allResults.forEach((p) => {
          const id = p.objectId;
          if (!id) return;
          const creator = p.creator?.objectId || p.creator || userId;
          postDataCache.set(id, {
            creator,
            content: p.content || '',
            commentCount: p.commentCount || 0,
            created: p.createdAt || p.created,
            image: typeof p.image === 'string' ? p.image : (p.image && typeof p.image === 'object' && p.image.url) ? p.image.url : null,
          });
        });

        // Spawn orbiting planet for each post; pass per-post comment counts, ids, dates, images
        const postCommentCounts = allResults.map(p => p.commentCount || 0);
        const postIds   = allResults.map(p => p.objectId);
        const postDates = allResults.map(p => p.createdAt || null);
        const postImages = allResults.map(p => {
          if (typeof p.image === 'string' && p.image) return p.image;
          if (p.image && typeof p.image === 'object' && p.image.url) return p.image.url;
          return null;
        });
        spawnOrbitingPosts(userId, allResults.length, postCommentCounts, postIds, postDates, postImages);

        // Render posts grid: initial slice only + "Load more" for big lists (performance for members with many posts)
        _currentPostsForGrid = allResults;
        _currentPostsUserId = userId;
        _postsGridShownCount = POST_GRID_INITIAL;
        const initialPosts = allResults.slice(0, POST_GRID_INITIAL);
        const cappedMsg = postsCapped ? `<p class="posts-capped-msg">Showing first ${allResults.length} posts</p>` : '';
        const loadMoreBtn = allResults.length > POST_GRID_INITIAL
          ? `<div class="posts-load-more-wrap"><button type="button" class="btn btn-secondary posts-load-more-btn" data-user-id="${userId}">Load more posts</button></div>` : '';
        postsGrid.innerHTML = cappedMsg + initialPosts.map((p) => buildPostItemHTML(p, userId)).join('') + loadMoreBtn;

      } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Error loading posts:', error);
        postsGrid.innerHTML = '<div class="posts-loading">Failed to load posts</div>';
      } finally {
        if (_loadingPostsForUser === userId) _loadingPostsForUser = null;
      }
    }

    // Expand post view — show panel immediately so click feels instant, then load data
    window.expandPost = async (postId, userId) => {
      const expandedView = document.getElementById('post-expanded');
      const imageEl = document.getElementById('post-expanded-image');
      const textEl = document.getElementById('post-expanded-text');
      const metaEl = document.getElementById('post-expanded-meta');

      expandedView.classList.add('visible');
      expandedView.scrollTop = 0;
      imageEl.style.display = 'none';
      textEl.textContent = 'Loading…';
      metaEl.textContent = '';
      const commentsList = document.getElementById('post-comments-list');
      if (commentsList) commentsList.innerHTML = '<div class="comments-loading">Loading…</div>';

      // Fetch in background so main thread stays responsive
      try {
        const params = new URLSearchParams({
          where: JSON.stringify({ objectId: postId }),
          keys: 'objectId,content,image,createdAt,commentCount,creator'
        });

        const response = await fetch(`https://parseapi.back4app.com/classes/post?${params}`, {
          method: 'GET',
          headers: {
            'X-Parse-Application-Id': 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
            'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq'
          }
        });

        if (!response.ok) {
          throw new Error('Failed to load post');
        }

        const data = await response.json();
        const post = data.results[0];

        if (!post) {
          throw new Error('Post not found');
        }

        // Display image if available
        let mediaUrl = null;
        if (typeof post.image === 'string') {
          mediaUrl = post.image;
        } else if (post.image && typeof post.image === 'object' && post.image.url) {
          mediaUrl = post.image.url;
        }

        if (mediaUrl) {
          const fetchUrl = getParseFilesProxyUrl(mediaUrl) || mediaUrl;
          const displayUrl = getParseFilesProxyUrl(mediaUrl) || mediaUrl;
          fetch(fetchUrl, { mode: 'cors' })
            .then(r => r.ok ? r.blob() : Promise.reject(r.status))
            .then(blob => {
              function tryType(mime) {
                const objectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
                const prev = imageEl._blobUrl;
                if (prev) URL.revokeObjectURL(prev);
                imageEl._blobUrl = objectUrl;
                imageEl.onerror = () => {
                  URL.revokeObjectURL(objectUrl);
                  if (mime === 'image/jpeg') tryType('image/png');
                  else imageEl.src = displayUrl;
                };
                imageEl.src = objectUrl;
              }
              tryType('image/jpeg');
            })
            .catch(() => { imageEl.src = displayUrl; });
          imageEl.style.display = 'block';
        } else {
          imageEl.style.display = 'none';
        }

        // Display text content
        textEl.textContent = post.content || '';

        // Display metadata
        const date = new Date(post.createdAt);
        const dateStr = date.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric'
        });
        metaEl.innerHTML = `
          <div>${dateStr}</div>
          <div>${post.commentCount || 0} comments</div>
        `;

        // Load comments
        await loadPostComments(postId);

      } catch (error) {
        console.error('Error loading post:', error);
        textEl.textContent = 'Failed to load post';
      }
    };

    // Load comments for a post
    async function loadPostComments(postId) {
      const commentsList = document.getElementById('post-comments-list');
      const commentCount = document.getElementById('comment-count');

      commentsList.innerHTML = '<div class="comments-loading">Loading comments...</div>';

      try {
        // Fetch comments with include=user to expand the user Pointer inline.
        // 'username' is also denormalized on the comment itself as a fallback.
        // 'post' is a plain string field (not a Pointer) so where clause uses raw string.
        const params = new URLSearchParams({
          where: JSON.stringify({ post: postId }),
          order: '-createdAt',
          limit: '100',
          keys: 'objectId,content,createdAt,username,user,user.username,user.proPic',
          include: 'user'
        });

        const response = await fetch(`https://parseapi.back4app.com/classes/comment?${params}`, {
          method: 'GET',
          headers: {
            'X-Parse-Application-Id': 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
            'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq'
          }
        });

        if (!response.ok) {
          throw new Error('Failed to load comments');
        }

        const data = await response.json();

        if (data.results.length === 0) {
          commentsList.innerHTML = '<div class="comments-loading">No comments yet</div>';
          commentCount.textContent = '';
          return;
        }

        commentCount.textContent = `(${data.results.length})`;

        // Render — user is expanded inline; fall back to denormalized username on comment
        commentsList.innerHTML = data.results.map(comment => {
          const userObj = (comment.user && comment.user.__type !== 'Pointer') ? comment.user : {};
          const username = userObj.username || comment.username || 'Anonymous';
          const initials = getInitials(username);

          // Handle profile picture (string or Parse File object)
          let profilePicUrl = null;
          if (typeof userObj.proPic === 'string') {
            profilePicUrl = userObj.proPic;
          } else if (userObj.proPic && typeof userObj.proPic === 'object' && userObj.proPic.url) {
            profilePicUrl = userObj.proPic.url;
          }

          const date = new Date(comment.createdAt);
          const dateStr = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
          });

          return `
            <div class="comment-item">
              <div class="comment-avatar">
                ${profilePicUrl
                  ? `<img src="${profilePicUrl}" crossorigin="anonymous" alt="${username}" />`
                  : initials
                }
              </div>
              <div class="comment-content">
                <div class="comment-header">
                  <span class="comment-username">@${username}</span>
                  <span class="comment-date">${dateStr}</span>
                </div>
                <div class="comment-text">${comment.content || ''}</div>
              </div>
            </div>
          `;
        }).join('');

      } catch (error) {
        console.error('Error loading comments:', error);
        commentsList.innerHTML = '<div class="comments-loading">Failed to load comments</div>';
      }
    }

    // Close expanded post view
    window.closeExpandedPost = () => {
      const expandedView = document.getElementById('post-expanded');
      expandedView.classList.remove('visible');
    };

    window.showSearchDropdown = () => {
      // Trigger search when input is focused
      const searchInput = document.querySelector('#search input');
      const event = { target: searchInput, key: '' };
      searchMember(event);
    };

    // Close dropdown when clicking outside
    document.addEventListener('click', (event) => {
      const searchContainer = document.getElementById('search');
      const dropdown = document.getElementById('search-dropdown');
      if (!searchContainer.contains(event.target)) {
        dropdown.classList.remove('visible');
      }
    });

    // Draw glowing connection lines from a user to everyone they've commented to
    function clearActiveConnectionLine() {
      if (activeConnectionLine) {
        const batches = activeConnectionLine.batches;
        if (batches) {
          batches.forEach((b) => {
            (b.allSegments || []).forEach((ls) => {
              scene.remove(ls);
              if (ls.geometry) ls.geometry.dispose();
              // Do not dispose material — beams share beamLayerMaterials
            });
          });
        } else {
          (activeConnectionLine.allSegments || []).forEach((ls) => {
            scene.remove(ls);
            if (ls.geometry) ls.geometry.dispose();
          });
        }
        activeConnectionLine = null;
      }
    }

    // In-memory cache: loaded comment/engagement data per user so we don't re-fetch. Also used to train codec.
    const BEAM_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour — fewer API calls when revisiting members while navigating
    const BEAM_CACHE_MAX = 12;                  // LRU cap — keep low so FPS stays good after many navigations
    const POST_CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour — per-user post cache so revisiting doesn't refetch
    const POST_CACHE_BY_USER_MAX = 10;          // cap per-user post cache entries
    const POST_DATA_CACHE_MAX = 2000;           // cap total post metadata (postId -> {...})
    const beamDataCache = new Map(); // userId -> { engagementCount, postCreatorMap, commentsForCodec, timestamp }
    window.getBeamCommentCacheForCodec = () => beamDataCache; // so load job can merge into state.comments

    function evictBeamCacheIfNeeded() {
      if (beamDataCache.size < BEAM_CACHE_MAX) return;
      let oldestKey = null;
      let oldestTs = Infinity;
      beamDataCache.forEach((val, key) => {
        const ts = val && val.timestamp != null ? val.timestamp : 0;
        if (ts < oldestTs) { oldestTs = ts; oldestKey = key; }
      });
      if (oldestKey != null) beamDataCache.delete(oldestKey);
    }

    // On-demand loaded posts (planets) — merged into state.posts by load job so codec gets better mass/post counts
    const postDataCache = new Map(); // postId -> { creator, content, commentCount, created, image }
    window.getPostCacheForCodec = () => postDataCache;
    // Per-user post cache: fewer API calls when navigating back to same member
    const postCacheByUser = new Map(); // userId -> { posts: Array, timestamp }
    function evictPostCachesIfNeeded() {
      while (postCacheByUser.size >= POST_CACHE_BY_USER_MAX) {
        let oldestKey = null;
        let oldestTs = Infinity;
        postCacheByUser.forEach((val, key) => {
          const ts = val && val.timestamp != null ? val.timestamp : 0;
          if (ts < oldestTs) { oldestTs = ts; oldestKey = key; }
        });
        if (oldestKey == null) break;
        const removed = postCacheByUser.get(oldestKey);
        postCacheByUser.delete(oldestKey);
        if (removed && Array.isArray(removed.posts)) {
          removed.posts.forEach((p) => {
            const id = p && (p.objectId || p.id);
            if (id) postDataCache.delete(id);
          });
        }
      }
      while (postDataCache.size > POST_DATA_CACHE_MAX) {
        const firstKey = postDataCache.keys().next().value;
        if (firstKey == null) break;
        postDataCache.delete(firstKey);
      }
    }

    function parseId(val) {
      if (!val) return null;
      if (typeof val === 'string') return val;
      if (typeof val === 'object' && val.objectId) return val.objectId;
      return null;
    }

    // Shared beam materials (3 layers) — created once, uniforms updated once per frame for performance
    let beamLayerMaterials = null;

    function getBeamLayerMaterials() {
      if (beamLayerMaterials) return beamLayerMaterials;
      const beamVert = `
        attribute float aStrength;
        varying float vLineDist;
        varying float vStrength;
        void main() {
          vLineDist = float(gl_VertexID) * 0.5;
          vStrength = aStrength;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `;
      const beamFrag = `
        uniform float time;
        uniform float fadeIn;
        uniform float baseAlpha;
        uniform float colScale;
        varying float vLineDist;
        varying float vStrength;
        void main() {
          float pulse = sin(vLineDist * 6.0 - time * 1.2) * 0.5 + 0.5;
          float thickMult = 1.0 + vStrength * 1.5;
          float alpha = (0.55 + pulse * 0.18) * baseAlpha * thickMult * fadeIn;
          vec3 col = mix(vec3(0.62, 0.45, 1.0), vec3(0.78, 0.65, 1.0), pulse * 0.5) * colScale;
          col = mix(col, vec3(0.90, 0.80, 1.0), vStrength * 0.4);
          gl_FragColor = vec4(col, alpha);
        }
      `;
      const layers = [
        { baseAlpha: 0.12, colScale: 0.65 },
        { baseAlpha: 0.30, colScale: 0.82 },
        { baseAlpha: 0.90, colScale: 1.00 },
      ];
      beamLayerMaterials = layers.map(({ baseAlpha, colScale }) => new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          fadeIn: { value: 0 },
          baseAlpha: { value: baseAlpha },
          colScale: { value: colScale },
        },
        vertexShader: beamVert,
        fragmentShader: beamFrag,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }));
      return beamLayerMaterials;
    }

    /** Create one batch of beam segments (3 layers) and add to scene. Returns { lineSegments, allSegments, targetIndices }. */
    function addOneBeamBatch(sourceIndex, targetPairsBatch, maxCountForStrength, beamStartTime) {
      if (targetPairsBatch.length === 0) return null;
      const vertBuf = new Float32Array(targetPairsBatch.length * 6);
      const strengthArr = new Float32Array(targetPairsBatch.length * 2);
      const maxCount = Math.max(maxCountForStrength, 1);
      targetPairsBatch.forEach(({ count }, i) => {
        const s = Math.log(1 + count) / Math.log(1 + maxCount);
        strengthArr[i * 2] = s;
        strengthArr[i * 2 + 1] = s;
      });
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(vertBuf, 3));
      lineGeo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
      lineGeo.setAttribute('aStrength', new THREE.BufferAttribute(strengthArr, 1));
      const materials = getBeamLayerMaterials();
      const allSegments = [];
      let lineSegments = null;
      materials.forEach((mat, layerIdx) => {
        const geo = layerIdx === 0 ? lineGeo : (() => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(vertBuf, 3));
          g.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
          g.setAttribute('aStrength', new THREE.BufferAttribute(strengthArr.slice(), 1));
          return g;
        })();
        const ls = new THREE.LineSegments(geo, mat);
        scene.add(ls);
        allSegments.push(ls);
        if (layerIdx === materials.length - 1) lineSegments = ls;
      });
      const targetIndices = targetPairsBatch.map((p) => p.idx);
      return { lineSegments, allSegments, targetIndices, lineGeo, vertBuf };
    }

    // Helper: fill a supporter card bg element with a profile image (or leave initials)
    function _setSupporterCardBgImage(bg, imageUrl, username) {
      bg.innerHTML = '';
      const initials = (username.replace(/^@/,'').slice(0,2)).toUpperCase();
      if (imageUrl) {
        const img = document.createElement('img');
        img.alt = username;
        bg.appendChild(img);
        loadImageWithBlobFallback(img, imageUrl,
          () => {},
          () => {
            img.remove();
            const initDiv = document.createElement('div');
            initDiv.className = 'supporter-card-initials';
            initDiv.textContent = initials;
            bg.appendChild(initDiv);
          },
          { forCanvas: false }
        );
      } else {
        const initDiv = document.createElement('div');
        initDiv.className = 'supporter-card-initials';
        initDiv.textContent = initials;
        bg.appendChild(initDiv);
      }
    }

    function renderSupporterCards(engagementCount, currentUserId) {
      const section = document.getElementById('supporters-section');
      if (!section) return;

      // Sort by engagement count descending, take top 3
      const sorted = Object.entries(engagementCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      if (sorted.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'block';
      const container = document.getElementById('supporter-cards-container');
      container.innerHTML = '';

      // Portrait playing card layout: cards fanned/spread left→right
      // Card 0 = top supporter (front, centre); 1 = left; 2 = right
      // Offsets: translateX centres cards within the container (cards are 100px wide)
      const containerWidth = container.offsetWidth || 220;
      const cardW = 100;
      // Fan spread: card 0 front, 1 tilted left behind, 2 tilted right behind
      const layouts = [
        { x: containerWidth / 2 - cardW / 2, rotate:  0, scale: 1.00, z: 3 }, // front/centre
        { x: containerWidth / 2 - cardW / 2 - 32, rotate: -8, scale: 0.93, z: 2 }, // left behind
        { x: containerWidth / 2 - cardW / 2 + 32, rotate:  8, scale: 0.93, z: 1 }, // right behind
      ];

      // Collect IDs that need a proPic fetch (no profilePicture in metadata yet)
      const needsFetch = [];

      sorted.forEach(([targetId, count], i) => {
        const meta = pointMetadata[memberIndexMap.get(targetId)];
        const username = meta ? (meta.username || meta.id) : targetId;
        const imageUrl = meta ? getProfilePictureUrl(meta.profilePicture) : null;

        const layout = layouts[i] || layouts[0];

        const card = document.createElement('div');
        card.className = 'supporter-card';
        card.setAttribute('data-member-id', targetId);
        card.style.zIndex = layout.z;
        card.style.transform = `translateX(${layout.x}px) translateX(-50%) rotate(${layout.rotate}deg) scale(${layout.scale})`;
        card.style.left = '0';
        card.onclick = () => {
          const idx = memberIndexMap.get(targetId);
          if (idx !== undefined) flashPoint(idx);
        };

        // Background layer — profile image fills the card
        const bg = document.createElement('div');
        bg.className = 'supporter-card-bg';
        _setSupporterCardBgImage(bg, imageUrl, username);

        // If no image yet, queue a lazy fetch for this user's proPic
        if (!imageUrl) {
          needsFetch.push({ targetId, username, bg });
        }

        // Gradient overlay for readability
        const overlay = document.createElement('div');
        overlay.className = 'supporter-card-overlay';

        // Username label at bottom
        const label = document.createElement('div');
        label.className = 'supporter-card-label';
        label.innerHTML = `
          <span class="supporter-card-name">@${username}</span>
          <span class="supporter-card-count">${count}×</span>
        `;

        card.appendChild(bg);
        card.appendChild(overlay);
        card.appendChild(label);
        container.appendChild(card);
      });

      // Lazy-fetch proPic for any supporter whose metadata lacks a profile picture.
      // Batch all missing IDs into one request.
      if (needsFetch.length > 0) {
        const missingIds = needsFetch.map(e => e.targetId);
        const params = new URLSearchParams({
          where: JSON.stringify({ objectId: { $in: missingIds } }),
          keys: 'objectId,username,proPic,profilePicture',
          limit: String(missingIds.length),
        });
        fetch(`https://parseapi.back4app.com/classes/_User?${params}`, {
          headers: {
            'X-Parse-Application-Id': B4A_APP_ID,
            'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq',
          }
        })
        .then(r => r.json())
        .then(data => {
          if (!data.results) return;
          const picMap = {};
          data.results.forEach(u => {
            const url = getProfilePictureUrl(u.proPic || u.profilePicture);
            if (url) picMap[u.objectId] = url;
          });
          // Update metadata + swap card bg images
          needsFetch.forEach(({ targetId, username, bg }) => {
            const url = picMap[targetId];
            if (!url) return;
            // Cache it in pointMetadata so future renders don't need to re-fetch
            const idx = memberIndexMap.get(targetId);
            if (idx !== undefined && pointMetadata[idx]) {
              pointMetadata[idx].profilePicture = url;
            }
            // Swap initials for real image — only if this card bg is still in the DOM
            if (bg.isConnected) {
              _setSupporterCardBgImage(bg, url, username);
            }
          });
        })
        .catch(() => { /* silently ignore — initials remain */ });
      }
    }

    const COMMENT_PAGE_SIZE = 150;   // small pages so first beams show quickly
    const COMMENT_PAGE_SIZE_LARGE = 400; // larger pages once we have many (fewer round trips for 20K users)
    const MAX_COMMENTS = 15000;
    const POST_CHUNK = 40;           // smaller post batches for better performance / lower latency
    const BEAM_BATCH_SIZE = 28;      // add this many new beams per page while loading (then merge to one); smaller = less per-frame work

    // Planet LOD: first N get full sprites (with images); the rest are drawn as one Points mesh (no cap on total)
    const PLANET_SPRITE_LOD = 80;    // full-detail sprites so most planets can load images; beyond this use points
    // Beam LOD: draw top N strongest connections; full comment count still shown in UI.
    // Tuned for FPS: lower caps and aggressive throttle when many beams (see animate()).
    const MAX_BEAM_SEGMENTS = 56;   // max beams when connection count is low
    function getBeamSegmentCap(uniqueTargetCount) {
      if (uniqueTargetCount <= 80) return 56;
      if (uniqueTargetCount <= 250) return 44;
      if (uniqueTargetCount <= 800) return 36;
      if (uniqueTargetCount <= 4000) return 28;
      return 24; // 20K+ comments: draw only top 24 for smooth FPS
    }

    async function drawConnectionLines(userId) {
      if (!points || !points.geometry || !points.geometry.attributes.position) return;

      const sourceIndex = memberIndexMap.get(userId);
      if (sourceIndex === undefined) return;

      const snapshotSelectedIndex = selectedMemberIndex;
      clearActiveConnectionLine();

      const HEADERS = {
        'X-Parse-Application-Id': 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
        'X-Parse-REST-API-Key': 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq'
      };

      function stale() {
        return selectedMemberIndex !== snapshotSelectedIndex;
      }

      try {
        let engagementCount = {};
        let postCreatorMap = {};
        let allComments = [];
        const cached = beamDataCache.get(userId);
        const useCache = cached && (Date.now() - cached.timestamp < BEAM_CACHE_TTL_MS);

        if (useCache) {
          engagementCount = cached.engagementCount || {};
          postCreatorMap = cached.postCreatorMap || {};
          allComments = cached.rawComments || [];
          if (!stale()) updateDetailBeamsCount(userId, allComments.length);
        } else {
          // Fetch comments in pages; add beams incrementally each page (LOD-capped), then merge to one at end.
          let lastCreatedAt = null;
          let keepFetching = true;
          let commentCreatorQuery = { creator: { __type: 'Pointer', className: '_User', objectId: userId } };
          let usedPointerQuery = true;
          const drawnTargetIds = new Set();
          let beamStartTime = null;
          let maxCountSoFar = 1;

          function resolveMemberIdx(id) {
            let idx = memberIndexMap.get(id);
            if (idx !== undefined) return idx;
            try { idx = memberIndexMap.get(decodeURIComponent(id)); } catch (e) {}
            return idx;
          }

          while (keepFetching) {
            const pageSize = allComments.length >= 2000 ? COMMENT_PAGE_SIZE_LARGE : COMMENT_PAGE_SIZE;
            const where = lastCreatedAt
              ? { $and: [commentCreatorQuery, { createdAt: { $gt: { __type: 'Date', iso: lastCreatedAt } } }] }
              : commentCreatorQuery;
            const p = new URLSearchParams({
              where: JSON.stringify(where),
              limit: String(pageSize),
              keys: 'creator,post,createdAt',
              order: 'createdAt',
            });
            const resp = await fetch(`https://parseapi.back4app.com/classes/comment?${p}`, { method: 'GET', headers: HEADERS });
            if (!resp.ok) break;
            const data = await resp.json();
            if ((!data.results || data.results.length === 0) && usedPointerQuery && !lastCreatedAt) {
              commentCreatorQuery = { creator: userId };
              usedPointerQuery = false;
              continue;
            }
            if (!data.results || data.results.length === 0) break;
            allComments = allComments.concat(data.results);
            const last = data.results[data.results.length - 1];
            lastCreatedAt = (last && last.createdAt && last.createdAt.iso) ? last.createdAt.iso : (last && last.createdAt);
            if (!lastCreatedAt || data.results.length < pageSize) keepFetching = false;
            if (allComments.length >= MAX_COMMENTS) keepFetching = false;

            // Post IDs from this page only (to keep requests small)
            const pagePostIds = [...new Set(data.results.map(c => parseId(c.post)).filter(Boolean))];
            if (pagePostIds.length > 0) {
              for (let pi = 0; pi < pagePostIds.length; pi += POST_CHUNK) {
                const chunk = pagePostIds.slice(pi, pi + POST_CHUNK);
                const pp = new URLSearchParams({
                  where: JSON.stringify({ objectId: { $in: chunk } }),
                  keys: 'objectId,creator',
                  limit: String(chunk.length),
                });
                const r = await fetch(`https://parseapi.back4app.com/classes/post?${pp}`, { method: 'GET', headers: HEADERS });
                if (!r.ok) continue;
                const j = await r.json();
                (j.results || []).forEach((p) => {
                  const creatorId = parseId(p.creator);
                  if (p.objectId && creatorId) postCreatorMap[p.objectId] = creatorId;
                });
              }
            }
            // Recompute engagement from all comments we have so far
            engagementCount = {};
            allComments.forEach((c) => {
              const postId = parseId(c.post);
              const creatorId = postId ? postCreatorMap[postId] : null;
              if (creatorId && creatorId !== userId) {
                engagementCount[creatorId] = (engagementCount[creatorId] || 0) + 1;
              }
            });

            if (!stale()) {
              const now = Date.now();
              if (now - _lastDetailBeamsCountUpdate >= DETAIL_COUNTER_THROTTLE_MS) {
                _lastDetailBeamsCountUpdate = now;
                updateDetailBeamsCount(userId, allComments.length);
              }
            }

            // Add another batch of beams this page (LOD-capped; new targets only) so more beams load as data arrives
            const targetPairs = Object.keys(engagementCount)
              .map((id) => ({ id, idx: resolveMemberIdx(id), count: engagementCount[id] }))
              .filter((p) => p.idx !== undefined)
              .sort((a, b) => b.count - a.count);
            const segmentCap = getBeamSegmentCap(targetPairs.length);
            const targetPairsCapped = targetPairs.slice(0, segmentCap);
            const toDraw = targetPairsCapped.filter((p) => !drawnTargetIds.has(p.id)).slice(0, BEAM_BATCH_SIZE);
            toDraw.forEach((p) => drawnTargetIds.add(p.id));
            maxCountSoFar = Math.max(maxCountSoFar, ...targetPairs.map((x) => x.count), 1);

            if (toDraw.length > 0 && !stale()) {
              if (!beamStartTime) beamStartTime = performance.now();
              const batch = addOneBeamBatch(sourceIndex, toDraw, maxCountSoFar, beamStartTime);
              if (batch) {
                if (!activeConnectionLine) {
                  activeConnectionLine = { sourceIndex, beamStartTime, batches: [] };
                }
                activeConnectionLine.batches.push(batch);
                updateConnectionLinePositions(); // merges when batches.length > 1
              }
            }
          }

          if (allComments.length === 0) return;
          if (!stale()) updateDetailBeamsCount(userId, allComments.length);
        }

        if (stale()) {
          _dbgLog('BEAMS-STALE discarding userId=' + userId);
          return;
        }

        // If engagementCount empty but we have comments (e.g. stale cache), recompute from allComments
        if (Object.keys(engagementCount).length === 0 && allComments.length > 0 && postCreatorMap) {
          engagementCount = {};
          allComments.forEach((c) => {
            const postId = parseId(c.post);
            const creatorId = postId ? postCreatorMap[postId] : null;
            if (creatorId && creatorId !== userId) {
              engagementCount[creatorId] = (engagementCount[creatorId] || 0) + 1;
            }
          });
        }

        // Render supporter cards from final engagement
        renderSupporterCards(engagementCount, userId);

        // Resolve member index (try raw id and decoded in case of encoding mismatch)
        function resolveMemberIdx(id) {
          let idx = memberIndexMap.get(id);
          if (idx !== undefined) return idx;
          try { idx = memberIndexMap.get(decodeURIComponent(id)); } catch (e) {}
          return idx;
        }

        // Final beam draw: when using cache we draw once here; when uncached we already drew incrementally in the loop.
        const targetPairs = Object.keys(engagementCount)
          .map((id) => ({ id, idx: resolveMemberIdx(id), count: engagementCount[id] }))
          .filter((p) => p.idx !== undefined)
          .sort((a, b) => b.count - a.count);
        const segmentCap = getBeamSegmentCap(targetPairs.length);
        const targetPairsToDraw = targetPairs.slice(0, segmentCap);
        const maxCount = Math.max(...targetPairsToDraw.map((p) => p.count), 1);
        if (targetPairsToDraw.length > 0 && !stale()) {
          const haveBeamsAlready = activeConnectionLine && activeConnectionLine.batches && activeConnectionLine.batches.length > 0;
          if (useCache || !haveBeamsAlready) {
            clearActiveConnectionLine();
            const beamStartTime = performance.now();
            const batch = addOneBeamBatch(sourceIndex, targetPairsToDraw, maxCount, beamStartTime);
            if (batch) {
              activeConnectionLine = { sourceIndex, beamStartTime, batches: [batch] };
              updateConnectionLinePositions();
            }
          }
          // uncached with beams already: we added incrementally in the loop; merge already happened in updateConnectionLinePositions
        }

        // Cache for next time and for codec (so it doesn't have to load again)
        const commentsForCodec = allComments.map((c) => {
          const postId = parseId(c.post);
          const toMember = postId ? postCreatorMap[postId] : null;
          return toMember && toMember !== userId ? { fromMember: userId, toMember, postId } : null;
        }).filter(Boolean);
        evictBeamCacheIfNeeded();
        beamDataCache.set(userId, {
          engagementCount,
          postCreatorMap,
          rawComments: allComments,
          commentsForCodec,
          timestamp: Date.now(),
        });

      } catch (err) {
        console.warn('drawConnectionLines error:', err);
      }
    }

    /** Merge multiple beam batches into one (3 LineSegments total) to reduce draw calls. */
    function mergeBeamBatches() {
      if (!activeConnectionLine || !points) return;
      const batches = activeConnectionLine.batches;
      if (!batches || batches.length <= 1) return;
      const posArr = points.geometry.attributes.position.array;
      const sourceIndex = activeConnectionLine.sourceIndex;
      const sx = posArr[sourceIndex * 3];
      const sy = posArr[sourceIndex * 3 + 1];
      const sz = posArr[sourceIndex * 3 + 2];

      const mergedTargetIndices = batches.flatMap((b) => b.targetIndices);
      const totalSegments = mergedTargetIndices.length;
      const mergedPos = new Float32Array(totalSegments * 6);
      const mergedStrength = new Float32Array(totalSegments * 2);
      let strengthOffset = 0;
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const geom = batch.lineSegments && batch.lineSegments.geometry;
        if (geom && geom.attributes && geom.attributes.aStrength) {
          const arr = geom.attributes.aStrength.array;
          mergedStrength.set(arr, strengthOffset);
          strengthOffset += arr.length;
        }
      }
      for (let i = 0; i < mergedTargetIndices.length; i++) {
        const ti = mergedTargetIndices[i];
        const o = i * 6;
        mergedPos[o]     = sx; mergedPos[o + 1] = sy; mergedPos[o + 2] = sz;
        mergedPos[o + 3] = posArr[ti * 3];
        mergedPos[o + 4] = posArr[ti * 3 + 1];
        mergedPos[o + 5] = posArr[ti * 3 + 2];
      }

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
      lineGeo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
      lineGeo.setAttribute('aStrength', new THREE.BufferAttribute(mergedStrength, 1));
      const materials = getBeamLayerMaterials();
      const allSegments = [];
      let lineSegments = null;
      materials.forEach((mat, layerIdx) => {
        const geo = layerIdx === 0 ? lineGeo : (() => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
          g.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
          g.setAttribute('aStrength', new THREE.BufferAttribute(mergedStrength.slice(), 1));
          return g;
        })();
        const ls = new THREE.LineSegments(geo, mat);
        scene.add(ls);
        allSegments.push(ls);
        if (layerIdx === materials.length - 1) lineSegments = ls;
      });

      batches.forEach((batch) => {
        (batch.allSegments || []).forEach((ls) => {
          scene.remove(ls);
          if (ls.geometry) ls.geometry.dispose();
        });
      });
      activeConnectionLine.batches = [{
        lineSegments,
        allSegments,
        targetIndices: mergedTargetIndices,
        lineGeo,
        vertBuf: mergedPos,
      }];
    }

    // Called every frame in animate() to keep lines glued to moving stars (throttled when many beams)
    function updateConnectionLinePositions() {
      if (!activeConnectionLine || !points) return;
      let batches = activeConnectionLine.batches;
      if (!batches || batches.length === 0) return;
      if (batches.length > 1) {
        mergeBeamBatches();
        batches = activeConnectionLine.batches;
      }
      const posArr = points.geometry.attributes.position.array;
      const sourceIndex = activeConnectionLine.sourceIndex;
      const beamStartTime = activeConnectionLine.beamStartTime;
      const sx = posArr[sourceIndex * 3];
      const sy = posArr[sourceIndex * 3 + 1];
      const sz = posArr[sourceIndex * 3 + 2];
      const fadeIn = beamStartTime ? Math.min(1, (performance.now() - beamStartTime) / 600) : 1;
      const t = performance.now() / 1000;

      // Update shared beam materials once per frame (all batches use the same 3 materials)
      // Pause beam pulse animation while user is navigating to keep FPS up
      if (beamLayerMaterials) {
        beamLayerMaterials.forEach((mat) => {
          if (mat.uniforms) {
            if (!_isNavigating) mat.uniforms.time.value = t;
            mat.uniforms.fadeIn.value = fadeIn;
          }
        });
      }

      for (let b = 0; b < batches.length; b++) {
        const { lineSegments, allSegments, targetIndices } = batches[b];
        if (!lineSegments || !lineSegments.geometry || !allSegments) continue;
        const buf = lineSegments.geometry.attributes.position.array;
        for (let i = 0; i < targetIndices.length; i++) {
          const ti = targetIndices[i];
          const o = i * 6;
          buf[o]     = sx; buf[o + 1] = sy; buf[o + 2] = sz;
          buf[o + 3] = posArr[ti * 3];
          buf[o + 4] = posArr[ti * 3 + 1];
          buf[o + 5] = posArr[ti * 3 + 2];
        }
        allSegments.forEach(ls => {
          if (ls && ls.geometry && ls.geometry.attributes && ls.geometry.attributes.position) {
            ls.geometry.attributes.position.needsUpdate = true;
          }
        });
      }
    }

    // Kept for the clear-connections button; also clears active line
    window.clearConnectionLines = function clearConnectionLines() {
      clearActiveConnectionLine();
      connectionLines.clear(); // stub map — always empty now
      const clearBtn = document.getElementById('clear-connections-btn');
      if (clearBtn) clearBtn.style.display = 'none';
    }

    let _animateRafId = null;
    let _sceneDisposed = false;
    function animate() {
      _animateRafId = requestAnimationFrame(animate);
      if (_sceneDisposed || !renderer || !scene || !camera) return;

      // Update FPS and stats (throttle DOM writes: FPS/memory every 1s, draws every 500ms)
      frameCount++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        fps = frameCount;
        frameCount = 0;
        lastTime = now;
        const fpsEl = document.getElementById('fps');
        if (fpsEl) fpsEl.textContent = fps;
        if (performance.memory) {
          const memEl = document.getElementById('memory');
          if (memEl) memEl.textContent = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1) + ' MB';
        }
      }

      // Update controls
      controls.update();

      // Auto-rotate if enabled
      if (rotating) {
        controls.autoRotate = true;
      } else {
        controls.autoRotate = false;
      }

      // Update shader time uniform
      if (points && points.material.uniforms) {
        points.material.uniforms.time.value = now / 1000;
      }

      // Throttle beam/planet updates; when detail panel is open do less work so clicks stay responsive
      _heavyUpdateTick++;
      const panelOpen = selectedMemberIndex !== null;
      const heavyInterval = panelOpen ? 6 : 3;
      const doHeavyUpdate = (_heavyUpdateTick % heavyInterval === 0);

      // Don't render or update beams/planets only during travel (fly-to), not during rotate
      const beamsVisible = !_isTraveling;
      if (activeConnectionLine && activeConnectionLine.batches) {
        activeConnectionLine.batches.forEach((b) => {
          (b.allSegments || []).forEach((ls) => { if (ls) ls.visible = beamsVisible; });
        });
      }
      if (orbitingPosts) orbitingPosts.visible = beamsVisible;

      // Animate orbiting post-planets — skip only during travel (fly-to)
      if (doHeavyUpdate && !_isTraveling && orbitingPosts && orbitData.length > 0 && orbitHostId && points) {
        const hostIndex = memberIndexMap.get(orbitHostId);
        if (hostIndex !== undefined) {
          const posAttr = points.geometry.attributes.position;
          const hx = posAttr.array[hostIndex * 3];
          const hy = posAttr.array[hostIndex * 3 + 1];
          const hz = posAttr.array[hostIndex * 3 + 2];

          const t = now / 1000;
          const numSprites = orbitingPosts.userData.numPlanetSprites ?? orbitData.length;

          for (let i = 0; i < orbitData.length; i++) {
            const o = orbitData[i];
            const a = o.angle + t * o.speed;
            const cx = Math.cos(a) * o.radius;
            const cy = Math.sin(a) * o.radius;
            const rx = cx * Math.cos(o.tiltZ) - cy * Math.sin(o.tiltX) * Math.sin(o.tiltZ);
            const ry = cx * Math.sin(o.tiltZ) + cy * Math.cos(o.tiltX);
            const rz = cy * Math.sin(o.tiltX);
            const wx = hx + rx, wy = hy + ry, wz = hz + rz;

            if (i < numSprites) {
              const sprite = orbitingPosts.children[i];
              if (sprite && sprite.isSprite) {
                sprite.position.set(wx, wy, wz);
                // Distance-based LOD: compact image size when planet is further from camera
                const baseScale = sprite.userData._baseScale ?? sprite.scale.x;
                const dx = wx - camera.position.x, dy = wy - camera.position.y, dz = wz - camera.position.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                const refD = Math.sqrt((hx - camera.position.x) ** 2 + (hy - camera.position.y) ** 2 + (hz - camera.position.z) ** 2) || 1;
                const factor = Math.max(0.28, Math.min(1.4, refD / d));
                // Halo: selected planet scales up
                const scale = baseScale * factor * (i === selectedPlanetIndex ? 1.35 : 1);
                sprite.scale.setScalar(scale);
              }
            } else {
              // LOD overflow: write into Points position buffer (j = i - numSprites)
              const overflow = orbitingPosts.userData.overflowPoints;
              if (overflow && overflow.geometry) {
                const posBuf = overflow.geometry.attributes.position;
                if (posBuf) {
                  const j = (i - numSprites) * 3;
                  posBuf.array[j] = wx;
                  posBuf.array[j + 1] = wy;
                  posBuf.array[j + 2] = wz;
                }
              }
            }
          }

          if (orbitingPosts.userData.overflowPoints && orbitingPosts.userData.overflowPoints.geometry) {
            orbitingPosts.userData.overflowPoints.geometry.attributes.position.needsUpdate = true;
          }
        }
      }

      // Update connection lines — LOD throttle by beam count for FPS (fewer updates when many beams)
      if (doHeavyUpdate && !_isTraveling) {
        const beamCount = activeConnectionLine && activeConnectionLine.batches && activeConnectionLine.batches[0]
          ? activeConnectionLine.batches[0].targetIndices.length : 0;
        let beamInterval = 1;
        if (panelOpen) beamInterval = 8;
        else if (beamCount > 44) beamInterval = 4;
        else if (beamCount > 28) beamInterval = 2;
        const skipBeamUpdate = (beamInterval > 1) && (_heavyUpdateTick % beamInterval !== 0);
        if (!skipBeamUpdate) updateConnectionLinePositions();
      }

      // Reproject selected star to screen for floating label + update sprite position
      if (selectedMemberIndex !== null && points && selectedLabel) {
        const posArr = points.geometry.attributes.position.array;
        const wx = posArr[selectedMemberIndex * 3];
        const wy = posArr[selectedMemberIndex * 3 + 1];
        const wz = posArr[selectedMemberIndex * 3 + 2];

        // Project world → NDC → screen (reuse vector — no per-frame allocation)
        _projectVec.set(wx, wy, wz);
        _projectVec.project(camera);
        const vec = _projectVec;
        const hw = window.innerWidth / 2;
        const hh = window.innerHeight / 2;
        const sx = Math.round(vec.x * hw + hw);
        const sy = Math.round(-vec.y * hh + hh);

        // Only show label when star is in front of camera
        if (vec.z < 1.0) {
          selectedLabel.style.display = 'block';
          selectedLabel.style.left = sx + 'px';
          selectedLabel.style.top = sy + 'px';
        } else {
          selectedLabel.style.display = 'none';
        }

        // Keep sprite glued to star world position
        if (selectedSprite && !selectedSprite._placeholder && !selectedSprite._disposed) {
          selectedSprite.position.set(wx, wy, wz);
        }
      }

      // Update draw calls (throttle to ~2×/s to reduce DOM writes and layout)
      if (frameCount % 30 === 0) {
        const drawsEl = document.getElementById('draws');
        if (drawsEl) drawsEl.textContent = renderer.info.render.calls;
      }

      // Render
      renderer.render(scene, camera);
    }

    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      const mobile = window.innerWidth <= 768;
      const maxPR = mobile ? 1.5 : 2;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPR));
    }

    function onKeyDown(event) {
      // Don't trigger if typing in search box
      if (event.target.tagName === 'INPUT') return;

      switch(event.key.toLowerCase()) {
        case 'r':
          toggleRotation();
          break;
        case 'h':
          resetCamera();
          break;
        case 'f':
          focusOnCluster();
          break;
        case 'a':
          toggleAdmin();
          break;
        case '/':
          document.querySelector('#search input').focus();
          event.preventDefault();
          break;
        case 'escape':
          closeDetail();
          document.getElementById('help').classList.remove('visible');
          document.getElementById('admin-sidebar').classList.remove('visible');
          break;
        case '?':
          toggleHelp();
          break;
      }
    }

    window.generatePoints = (count) => {
      generatePoints(count);
    };

    window.toggleRotation = () => {
      rotating = !rotating;
    };

    window.resetCamera = () => {
      // Position slightly to the side so the full time-column (Y axis) is visible
      camera.position.set(120, 0, 80);
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    window.focusOnCluster = () => {
      if (!points) return;

      // Pick a random point and zoom to it
      const positions = points.geometry.attributes.position.array;
      const randomIndex = Math.floor(Math.random() * (positions.length / 3)) * 3;

      const targetPos = new THREE.Vector3(
        positions[randomIndex],
        positions[randomIndex + 1],
        positions[randomIndex + 2]
      );

      // Smooth camera transition
      const startPos = camera.position.clone();
      const startTarget = controls.target.clone();
      const endPos = targetPos.clone().add(new THREE.Vector3(15, 15, 15));
      const endTarget = targetPos;

      let t = 0;
      const animateZoom = () => {
        t += 0.05;
        if (t > 1) t = 1;

        camera.position.lerpVectors(startPos, endPos, t);
        controls.target.lerpVectors(startTarget, endTarget, t);
        controls.update();

        if (t < 1) requestAnimationFrame(animateZoom);
      };
      animateZoom();
    };

    window.toggleHelp = () => {
      const help = document.getElementById('help');
      help.classList.toggle('visible');
    };

    window.toggleAdmin = () => {
      const sidebar = document.getElementById('admin-sidebar');
      sidebar.classList.toggle('visible');
    };

    // Click outside to close admin sidebar
    function handleClickOutside(event) {
      const sidebar = document.getElementById('admin-sidebar');
      const toggleBtn = document.getElementById('admin-toggle');

      if (sidebar.classList.contains('visible')) {
        // Check if click is outside both sidebar and toggle button
        if (!sidebar.contains(event.target) && !toggleBtn.contains(event.target)) {
          sidebar.classList.remove('visible');
        }
      }
    }

    // Add event listener
    document.addEventListener('click', handleClickOutside);

    window.focusOnSelected = () => {
      if (selectedMemberIndex !== null) {
        flashPoint(selectedMemberIndex);
      }
    };

    // Job Management System
    function createJob(name, type) {
      const job = {
        id: jobIdCounter++,
        name,
        type,
        status: 'running',
        progress: 0,
        startTime: Date.now(),
        message: 'Initializing...',
      };
      jobs.push(job);
      renderJobs();
      return job;
    }

    function updateJob(jobId, updates) {
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        Object.assign(job, updates);
        renderJobs();
      }
    }

    function renderJobs() {
      const container = document.getElementById('jobs-container');
      if (jobs.length === 0) {
        container.innerHTML = '<p style="color: #666; font-style: italic;">No background jobs running</p>';
        return;
      }

      container.innerHTML = jobs.map(job => `
        <div class="job-item">
          <div>
            <strong>${job.name}</strong>
            <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
          </div>
          <div style="font-size: 12px; color: #999; margin: 5px 0;">${job.message}</div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${job.progress}%"></div>
          </div>
          <div style="font-size: 11px; color: #666; margin-top: 5px;">
            ${job.progress.toFixed(0)}% • ${((Date.now() - job.startTime) / 1000).toFixed(1)}s elapsed
          </div>
        </div>
      `).join('');
    }

    window.clearAllJobs = () => {
      jobs = jobs.filter(j => j.status === 'running');
      renderJobs();
    };

    window.resetJobState = () => {
      if (confirm('This will reset the job state and snapshot cache, starting from scratch. Continue?')) {
        localStorage.removeItem('universeJobState');
        localStorage.removeItem(SNAPSHOT_KEY);
        localStorage.removeItem(NAV_CACHE_KEY);
        const el = document.getElementById('snapshot-status');
        if (el) el.textContent = '';
        loadedMemberIds.clear();
        memberIndexMap.clear();
        usernameToIndexMap.clear();

        // Remove all points
        if (points) {
          scene.remove(points);
          points.geometry.dispose();
          points.material.dispose();
          points = null;
        }
        pointMetadata = [];

        // Reset stats
        document.getElementById('admin-total').textContent = '0';
        document.getElementById('admin-real').textContent = '0';
        document.getElementById('admin-synthetic').textContent = '0';
        document.getElementById('count').textContent = '0';

        alert('Job state reset. Click "Continue Loading Data" to start fresh.');
      }
    };

    // Real Data Loading Job
    // Helper function to get risk color
    function getRiskColor(risk) {
      if (risk < 0.33) {
        const t = risk * 3;
        return { r: 0, g: t, b: 1 };
      } else if (risk < 0.66) {
        const t = (risk - 0.33) * 3;
        return { r: t, g: 1, b: 1 - t };
      } else {
        const t = (risk - 0.66) * 3;
        return { r: 1, g: 1 - t, b: 0 };
      }
    }

    // Helper function to enrich point cloud data incrementally
    function enrichPointCloudData(state) {
      const newPositions = [];
      const newColors = [];
      const newSizes = [];
      const newActivities = [];
      const newVertexIndices = [];
      const newMetadata = [];

      let nextIndex = points ? points.geometry.attributes.position.count : 0;

      state.members.forEach((member, id) => {
        const existingIndex = memberIndexMap.get(id);

        if (existingIndex !== undefined) {
          // UPDATE existing member — only refresh activity/color/size/metadata.
          // NEVER overwrite position: the snapshot laid out all ~35k members together,
          // so their positions are stable and correct. Incremental enrichment only has
          // a small batch (~2500 members), so re-running evolve() on that mini-state
          // produces positions that are completely different from the full-universe
          // layout. Overwriting would teleport stars (and their orbiting planets)
          // off-screen mid-session.
          const postCount = Array.from(state.posts.values()).filter(p => p.creator === id).length;
          const commentCount = Array.from(state.comments.values()).filter(c => c.fromMember === id).length;
          const activity = postCount + commentCount;
          const risk = Math.random(); // TODO: Use actual predictions

          // Update color/size/activity in-place — leave position untouched
          const colors = points.geometry.attributes.color.array;
          const sizes = points.geometry.attributes.size.array;
          const activities = points.geometry.attributes.activity.array;

          const color = getRiskColor(risk);
          colors[existingIndex * 3] = color.r;
          colors[existingIndex * 3 + 1] = color.g;
          colors[existingIndex * 3 + 2] = color.b;

          sizes[existingIndex] = 2 + Math.log(commentCount + 1) * 0.8;
          activities[existingIndex] = Math.min(activity / 100, 1);

          // Update metadata — preserve existing profilePicture and position
          // (member stubs created via posts/comments don't have proPic yet)
          const existingPic = pointMetadata[existingIndex]?.profilePicture || null;
          const prev = pointMetadata[existingIndex]?.position;
          const ex = prev && typeof prev.x === 'number' ? prev : { x: 0, y: 0, z: 0 };
          pointMetadata[existingIndex] = {
            id,
            username: member.username || 'Anonymous',
            profilePicture: member.proPic || existingPic,
            position: { x: ex.x, y: ex.y, z: ex.z },
            risk: (risk * 100).toFixed(0),
            riskLevel: risk < 0.33 ? 'low' : risk < 0.66 ? 'medium' : 'high',
            activity,
            sobrietyDays: member.sobriety
              ? Math.floor((Date.now() - new Date(member.sobriety).getTime()) / 86400000)
              : 0,
            cluster: 'Real Data',
          };
        } else {
          if (nextIndex >= MAX_POINTS_DISPLAYED) return; // FPS cap: don't add more points
          // APPEND new member (member.position can be null from back4app feed)
          const p = member.position;
          const px = p && typeof p.x === 'number' ? p.x : 0;
          const py = p && typeof p.y === 'number' ? p.y : 0;
          const pz = p && typeof p.z === 'number' ? p.z : 0;
          newPositions.push(px, py, pz);

          const postCount = Array.from(state.posts.values()).filter(p => p.creator === id).length;
          const commentCount = Array.from(state.comments.values()).filter(c => c.fromMember === id).length;
          const activity = postCount + commentCount;
          const risk = Math.random(); // TODO: Use actual predictions

          const color = getRiskColor(risk);
          newColors.push(color.r, color.g, color.b);

          newSizes.push(2 + Math.log(commentCount + 1) * 0.8);
          newActivities.push(Math.min(activity / 100, 1));
          newVertexIndices.push(nextIndex);

          newMetadata.push({
            id,
            username: member.username || 'Anonymous',
            profilePicture: member.proPic || null,
            position: { x: px, y: py, z: pz },
            risk: (risk * 100).toFixed(0),
            riskLevel: risk < 0.33 ? 'low' : risk < 0.66 ? 'medium' : 'high',
            activity,
            sobrietyDays: member.sobriety
              ? Math.floor((Date.now() - new Date(member.sobriety).getTime()) / 86400000)
              : 0,
            cluster: 'Real Data',
          });

          memberIndexMap.set(id, nextIndex);
          loadedMemberIds.add(id);
          nextIndex++;
        }
      });

      // If there are new members, expand geometry
      if (newPositions.length > 0) {
        if (points && points.geometry) {
          // Expand existing geometry
          const oldPositions = points.geometry.attributes.position.array;
          const oldColors = points.geometry.attributes.color.array;
          const oldSizes = points.geometry.attributes.size.array;
          const oldActivities = points.geometry.attributes.activity.array;
          const oldVertexIndices = points.geometry.attributes.vertexIndex.array;

          const newPosArray = new Float32Array(oldPositions.length + newPositions.length);
          const newColArray = new Float32Array(oldColors.length + newColors.length);
          const newSizeArray = new Float32Array(oldSizes.length + newSizes.length);
          const newActArray = new Float32Array(oldActivities.length + newActivities.length);
          const newIdxArray = new Float32Array(oldVertexIndices.length + newVertexIndices.length);

          newPosArray.set(oldPositions);
          newPosArray.set(newPositions, oldPositions.length);

          newColArray.set(oldColors);
          newColArray.set(newColors, oldColors.length);

          newSizeArray.set(oldSizes);
          newSizeArray.set(newSizes, oldSizes.length);

          newActArray.set(oldActivities);
          newActArray.set(newActivities, oldActivities.length);

          newIdxArray.set(oldVertexIndices);
          newIdxArray.set(newVertexIndices, oldVertexIndices.length);

          // Update geometry
          points.geometry.setAttribute('position', new THREE.BufferAttribute(newPosArray, 3));
          points.geometry.setAttribute('color', new THREE.BufferAttribute(newColArray, 3));
          points.geometry.setAttribute('size', new THREE.BufferAttribute(newSizeArray, 1));
          points.geometry.setAttribute('activity', new THREE.BufferAttribute(newActArray, 1));
          points.geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(newIdxArray, 1));

          // Append metadata
          pointMetadata.push(...newMetadata);
        } else {
          // Create new geometry (first load)
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newPositions), 3));
          geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(newColors), 3));
          geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(newSizes), 1));
          geometry.setAttribute('activity', new THREE.BufferAttribute(new Float32Array(newActivities), 1));
          geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(new Float32Array(newVertexIndices), 1));

          const material = new THREE.ShaderMaterial({
            vertexShader: starVertexShader,
            fragmentShader: starFragmentShader,
            uniforms: {
              time: { value: 0 },
              selectedIndex: { value: -1.0 }
            },
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending, // Changed from AdditiveBlending to prevent white ball effect
          });

          points = new THREE.Points(geometry, material);
          scene.add(points);

          pointMetadata = newMetadata;
        }

        // Mark attributes as needing update
        points.geometry.attributes.position.needsUpdate = true;
        points.geometry.attributes.color.needsUpdate = true;
        points.geometry.attributes.size.needsUpdate = true;
        points.geometry.attributes.activity.needsUpdate = true;
        points.geometry.attributes.vertexIndex.needsUpdate = true;
      } else {
        // No new members, just update existing color/size/activity (position unchanged)
        if (points && points.geometry) {
          points.geometry.attributes.color.needsUpdate = true;
          points.geometry.attributes.size.needsUpdate = true;
          points.geometry.attributes.activity.needsUpdate = true;
        }
      }

      syncUsernameToIndexMap();
      // If URL has a user id or username, select that user (e.g. returning to a bookmarked link)
      if (points && pointMetadata.length > 0) applyUserFromUrl();
    }

    // ─── Universe Snapshot System ───────────────────────────────────────────────
    // Snapshots let the universe restore instantly on reload without re-fetching.
    // Each entry: { id, username, proPic, x, y, z, size, activity, sobrietyDays }
    // Stored under 'universeSnapshot' in localStorage (compact JSON, ~100B/member).
    // The skips counters travel with the snapshot so incremental loads pick up
    // exactly where we left off, only fetching members we don't have yet.

    const SNAPSHOT_KEY = 'universeSnapshot';
    const SNAPSHOT_VERSION = 4; // bumped — invalidate old snapshot so profile pictures re-load from API
    const NAV_CACHE_KEY = 'universeNavCache';   // beam + post caches so restore = no refetch when navigating
    const NAV_CACHE_VERSION = 1;
    const NAV_CACHE_MAX_USERS = 60;            // cap so localStorage doesn't blow up

    function loadSnapshot() {
      try {
        const raw = localStorage.getItem(SNAPSHOT_KEY);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        if (snap.version !== SNAPSHOT_VERSION) return null;
        return snap;
      } catch (e) {
        return null;
      }
    }

    /** True if this snapshot looks like synthetic/fake data (e.g. from old generatePoints run). */
    function isSyntheticSnapshot(snap) {
      const members = snap?.members;
      if (!members || members.length === 0) return false;
      const sample = members.slice(0, Math.min(20, members.length));
      const syntheticCount = sample.filter((m) => {
        if (!m || typeof m !== 'object') return false;
        const id = String(m.id || '');
        const username = String(m.username || '');
        return id.startsWith('member_') || /^User\d+$/i.test(username);
      }).length;
      return syntheticCount >= Math.min(5, sample.length);
    }

    const SNAPSHOT_MAX_MEMBERS = 30000; // Cap to avoid localStorage quota (typical ~5MB); restore still works, incremental load continues
    const MAX_POINTS_DISPLAYED = 100000; // Cap rendered stars for FPS; data still loads, only first N shown
    let _snapshotQuotaWarned = false;

    function saveSnapshot(skips) {
      if (!pointMetadata || pointMetadata.length === 0) return;
      const geo = points && points.geometry;
      const posArr = geo ? geo.attributes.position.array : null;
      const sizeArr = geo ? geo.attributes.size.array : null;
      const actArr = geo ? geo.attributes.activity.array : null;

      const total = pointMetadata.length;
      const cap = Math.min(total, SNAPSHOT_MAX_MEMBERS);
      const members = [];
      for (let i = 0; i < cap; i++) {
        const m = pointMetadata[i];
        const x = posArr ? posArr[i * 3]     : (m?.position != null && typeof m.position.x === 'number' ? m.position.x : 0);
        const y = posArr ? posArr[i * 3 + 1] : (m?.position != null && typeof m.position.y === 'number' ? m.position.y : 0);
        const z = posArr ? posArr[i * 3 + 2] : (m?.position != null && typeof m.position.z === 'number' ? m.position.z : 0);
        members.push({
          id:            m.id,
          username:      m.username,
          proPic:        i < 15000 ? (m.profilePicture || null) : null, // omit proPic for tail to save space when capped
          x: +(Number(x) || 0).toFixed(2),
          y: +(Number(y) || 0).toFixed(2),
          z: +(Number(z) || 0).toFixed(2),
          size:          sizeArr ? +(sizeArr[i] || 1).toFixed(2) : 1,
          activity:      actArr  ? +(actArr[i] || 0).toFixed(2) : 0,
          sobrietyDays:  m.sobrietyDays || 0,
        });
      }

      const snap = {
        version:   SNAPSHOT_VERSION,
        timestamp: Date.now(),
        skips:     cap < total ? { ...skips, totalMembers: cap } : skips,
        members,
      };

      try {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
        updateSnapshotStatus(members.length, snap.timestamp, cap < total ? ` (capped ${cap.toLocaleString()})` : '');
        // Persist beam + post caches so after restore we don't refetch when navigating to same members
        if (typeof beamDataCache !== 'undefined' && typeof postCacheByUser !== 'undefined') {
          const beamEntries = [];
          beamDataCache.forEach((cached, userId) => {
            if (beamEntries.length >= NAV_CACHE_MAX_USERS) return;
            beamEntries.push({
              userId,
              engagementCount: cached.engagementCount || {},
              postCreatorMap: cached.postCreatorMap || {},
              commentsForCodec: Array.isArray(cached.commentsForCodec) ? cached.commentsForCodec : [],
              commentCount: (cached.rawComments && cached.rawComments.length) || 0,
              timestamp: cached.timestamp || 0,
            });
          });
          const postEntries = [];
          postCacheByUser.forEach((cached, userId) => {
            if (postEntries.length >= NAV_CACHE_MAX_USERS) return;
            postEntries.push({ userId, posts: cached.posts || [], timestamp: cached.timestamp || 0 });
          });
          try {
            localStorage.setItem(NAV_CACHE_KEY, JSON.stringify({
              version: NAV_CACHE_VERSION,
              beamCache: beamEntries,
              postCacheByUser: postEntries,
            }));
          } catch (eNav) { /* quota; skip nav cache */ }
        }
      } catch (e) {
        // Quota exceeded — try smaller cap and no proPic for tail
        const smaller = members.slice(0, Math.min(members.length, 15000)).map(m => ({
          id: m.id,
          username: m.username,
          proPic: null,
          x: m.x,
          y: m.y,
          z: m.z,
          size: m.size,
          activity: m.activity,
          sobrietyDays: m.sobrietyDays || 0,
        }));
        try {
          localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snap, members: smaller }));
          updateSnapshotStatus(smaller.length, snap.timestamp, '(reduced)');
        } catch (e2) {
          if (!_snapshotQuotaWarned) {
            _snapshotQuotaWarned = true;
            console.warn('[Snapshot] localStorage full, skipping save. Clear site data or use fewer members.');
          }
        }
      }
    }

    function restoreFromSnapshot(snap) {
      // Re-inflate point cloud from snapshot without any API call.
      const raw = snap.members;
      if (!raw || raw.length === 0) return 0;
      // Filter out null/undefined entries (corrupted or old snapshot format)
      const members = raw.filter((m) => m != null && (m.id != null || m.x != null || (m.position && (m.position.x != null || m.position.y != null || m.position.z != null))));

      if (members.length === 0) return 0;

      const toShow = members.slice(0, MAX_POINTS_DISPLAYED);
      const n = toShow.length;
      const positions   = new Float32Array(n * 3);
      const colors      = new Float32Array(n * 3);
      const sizes       = new Float32Array(n);
      const activities  = new Float32Array(n);
      const vertexIdxs  = new Float32Array(n);

      // Support both top-level x,y,z and nested position: { x, y, z } (old snapshot format)
      function getCoord(m, axis) {
        const v = m[axis] ?? m.position?.[axis];
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }

      toShow.forEach((m, i) => {
        const mx = getCoord(m, 'x');
        const my = getCoord(m, 'y');
        const mz = getCoord(m, 'z');
        positions[i * 3]     = Number.isFinite(mx) ? mx : 0;
        positions[i * 3 + 1] = Number.isFinite(my) ? my : 0;
        positions[i * 3 + 2] = Number.isFinite(mz) ? mz : 0;

        // Recompute colour from activity (0=blue, 0.5=teal, 1=yellow) — fast approximation
        const act = Number(m.activity);
        const t = Math.min((Number.isFinite(act) ? act : 0) * 5, 1);
        colors[i * 3]     = t;
        colors[i * 3 + 1] = Math.min(t * 2, 1);
        colors[i * 3 + 2] = 1 - t;

        sizes[i]        = (m.size != null && Number.isFinite(Number(m.size))) ? Number(m.size) : 1;
        activities[i]   = Number.isFinite(act) ? act : 0;
        vertexIdxs[i]   = i;

        pointMetadata.push({
          id:             m.id != null ? m.id : String(i),
          username:       m.username || 'Anonymous',
          profilePicture: m.proPic || null,
          position:       { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] },
          risk:           '50',
          riskLevel:      'medium',
          activity:       Number.isFinite(act) ? act : 0,
          sobrietyDays:   m.sobrietyDays != null ? Number(m.sobrietyDays) : 0,
          cluster:        'Snapshot',
        });

        memberIndexMap.set(m.id != null ? m.id : String(i), i);
        loadedMemberIds.add(m.id != null ? m.id : String(i));
      });

      syncUsernameToIndexMap();
      // Build geometry + material
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position',    new THREE.BufferAttribute(positions,  3));
      geometry.setAttribute('color',       new THREE.BufferAttribute(colors,     3));
      geometry.setAttribute('size',        new THREE.BufferAttribute(sizes,      1));
      geometry.setAttribute('activity',    new THREE.BufferAttribute(activities, 1));
      geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(vertexIdxs, 1));

      const material = new THREE.ShaderMaterial({
        vertexShader:   starVertexShader,
        fragmentShader: starFragmentShader,
        uniforms: {
          time:          { value: 0 },
          selectedIndex: { value: -1.0 },
        },
        transparent: true,
        depthWrite:  false,
        blending:    THREE.NormalBlending,
      });

      if (points) {
        scene.remove(points);
        points.geometry.dispose();
        points.material.dispose();
      }
      points = new THREE.Points(geometry, material);
      scene.add(points);

      // Restore navigation caches so opening previously visited members doesn't trigger API calls
      if (typeof beamDataCache !== 'undefined' && typeof postCacheByUser !== 'undefined') {
        try {
          const rawNav = localStorage.getItem(NAV_CACHE_KEY);
          if (rawNav) {
            const nav = JSON.parse(rawNav);
            if (nav && nav.version === NAV_CACHE_VERSION) {
              const now = Date.now();
              (nav.beamCache || []).forEach((entry) => {
                beamDataCache.set(entry.userId, {
                  engagementCount: entry.engagementCount || {},
                  postCreatorMap: entry.postCreatorMap || {},
                  commentsForCodec: entry.commentsForCodec || [],
                  rawComments: entry.commentCount ? Array(entry.commentCount) : [],
                  timestamp: now, // treat as fresh so we don't refetch when navigating
                });
              });
              (nav.postCacheByUser || []).forEach((entry) => {
                postCacheByUser.set(entry.userId, { posts: entry.posts || [], timestamp: now });
              });
            }
          }
        } catch (eNav) { /* ignore */ }
      }

      return members.length; // report full count; only toShow.length are rendered
    }

    function updateSnapshotStatus(count, timestamp, suffix = '') {
      const el = document.getElementById('snapshot-status');
      if (!el) return;
      const age = Math.round((Date.now() - timestamp) / 1000);
      const ageStr = age < 60 ? age + 's ago'
                   : age < 3600 ? Math.round(age/60) + 'm ago'
                   : Math.round(age/3600) + 'h ago';
      el.textContent = `Snapshot: ${count.toLocaleString()} members · saved ${ageStr} ${suffix}`;
    }

    window.clearSnapshot = () => {
      localStorage.removeItem(SNAPSHOT_KEY);
      localStorage.removeItem(NAV_CACHE_KEY);
      const el = document.getElementById('snapshot-status');
      if (el) el.textContent = 'Snapshot cleared.';
    };

    // Show snapshot info on load
    (function() {
      const snap = loadSnapshot();
      if (snap) updateSnapshotStatus(snap.members.length, snap.timestamp);
    })();
    // ────────────────────────────────────────────────────────────────────────────

    window.startLoadRealDataJob = async () => {
      const job = createJob('Load Real Data', 'data-load');

      try {
        // 0. Try to restore from snapshot first (instant, no API calls)
        let snap = loadSnapshot();
        let skips;
        if (snap && isSyntheticSnapshot(snap)) {
          // Snapshot contains fake/synthetic data (e.g. from old generatePoints) — discard and load real data
          localStorage.removeItem(SNAPSHOT_KEY);
          localStorage.removeItem(NAV_CACHE_KEY);
          localStorage.removeItem('universeJobState');
          snap = null;
        }
        if (snap && snap.skips) {
          skips = snap.skips;
          if (pointMetadata.length === 0) {
            // First call this session — restore the rendered universe from snapshot
            updateJob(job.id, { message: `Restoring ${snap.members.length.toLocaleString()} members from snapshot...`, progress: 5 });
            const restored = restoreFromSnapshot(snap);
            const realCount = loadedMemberIds.size;
            document.getElementById('admin-total').textContent = realCount.toLocaleString();
            document.getElementById('admin-real').textContent  = realCount.toLocaleString();
            document.getElementById('admin-synthetic').textContent = '0';
            document.getElementById('count').textContent = realCount.toLocaleString();
            updateJob(job.id, { message: `Restored ${restored.toLocaleString()} members from snapshot. Checking for new members...`, progress: 15 });
            applyUserFromUrl();
            // If restore yielded 0 members (corrupt or wrong-format snapshot), clear snapshot and fall through to fresh load
            if (restored === 0) {
              localStorage.removeItem(SNAPSHOT_KEY);
              localStorage.removeItem(NAV_CACHE_KEY);
              skips = { userSkip: 0, postSkip: 0, commentSkip: 0, totalMembers: 0, isComplete: false };
              localStorage.removeItem('universeJobState');
            }
          }
        } else {
          // No snapshot — load from localStorage skips or start fresh
          const savedState = localStorage.getItem('universeJobState');
          skips = savedState
            ? JSON.parse(savedState)
            : { userSkip: 0, postSkip: 0, commentSkip: 0, totalMembers: 0, isComplete: false };
          // If the snapshot was invalidated (version bump) but skips says complete,
          // we must reload from scratch — otherwise the while loop never runs and
          // the universe stays empty (no stars, no images).
          if (!snap && skips.isComplete) {
            skips = { userSkip: 0, postSkip: 0, commentSkip: 0, totalMembers: 0, isComplete: false };
            localStorage.removeItem('universeJobState');
          }
        }

        // 1. Exit if job already complete and snapshot is fresh (< 1 hour old)
        if (skips.isComplete && snap && (Date.now() - snap.timestamp) < 3600000) {
          updateJob(job.id, {
            status: 'completed',
            message: 'Universe fully loaded from snapshot',
            progress: 100
          });
          return;
        }

        updateJob(job.id, {
          message: skips.totalMembers > 0
            ? `Fetching new members (have ${skips.totalMembers.toLocaleString()})...`
            : 'Starting fresh load...',
          progress: snap ? 20 : 5
        });

        // 3. Dynamic import of Back4App and codec modules
        const back4appModule = await import('../../lib/back4app.js');
        const codecModule = await import('../../lib/codec.js');
        const { feedFromBack4App, DEFAULT_CONFIG } = back4appModule;
        const { createState, evolve, DEFAULT_PARAMS } = codecModule;

        updateJob(job.id, { message: 'Initializing state...', progress: 10 });

        const state = createState();
        const BATCH_SIZE = 1000;   // Larger batches = fewer API calls (Parse limit 1000)
        const MAX_MEMBERS = 600000;
        const MAX_BATCHES_PER_RUN = 5;

        // 4. Continuous loading loop
        let batchesThisRun = 0;
        while (!skips.isComplete && skips.totalMembers < MAX_MEMBERS && batchesThisRun < MAX_BATCHES_PER_RUN) {
          const batchConfig = {
            userLimit: BATCH_SIZE,
            postLimit: 200,
            commentLimit: 300,
            soberDateChangeLimit: 0,
          };

          const membersBefore = state.members.size;

          await feedFromBack4App(DEFAULT_CONFIG, state, skips, batchConfig);

          const membersAfter = state.members.size;
          const newMembersCount = membersAfter - membersBefore;

          skips.totalMembers = membersAfter;
          skips.lastUpdate = Date.now();
          batchesThisRun++;

          // Save to localStorage after each batch
          localStorage.setItem('universeJobState', JSON.stringify(skips));

          updateJob(job.id, {
            message: `Loaded ${skips.totalMembers} members (batch ${batchesThisRun}, +${newMembersCount} new)...`,
            progress: Math.min(95, (skips.totalMembers / MAX_MEMBERS) * 100)
          });

          // Check if no new members were loaded (reached end)
          if (newMembersCount === 0) {
            skips.isComplete = true;
            localStorage.setItem('universeJobState', JSON.stringify(skips));
            break;
          }

          // Minimal delay to avoid rate limiting (reduced for faster loading)
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        // 5. Merge beam-loaded comments and on-demand loaded posts into state so codec uses them (no need to re-fetch)
        const beamCache = typeof getBeamCommentCacheForCodec === 'function' ? getBeamCommentCacheForCodec() : null;
        if (beamCache && state.comments) {
          beamCache.forEach((cached, userId) => {
            const list = cached.commentsForCodec;
            if (Array.isArray(list)) {
              list.forEach((c, i) => {
                if (c && c.fromMember && c.toMember) {
                  state.comments.set('beam_' + userId + '_' + i, {
                    fromMember: c.fromMember,
                    toMember: c.toMember,
                    postId: c.postId || null,
                  });
                }
              });
            }
          });
        }
        const postCache = typeof getPostCacheForCodec === 'function' ? getPostCacheForCodec() : null;
        if (postCache && state.posts) {
          postCache.forEach((p, postId) => {
            if (p && p.creator && !state.posts.has(postId)) {
              state.posts.set(postId, {
                creator: p.creator,
                content: p.content || '',
                commentCount: p.commentCount || 0,
                created: p.created,
                image: p.image ?? null,
              });
            }
          });
        }

        // 6. Compute spatial positions if we have members
        if (state.members.size > 0) {
          updateJob(job.id, { message: 'Computing spatial layout...', progress: 90 });

          if (state.members.size > 10) {
            evolve(state, DEFAULT_PARAMS);
          }

          // 7. Enrich point cloud incrementally
          updateJob(job.id, { message: 'Updating visualization...', progress: 95 });
          enrichPointCloudData(state);

          // 8. Save snapshot so next load is instant
          updateJob(job.id, { message: 'Saving snapshot...', progress: 97 });
          saveSnapshot(skips);

          // 9. Refinement: run training steps in setTimeout so main thread can handle touch/wheel (avoid long requestIdleCallback)
          const TRAIN_STEPS = 3;
          let trainStep = 0;
          function runTrainingStep() {
            if (trainStep >= TRAIN_STEPS) {
              const msg = skips.isComplete ? `Loaded all ${skips.totalMembers} members` : `Loaded ${skips.totalMembers} members (will continue on next run)`;
              updateJob(job.id, { message: msg, progress: skips.isComplete ? 100 : Math.min(95, (skips.totalMembers / MAX_MEMBERS) * 100) });
              return;
            }
            trainStep++;
            updateJob(job.id, { message: `Refining layout ${trainStep}/${TRAIN_STEPS}...`, progress: 97 });
            evolve(state, DEFAULT_PARAMS);
            enrichPointCloudData(state);
            saveSnapshot(skips);
            setTimeout(runTrainingStep, 0);
          }
          if (state.comments && state.comments.size > 0) {
            setTimeout(runTrainingStep, 0);
          }
        }

        // 10. Update UI
        const realCount = loadedMemberIds.size;
        document.getElementById('admin-total').textContent = realCount.toLocaleString();
        document.getElementById('admin-real').textContent = realCount.toLocaleString();
        document.getElementById('admin-synthetic').textContent = '0';
        document.getElementById('count').textContent = realCount.toLocaleString();

        if (skips.isComplete) {
          updateJob(job.id, {
            status: 'completed',
            progress: 100,
            message: `Loaded all ${skips.totalMembers} members`
          });
        } else {
          updateJob(job.id, {
            status: 'completed',
            progress: Math.min(95, (skips.totalMembers / MAX_MEMBERS) * 100),
            message: `Loaded ${skips.totalMembers} members (will continue on next run)`
          });

          // Auto-continue loading after a delay
          setTimeout(() => {
            startLoadRealDataJob();
          }, 5000); // Wait 5 seconds before next batch
        }

      } catch (err) {
        console.error('Load real data error:', err);

        // Save state even on error so we can resume
        const savedState = localStorage.getItem('universeJobState');
        if (savedState) {
          const skips = JSON.parse(savedState);
          localStorage.setItem('universeJobState', JSON.stringify(skips));
        }

        updateJob(job.id, {
          status: 'error',
          progress: 0,
          message: `Error: ${err.message}`
        });
      }
    };

    // Auto-update jobs every second
    setInterval(() => {
      const runningJobs = jobs.filter(j => j.status === 'running');
      if (runningJobs.length > 0) {
        renderJobs();
      }
    }, 1000);

    // init() is called by React PointCloudApp with container ref
