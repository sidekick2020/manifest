import { useRef, useEffect, useCallback, useState } from 'react';
import { useUniverseStore } from '../stores/universeStore';
import { useTrainingStore } from '../stores/trainingStore';
import { usePredictionStore } from '../stores/predictionStore';
import { seedToFloat, computeTargetRadius, filterMembersByLocation } from '../../lib/codec.js';
import { v3lerp } from '../../lib/vec3.js';
import { Octree, getFrustumBounds } from '../../lib/octree.js';
import { TemporalSlicer } from '../../lib/temporalSlicer.js';
import { getLODTier, getCellSize } from '../../lib/SimpleLOD.js';

/**
 * Canvas 2D renderer — matches v6-live prototype rendering.
 * Manual 3D projection, glow effects, auto-zoom camera, click-to-select.
 */
export function Scene() {
  const canvasRef = useRef(null);
  const camRef = useRef({ rx: 0.3, ry: 0, trx: 0.3, try: 0, d: 70, td: 70, userZoomed: false, focus: { x: 0, y: 0, z: 0 }, tFocus: { x: 0, y: 0, z: 0 }, focusActive: false });
  const dragRef = useRef({ active: false, last: { x: 0, y: 0 }, click: { x: 0, y: 0 } });
  const screenPosRef = useRef(new Map());
  const filteredIdsRef = useRef(new Set()); // Current filtered member IDs for click validation
  const bgStarsRef = useRef(null);
  const rafRef = useRef(null);
  const imgCacheRef = useRef(new Map());
  const lastTickTimeRef = useRef(0); // For throttling position updates
  const octreeRef = useRef(null);
  const slicerRef = useRef(null);
  const sparklesRef = useRef([]); // Activity sparkles for visual feedback
  const lastCommentCountRef = useRef(0); // Track comment count changes
  const prevFilterRef = useRef(''); // Track filter changes for position snap

  // Temporal slicing state - controls which time window to render
  const [sliceOptions, setSliceOptions] = useState({
    mode: 'recent',     // Show most recent members
    windowSize: 2000,   // Max 2000 members visible at once
    page: 0             // For pagination mode
  });

  // Initialize octree once
  if (!octreeRef.current) {
    octreeRef.current = new Octree(
      { min: { x: -200, y: -200, z: -200 }, max: { x: 200, y: 200, z: 200 } },
      16,  // capacity per node
      10   // max depth
    );
  }

  // Initialize temporal slicer once
  if (!slicerRef.current) {
    slicerRef.current = new TemporalSlicer();
  }

  // Generate background stars once
  if (!bgStarsRef.current) {
    const bg = [];
    for (let i = 0; i < 350; i++) {
      bg.push({ x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400, z: (Math.random() - 0.5) * 400 });
    }
    bgStarsRef.current = bg;
  }

  // Resize handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Pointer handlers for orbit
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (e) => {
      dragRef.current.active = true;
      dragRef.current.last = { x: e.clientX, y: e.clientY };
      dragRef.current.click = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      if (!dragRef.current.active) return;
      const cam = camRef.current;
      cam.try += (e.clientX - dragRef.current.last.x) * 0.005;
      cam.trx += (e.clientY - dragRef.current.last.y) * 0.005;
      cam.trx = Math.max(-1.2, Math.min(1.2, cam.trx));
      dragRef.current.last = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => { dragRef.current.active = false; };
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY || e.detail || 0;
      camRef.current.td = Math.max(1, Math.min(300, camRef.current.td + delta * 0.3));
      camRef.current.userZoomed = true;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Click-to-select
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onClick = (e) => {
      const dx = e.clientX - dragRef.current.click.x;
      const dy = e.clientY - dragRef.current.click.y;
      if (Math.sqrt(dx * dx + dy * dy) > 5) return;
      const mx = e.clientX, my = e.clientY;
      let closest = null, closestDist = 25;
      let closestType = null; // Track whether it's member, post, or aggregate

      // Get current location filter to skip non-matching members during hit test
      const clickStore = useUniverseStore.getState();
      const locFilter = clickStore.locationFilter;
      const hasLocF = (locFilter.country && locFilter.country.trim()) ||
                      (locFilter.region && locFilter.region.trim()) ||
                      (locFilter.city && locFilter.city.trim());

      screenPosRef.current.forEach((sp, id) => {
        // CRITICAL: Skip members that don't match the active location filter
        // This prevents invisible (filtered-out) members from intercepting clicks
        if (hasLocF && !id.startsWith('aggregate:') && !id.startsWith('post:')) {
          if (!filteredIdsRef.current.has(id)) return;
        }
        const d = Math.sqrt((sp.x - mx) ** 2 + (sp.y - my) ** 2);
        if (d < closestDist) {
          closestDist = d;
          closest = id;
          // Determine type for better logging
          if (id.startsWith('aggregate:')) closestType = 'aggregate';
          else if (id.startsWith('post:')) closestType = 'post';
          else closestType = 'member';
        }
      });
      if (closest) {
        const screenPos = screenPosRef.current.get(closest);
        console.log(`[Click] Found ${closestType} "${closest.slice(0, 12)}..." at screen(${screenPos.x.toFixed(0)}, ${screenPos.y.toFixed(0)}) distance ${closestDist.toFixed(1)}px from click(${mx}, ${my})`);
      } else {
        console.log(`[Click] No clickable element within 25px of click(${mx}, ${my})`);
      }
      const store = useUniverseStore.getState();
      const cam = camRef.current;

      // Check if clicked an aggregate (id starts with 'aggregate:')
      if (closest && typeof closest === 'string' && closest.startsWith('aggregate:')) {
        const screenPos = screenPosRef.current.get(closest);
        if (screenPos && screenPos.memberIds && screenPos.memberIds.length > 0) {
          console.log(`[Click] Aggregate clicked (${screenPos.memberIds.length} members)`);

          // CRITICAL: Zoom to aggregate CENTROID position, not a specific member
          // The aggregate is rendered at its centroid, which may not match any individual member
          // Zooming to a member position would be visually incorrect
          let focusPos = screenPos.aggPos;

          if (focusPos) {
            console.log(`[Click] Zooming to aggregate centroid:`, focusPos);
            console.log(`[Click] Aggregate contains ${screenPos.memberIds.length} members`);
            console.log(`[Click] Current camera: pos=(${cam.focus.x.toFixed(1)}, ${cam.focus.y.toFixed(1)}, ${cam.focus.z.toFixed(1)}) dist=${cam.d.toFixed(1)} rot=(${cam.rx.toFixed(2)}, ${cam.ry.toFixed(2)})`);

            // Select first member for UI purposes (shows in detail panel)
            const representativeId = screenPos.memberIds[0];
            store.setSelectedMember(representativeId, { zoom: false });
            store.setSelectedPost(null);

            const targetDist = 20 + Math.sqrt(screenPos.memberIds.length) * 2;
            cam.tFocus = { x: focusPos.x, y: focusPos.y, z: focusPos.z };
            cam.td = targetDist;
            cam.trx = 0.3;
            cam.try = 0;
            cam.focusActive = true;
            cam.userZoomed = true;

            console.log(`[Click] Target camera: pos=(${cam.tFocus.x.toFixed(1)}, ${cam.tFocus.y.toFixed(1)}, ${cam.tFocus.z.toFixed(1)}) dist=${cam.td.toFixed(1)} rot=(${cam.trx.toFixed(2)}, ${cam.try.toFixed(2)})`);
          } else {
            console.warn(`[Click] Aggregate has no position data`);
          }
        }
      } else if (closest && typeof closest === 'string' && closest.startsWith('post:')) {
        const pid = closest.slice(5);
        const post = store.posts.get(pid);
        store.setSelectedPost(pid);
        // Also select the post's creator if not already selected
        if (post && post.creator) {
          store.setSelectedMember(post.creator, { zoom: false });
          const m = store.members.get(post.creator);
          // Use m.position if available (visual position for animated members)
          // Otherwise fall back to targetPos (static position)
          let focusPos = null;
          if (m && m.position) {
            focusPos = m.position;
          } else {
            focusPos = store.targetPos.get(post.creator);
          }
          if (focusPos) {
            cam.tFocus = { x: focusPos.x, y: focusPos.y, z: focusPos.z };
            cam.td = 1.5;
            // CRITICAL: Reset camera rotation to default when zooming to member
            cam.trx = 0.3;
            cam.try = 0;
            cam.focusActive = true;
            cam.userZoomed = true;
          }
        }
      } else if (closest) {
        store.setSelectedMember(closest, { zoom: false });
        store.setSelectedPost(null);
        const m = store.members.get(closest);
        // Use m.position if available (visual position for animated members)
        // Otherwise fall back to targetPos (static position)
        let focusPos = null;
        let posSource = 'none';
        if (m && m.position) {
          focusPos = m.position;
          posSource = 'm.position';
        } else {
          focusPos = store.targetPos.get(closest);
          posSource = 'targetPos';
        }
        if (focusPos) {
          console.log(`[Click] Member ${closest.slice(0, 8)}... zoom to ${posSource}:`, focusPos);
          console.log(`[Click] Camera before: focus=(${cam.focus.x.toFixed(1)},${cam.focus.y.toFixed(1)},${cam.focus.z.toFixed(1)}) rotation=(${cam.rx.toFixed(2)},${cam.ry.toFixed(2)}) dist=${cam.d.toFixed(1)}`);
          cam.tFocus = { x: focusPos.x, y: focusPos.y, z: focusPos.z };
          cam.td = 1.5;
          // CRITICAL: Reset camera rotation to default when zooming to member
          // Otherwise camera keeps current rotation and member might be off-screen
          cam.trx = 0.3;
          cam.try = 0;
          cam.focusActive = true;
          cam.userZoomed = true;
          console.log(`[Click] Camera target: focus=(${cam.tFocus.x.toFixed(1)},${cam.tFocus.y.toFixed(1)},${cam.tFocus.z.toFixed(1)}) rotation=(${cam.trx.toFixed(2)},${cam.try.toFixed(2)}) dist=${cam.td.toFixed(1)}`);
        } else {
          console.warn(`[Click] Member ${closest.slice(0, 8)}... NO POSITION FOUND`);
        }
      } else {
        store.setSelectedMember(null, { zoom: false });
        store.setSelectedPost(null);
        cam.tFocus = { x: 0, y: 0, z: 0 };
        cam.focusActive = false;
        cam.userZoomed = false;
      }
    };
    canvas.addEventListener('click', onClick);
    return () => canvas.removeEventListener('click', onClick);
  }, []);

  // Watch for zoom trigger from UI panels (e.g., PredictionPanel)
  const zoomToMemberTrigger = useUniverseStore((s) => s.zoomToMemberTrigger);
  useEffect(() => {
    console.log(`[Scene useEffect] zoomToMemberTrigger changed to:`, zoomToMemberTrigger);
    if (!zoomToMemberTrigger) return;

    const store = useUniverseStore.getState();
    const cam = camRef.current;
    const memberId = zoomToMemberTrigger;

    console.log(`[Panel Zoom] Triggered for member: ${memberId.slice(0, 8)}...`);

    // Get member position (same logic as canvas click)
    const m = store.members.get(memberId);
    let focusPos = null;
    if (m && m.position) {
      focusPos = m.position;
    } else {
      focusPos = store.targetPos.get(memberId);
    }

    if (focusPos) {
      console.log(`[Panel Zoom] Zooming to position:`, focusPos);
      cam.tFocus = { x: focusPos.x, y: focusPos.y, z: focusPos.z };
      cam.td = 1.5;
      cam.trx = 0.3;
      cam.try = 0;
      cam.focusActive = true;
      cam.userZoomed = true;

      // Clear the trigger so it can be reused
      store.setSelectedMember(memberId, { zoom: false });
    } else {
      console.warn(`[Panel Zoom] No position found for member ${memberId.slice(0, 8)}...`);
    }
  }, [zoomToMemberTrigger]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let time = 0;

    const BASE_D = 70;
    function project(p, camTransform) {
      const cam = camRef.current;
      const px = p.x - cam.focus.x, py = p.y - cam.focus.y, pz = p.z - cam.focus.z;
      const { cY, sY, cX, sX } = camTransform; // Use pre-computed trig values
      const x1 = px * cY - pz * sY, z1 = px * sY + pz * cY;
      const y1 = py * cX - z1 * sX, z2 = py * sX + z1 * cX;
      const s = cam.d / (cam.d + z2 + cam.d);
      const zoom = BASE_D / Math.max(cam.d, 0.1);
      const sc = Math.min(canvas.width, canvas.height) * 0.009 * zoom;
      return { x: canvas.width / 2 + x1 * sc * s, y: canvas.height / 2 - y1 * sc * s, z: z2, s: s * zoom };
    }

    function frame() {
      rafRef.current = requestAnimationFrame(frame);
      time = performance.now() * 0.001;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const cam = camRef.current;
      cam.rx += (cam.trx - cam.rx) * 0.06;
      cam.ry += (cam.try - cam.ry) * 0.06;
      cam.d += (cam.td - cam.d) * 0.06;
      cam.focus.x += (cam.tFocus.x - cam.focus.x) * 0.04;
      cam.focus.y += (cam.tFocus.y - cam.focus.y) * 0.04;
      cam.focus.z += (cam.tFocus.z - cam.focus.z) * 0.04;
      // Auto rotation disabled - camera stays at user-selected angle
      // if (!dragRef.current.active) cam.try += 0.0008;

      // OPTIMIZATION: Pre-compute camera transform once per frame (eliminates 16K+ trig ops)
      const camTransform = {
        cY: Math.cos(cam.ry),
        sY: Math.sin(cam.ry),
        cX: Math.cos(cam.rx),
        sX: Math.sin(cam.rx)
      };

      const store = useUniverseStore.getState();
      const training = useTrainingStore.getState();
      const prediction = usePredictionStore.getState();
      const { members, posts, comments, targetPos, selectedMember, selectedPost, performanceMode, locationFilter } = store;

      // ACTIVITY SPARKLES: Generate sparkles when new comments arrive
      // Only if not in performance mode and dataset is reasonable size
      if (!performanceMode && comments.size > lastCommentCountRef.current && comments.size < 5000) {
        const newCommentCount = comments.size - lastCommentCountRef.current;
        // Limit sparkle generation to avoid overwhelming the scene
        const sparklesToAdd = Math.min(newCommentCount, 10);

        // Get the most recent comments
        const recentComments = Array.from(comments.values())
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, sparklesToAdd);

        recentComments.forEach(comment => {
          const memberPos = targetPos.get(comment.fromMember);
          if (memberPos) {
            // Create sparkle with random velocity
            const angle = Math.random() * Math.PI * 2;
            const speed = 1.5 + Math.random() * 1.5;
            sparklesRef.current.push({
              pos: { ...memberPos },
              birthTime: time,
              duration: 1.2 + Math.random() * 0.6, // 1.2-1.8 seconds
              velocity: {
                x: Math.cos(angle) * speed,
                y: Math.sin(angle) * speed,
                z: (Math.random() - 0.5) * 0.8
              }
            });
          }
        });
      }
      lastCommentCountRef.current = comments.size;

      // Track selected member's position for focus
      // Use m.position if available (visual position for animated members)
      // Otherwise fall back to targetPos (for members not in current slice)
      if (cam.focusActive && selectedMember) {
        const m = members.get(selectedMember);
        let focusPos = null;
        if (m && m.position) {
          focusPos = m.position;
        } else {
          focusPos = targetPos.get(selectedMember);
        }
        if (focusPos) {
          cam.tFocus = { x: focusPos.x, y: focusPos.y, z: focusPos.z };
        }
      }

      // AMBIENT CAMERA DRIFT: Gentle sway when idle to make universe feel alive
      // Only applies when no user interaction and no active focus
      if (!dragRef.current.active && !cam.focusActive && !cam.userZoomed) {
        const driftX = Math.sin(time * 0.3) * 0.5;
        const driftY = Math.cos(time * 0.23) * 0.3;
        const driftZ = Math.sin(time * 0.17) * 0.2;
        cam.tFocus.x += driftX * 0.015;
        cam.tFocus.y += driftY * 0.015;
        cam.tFocus.z += driftZ * 0.01;
      }

      // --- LOCATION FILTER (applied at codec level) ---
      // The codec now encodes positions only for members matching the active
      // location filter, so targetPos only contains entries for visible members.
      // We use targetPos membership as the source of truth for visibility.
      const hasLocFilter = (locationFilter.country && locationFilter.country.trim()) ||
                           (locationFilter.region && locationFilter.region.trim()) ||
                           (locationFilter.city && locationFilter.city.trim());

      // Build visible members: only those with a position from the codec
      const locationVisible = hasLocFilter
        ? filterMembersByLocation(members, locationFilter)
        : members;

      // Apply temporal slice on the location-filtered set
      const slicer = slicerRef.current;
      const slicedMembers = slicer.slice(locationVisible, sliceOptions);
      const sliceInfo = slicer.getSliceInfo(locationVisible, slicedMembers);

      // Final filtered set: temporal-sliced subset of location-filtered members
      // Only members with a targetPos can actually render
      const filteredMembers = new Map();
      slicedMembers.forEach((m, id) => {
        if (targetPos.has(id)) filteredMembers.set(id, m);
      });

      // Update filtered IDs ref so click handler can validate targets
      const fIds = filteredIdsRef.current;
      fIds.clear();
      filteredMembers.forEach((_, id) => fIds.add(id));

      // Clear selection if the selected member is not in the filtered set
      if (selectedMember && !filteredMembers.has(selectedMember)) {
        store.setSelectedMember(null, { zoom: false });
        store.setSelectedPost(null);
      }

      // Detect filter changes — snap camera when filter changes
      const filterKey = `${locationFilter.country}|${locationFilter.region}|${locationFilter.city}`;
      const filterChanged = filterKey !== prevFilterRef.current;
      if (filterChanged) {
        prevFilterRef.current = filterKey;
        cam.userZoomed = false;
      }

      // OPTIMIZATION: Adaptive throttle based on visible member count
      const memberCount = filteredMembers.size;
      const tickInterval = memberCount > 1000 ? 66 : (memberCount > 500 ? 50 : 33);

      // Auto-zoom: use static target radius so camera distance matches universe size
      if (!dragRef.current.active && !cam.userZoomed) {
        const targetR = computeTargetRadius(memberCount);
        const ideal = Math.max(30, targetR * 0.7 + memberCount * 0.3);
        const zoomRate = filterChanged ? 0.3 : 0.01;
        cam.td += (ideal - cam.td) * zoomRate;
      }

      // --- Position updates: lerp toward codec target positions ---
      const now = performance.now();
      if (now - lastTickTimeRef.current > tickInterval || filterChanged) {
        lastTickTimeRef.current = now;

        filteredMembers.forEach((m, id) => {
          const target = targetPos.get(id);
          if (!target) return;

          if (filterChanged || !m.position) {
            // Snap instantly on filter change or first appearance
            m.position = { x: target.x, y: target.y, z: target.z };
            if (!m.opacity) m.opacity = 0;
            if (!m.scale) m.scale = 0;
          } else {
            // Smooth lerp to target (skip selected member while camera focuses)
            const isSelected = selectedMember === id;
            const isFocusing = cam.focusActive && isSelected;
            if (!isFocusing) {
              m.position = v3lerp(m.position, target, 0.04);
            }
          }
          m.opacity = (m.opacity ?? 0) + (0.9 - (m.opacity ?? 0)) * 0.03;
          m.scale = (m.scale ?? 0) + (1 - (m.scale ?? 0)) * 0.04;
        });
      }

      // Background stars
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (const bg of bgStarsRef.current) {
        const p = project(bg, camTransform);
        if (p.s > 0) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.3, p.s * 0.7), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Build sorted draw list
      const items = [];
      const seenB = {};

      // OPTIMIZATION: Turn off beams in performance mode or for large datasets
      const maxBeams = performanceMode ? 0 : (filteredMembers.size > 1000 ? 0 : Math.min(300, filteredMembers.size));
      let beamCount = 0;

      if (maxBeams > 0) {
        comments.forEach((c) => {
          if (beamCount >= maxBeams) return; // Skip if we've hit the limit
          const a = c.fromMember, b = c.toMember;
          const k = a < b ? a + '-' + b : b + '-' + a;
          if (seenB[k]) return;
          seenB[k] = 1;
          const fm = filteredMembers.get(a), tm = filteredMembers.get(b);
          if (fm?.position && tm?.position) {
            items.push({ type: 'beam', from: fm.position, to: tm.position, z: (fm.position.z + tm.position.z) / 2, sel: a === selectedMember || b === selectedMember });
            beamCount++;
          }
        });
      }

      // OPTIMIZATION: Cache prediction lookups outside the loop
      const predCache = new Map();
      if (prediction.active && prediction.predictions) {
        prediction.predictions.forEach((pred, id) => {
          if (pred.riskLevel !== 'unknown') {
            predCache.set(id, { riskLevel: pred.riskLevel, risk: pred.risk });
          }
        });
      }

      // Use sliced members for octree (slice already applied above)
      const octree = octreeRef.current;

      // Build member positions array (from filtered subset only)
      // Use m.position (visual position) so octree matches what's rendered
      const memberPositions = [];
      filteredMembers.forEach((m, id) => {
        if (m.position) {
          memberPositions.push({ id, position: m.position, mass: m.mass || 1 });
        }
      });

      // DEBUG: Log state every few seconds
      if (Math.floor(time) % 3 === 0 && Math.floor(time * 10) % 10 === 0) {
        console.log('[Scene] Temporal slice:', {
          totalMembers: members.size,
          slicedMembers: slicedMembers.size,
          filteredMembers: filteredMembers.size,
          sliceMode: sliceInfo.mode,
          percentageShown: sliceInfo.percentage + '%',
          withPositions: memberPositions.length,
          targetRadius: computeTargetRadius(filteredMembers.size).toFixed(1),
        });
      }

      // Rebuild octree periodically (not every frame - too expensive)
      // Also rebuild when members are added or removed (e.g. location filter applied)
      const octreeStats = octree.getStats();
      const shouldRebuild =
        octreeStats.memberCount === 0 || // First time
        octreeStats.memberCount !== memberPositions.length || // Members added or removed (filter change)
        Math.floor(time * 10) % 30 === 0; // Periodic update

      if (shouldRebuild && memberPositions.length > 0) {
        octree.rebuild(memberPositions);

        // Validate rebuild succeeded
        const stats = octree.getStats();
        if (stats.memberCount !== memberPositions.length) {
          console.warn('[Scene] Octree rebuild incomplete:', {
            expectedMembers: memberPositions.length,
            actualInOctree: stats.memberCount,
            possibleCause: 'Members outside octree bounds'
          });
        }
      }

      // Query visible members using distance-per-node LOD
      const frustum = getFrustumBounds(cam, { width: W, height: H });
      const lodInfo = getLODTier(cam.d);
      const cellSize = lodInfo.cellSize;
      // Use per-node distance LOD so closer octree nodes resolve at finer detail
      let visibleItems = octree.queryFrustumDistanceLOD(
        frustum,
        cam.focus,
        (dist) => getCellSize(dist)
      );

      // Fallback: if octree returns nothing but we have members, render all
      // This happens when members are still animating into position
      if (visibleItems.length === 0 && memberPositions.length > 0) {
        visibleItems = memberPositions;
        if (Math.floor(time * 10) % 50 === 0) {
          console.log('[Scene] Octree empty, using all members as fallback');
        }
      }

      // Render visible items (can be individual, representative, or aggregate)
      for (const item of visibleItems) {
        // Handle aggregates
        if (item.type === 'aggregate') {
          const p = project(item.position, camTransform);
          if (p.s > 0) {
            const size = 3 + Math.sqrt(item.count) * 2;
            items.push({
              type: 'aggregate',
              pos: item.position,
              count: item.count,
              opacity: item.opacity ?? 1,
              z: item.position.z,
              memberIds: item.memberIds,
              blendFactor: lodInfo.blendFactor,
            });
          }
          continue;
        }

        // Handle representative tier: top member + count badge
        if (item.type === 'representative') {
          const m = filteredMembers.get(item.id);
          if (!m) continue;
          const pos = m.position || item.position;
          const predData = predCache.get(item.id);
          items.push({
            type: 'representative',
            id: item.id,
            pos,
            mass: m.mass || 1,
            opacity: item.opacity ?? 0.9,
            scale: m.scale || 1,
            z: pos.z,
            sel: item.id === selectedMember,
            username: m.username,
            proPic: m.proPic || null,
            riskLevel: predData?.riskLevel || null,
            risk: predData?.risk || 0,
            count: item.count,
            blendFactor: lodInfo.blendFactor,
          });
          continue;
        }

        // Handle individual members
        const { id, position: pos } = item;
        const m = filteredMembers.get(id);
        if (!m) continue;

        const predData = predCache.get(id);
        const riskLevel = predData?.riskLevel || null;
        const risk = predData?.risk || 0;

        items.push({
          type: 'member',
          id,
          pos,
          mass: m.mass || 1,
          opacity: m.opacity || 0,
          scale: m.scale || 0,
          z: pos.z,
          sel: id === selectedMember,
          username: m.username,
          proPic: m.proPic || null,
          riskLevel,
          risk
        });
      }

      // Variables needed for posts and other rendering
      const focusPos = cam.focus;
      const lodDistance = cam.d * 2;

      // OPTIMIZATION: Turn off posts in performance mode or at scale
      if (!performanceMode && filteredMembers.size < 1500) {
        posts.forEach((post, pid) => {
          const a = filteredMembers.get(post.creator);
          if (!a?.position) return;

          // Skip posts from far-away members
          const dx = a.position.x - focusPos.x;
          const dy = a.position.y - focusPos.y;
          const dz = a.position.z - focusPos.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > lodDistance * lodDistance && post.creator !== selectedMember) return;

          const s = 'post:' + pid;
          const r = 1.2 + (post.commentCount || 0) * 0.15;
          const spd = 0.12 + seedToFloat(s + '_spd') * 0.3;
          const ph = seedToFloat(s + '_ph') * Math.PI * 2;
          const tilt = seedToFloat(s + '_tlt') * Math.PI * 0.35;
          const ang = time * spd + ph;
          const pos = {
            x: a.position.x + r * Math.cos(ang) * Math.cos(tilt),
            y: a.position.y + r * Math.sin(ang),
            z: a.position.z + r * Math.cos(ang) * Math.sin(tilt),
          };
          items.push({ type: 'post', pos, size: 0.08 + (post.commentCount || 0) * 0.03, z: pos.z, sel: post.creator === selectedMember, postSel: pid === selectedPost, image: post.image || null, pid });
        });
      }

      // Training: ghost stars + error lines
      if (training.active && training.optimalPositions) {
        if (training.showGhosts) {
          training.optimalPositions.forEach((pos, id) => {
            items.push({ type: 'ghost', pos, z: pos.z });
          });
        }
        if (training.showErrorLines) {
          training.optimalPositions.forEach((optPos, id) => {
            const predicted = targetPos.get(id);
            if (predicted) {
              const dx = predicted.x - optPos.x, dy = predicted.y - optPos.y, dz = predicted.z - optPos.z;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              items.push({ type: 'errorLine', from: predicted, to: optPos, dist, z: (predicted.z + optPos.z) / 2 });
            }
          });
        }
      }

      // Prediction: risk halos + drift vectors (disabled in performance mode or at scale)
      if (!performanceMode && prediction.active && prediction.predictions && filteredMembers.size < 1000) {
        if (prediction.showHalos) {
          prediction.predictions.forEach((pred, id) => {
            const m = filteredMembers.get(id);
            if (!m?.position || pred.riskLevel === 'unknown') return;
            items.push({ type: 'riskHalo', pos: m.position, riskLevel: pred.riskLevel, risk: pred.risk, z: m.position.z - 0.01, mass: m.mass || 1 });
          });
        }
        if (prediction.showDriftVectors) {
          prediction.predictions.forEach((pred, id) => {
            const m = filteredMembers.get(id);
            const target = targetPos.get(id);
            if (!m?.position || !target || pred.riskLevel === 'unknown') return;
            const dx = target.x - m.position.x, dy = target.y - m.position.y, dz = target.z - m.position.z;
            const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (mag < 0.05) return;
            const scale = Math.min(mag * 3, 4);
            const to = { x: m.position.x + (dx / mag) * scale, y: m.position.y + (dy / mag) * scale, z: m.position.z + (dz / mag) * scale };
            items.push({ type: 'driftVector', from: m.position, to, riskLevel: pred.riskLevel, z: m.position.z });
          });
        }

        // Relapse rings: expanding shockwaves from members with SoberDateChange resets
        if (prediction.showRelapseRings) {
          const sdcMap = store.soberDateChanges;
          if (sdcMap && sdcMap.size > 0) {
            // Build per-member relapse events
            const memberRelapses = new Map();
            sdcMap.forEach((sdc) => {
              if (sdc.setOnDayOne || !sdc.userId) return;
              const m = filteredMembers.get(sdc.userId);
              if (!m?.position) return;
              if (!memberRelapses.has(sdc.userId)) memberRelapses.set(sdc.userId, []);
              memberRelapses.get(sdc.userId).push(sdc);
            });
            memberRelapses.forEach((relapses, mid) => {
              const m = filteredMembers.get(mid);
              if (!m?.position) return;
              const relapseCount = relapses.length;
              // Animate rings: multiple concentric expanding circles
              for (let r = 0; r < Math.min(relapseCount, 3); r++) {
                items.push({
                  type: 'relapseRing',
                  pos: m.position,
                  z: m.position.z - 0.02,
                  ringIndex: r,
                  relapseCount,
                  mass: m.mass || 1,
                  daysSince: relapses[r].daysSince,
                });
              }
            });
          }
        }
      }

      items.sort((a, b) => a.z - b.z);
      screenPosRef.current.clear();

      // Performance monitoring (log every 5 seconds)
      if (Math.floor(time) % 5 === 0 && Math.floor(time * 10) % 10 === 0) {
        const visibleCount = visibleItems ? visibleItems.length : 0;
        const slicePercent = members.size > 0 ? Math.round((filteredMembers.size / members.size) * 100) : 0;
        const culledPercent = filteredMembers.size > 0 ? Math.round((1 - visibleCount / filteredMembers.size) * 100) : 0;
        console.log(`[Scene] Total: ${members.size}, Filtered: ${filteredMembers.size} (${slicePercent}%), Visible: ${visibleCount} (culled ${culledPercent}%), radius: ${computeTargetRadius(filteredMembers.size).toFixed(1)}`);
      }

      for (const item of items) {
        // OPTIMIZATION: Skip items too far behind camera (negative z in camera space)
        if (item.type === 'beam') {
          const p1 = project(item.from, camTransform), p2 = project(item.to, camTransform);
          if (p1.s > 0 && p2.s > 0 && p1.z > -100 && p2.z > -100) {
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = item.sel ? 'rgba(39,197,206,0.35)' : 'rgba(39,197,206,0.06)';
            ctx.lineWidth = item.sel ? 1.5 : 0.5;
            ctx.stroke();
          }
        } else if (item.type === 'aggregate') {
          // LOD: Render aggregated clusters
          // Filter aggregate memberIds to only include filtered members
          const validIds = item.memberIds ? item.memberIds.filter(id => filteredMembers.has(id)) : [];
          if (validIds.length === 0) continue; // Skip aggregate if no filtered members

          const p = project(item.pos, camTransform);
          if (p.s > 0 && p.z > -100) {
            const size = 3 + Math.sqrt(validIds.length) * 2;
            const radius = size * p.s;

            // CRITICAL: Make aggregates clickable by adding to screenPosRef
            // Use first filtered member ID from the aggregate as representative
            const representativeId = 'aggregate:' + validIds[0];
            screenPosRef.current.set(representativeId, { x: p.x, y: p.y, memberIds: validIds, aggPos: item.pos });

            // Blue cluster color — fade in with blendFactor during LOD transition
            const aggAlpha = item.opacity * (0.4 + (item.blendFactor || 0) * 0.2);
            ctx.fillStyle = `rgba(100, 150, 255, ${aggAlpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();

            // Label with count if big enough
            if (validIds.length > 5 && radius > 8) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
              ctx.font = `${Math.floor(size * 0.8)}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(validIds.length.toString(), p.x, p.y);
            }
          }
        } else if (item.type === 'representative') {
          // LOD: Representative tier — show top member of small cluster with count badge
          const p = project(item.pos, camTransform);
          if (p.s > 0 && p.z > -100) {
            screenPosRef.current.set(item.id, { x: p.x, y: p.y });
            const radius = (1.0 + Math.min(item.mass, 6) * 0.05) * p.s * item.scale;
            const intensity = Math.min(1, item.mass / 6);

            // Render the star core (same as individual member)
            let hue = 35 + intensity * 15;
            let sat = 85;
            let light = 60 + intensity * 25;
            if (item.riskLevel) {
              const r = item.risk;
              if (r < 0.3) { hue = 60; sat = r * 50; light = 90 - r * 20; }
              else if (r < 0.6) { const t = (r - 0.3) / 0.3; hue = 60 - t * 25; sat = 50 + t * 35; light = 70 - t * 10; }
              else { const t = (r - 0.6) / 0.4; hue = 35 - t * 35; sat = 85 + t * 10; light = 60 - t * 10; }
            }

            // Glow
            ctx.globalAlpha = item.opacity * 0.15;
            ctx.fillStyle = `hsla(${hue},${sat}%,${light}%,0.3)`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius * 1.5, 0, Math.PI * 2);
            ctx.fill();

            // Core
            ctx.globalAlpha = item.opacity;
            ctx.fillStyle = item.sel ? 'rgb(39,197,206)' : `hsla(${hue},${sat}%,${light}%,1)`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(1.2, radius), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;

            // Count badge — small number indicating cluster size
            if (item.count > 1) {
              const badgeX = p.x + radius + 3;
              const badgeY = p.y - radius - 1;
              const badgeR = 5;
              ctx.fillStyle = 'rgba(100,150,255,0.85)';
              ctx.beginPath();
              ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#fff';
              ctx.font = '8px sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(String(item.count), badgeX, badgeY);
            }
          }
        } else if (item.type === 'member-lod') {
          // LOD: Render distant members as simple colored dots
          const p = project(item.pos, camTransform);
          if (p.s > 0 && p.z > -100) {
            const radius = 1.5 * p.s; // Smaller radius for LOD

            // Risk-based color (simplified)
            const r = item.risk;
            let hue, sat, light;
            if (r < 0.3) {
              hue = 60; sat = 20; light = 85;
            } else if (r < 0.6) {
              hue = 40; sat = 60; light = 65;
            } else {
              hue = 0; sat = 90; light = 55;
            }

            ctx.fillStyle = `hsla(${hue},${sat}%,${light}%,${item.opacity * 0.6})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (item.type === 'member') {
          const p = project(item.pos, camTransform);
          if (p.s > 0) {
            screenPosRef.current.set(item.id, { x: p.x, y: p.y });

            // BREATHING ANIMATION: Subtle pulsing based on activity
            // Creates unique rhythm for each member, more active = stronger pulse
            const activityIntensity = Math.min(1, item.mass / 3); // 0-1 based on connections
            const uniquePhase = (item.id.charCodeAt(0) + item.id.charCodeAt(item.id.length - 1)) * 0.5; // Unique per member
            const breathPhase = Math.sin(time * 1.5 + uniquePhase) * 0.15; // Increased to 15% for visibility
            const breathMultiplier = 1 + (activityIntensity * breathPhase);

            // Smaller stars: reduced base from 1.5 to 1.0, reduced mass multiplier from 0.08 to 0.05
            const radius = (1.0 + Math.min(item.mass, 6) * 0.05) * p.s * item.scale * breathMultiplier;
            const intensity = Math.min(1, item.mass / 6);

            // Risk-based color: white (low risk) to red (high risk)
            let hue, sat, light, glowColor, coreColor;
            if (item.riskLevel) {
              // Risk mode: interpolate from white to red based on risk score
              const r = item.risk; // 0 = low risk, 1 = high risk
              if (r < 0.3) {
                // Low risk: white to light yellow
                hue = 60;
                sat = r * 50; // 0-15%
                light = 90 - r * 20; // 90-84%
                glowColor = `hsla(${hue},${sat}%,${light}%,${item.opacity * 0.3})`;
                coreColor = `hsla(${hue},${sat}%,${light}%,${item.opacity})`;
              } else if (r < 0.6) {
                // Medium risk: yellow to orange
                const t = (r - 0.3) / 0.3; // 0-1 within this range
                hue = 60 - t * 25; // 60 to 35 (yellow to orange)
                sat = 50 + t * 35; // 15 to 85%
                light = 70 - t * 10; // 84 to 60%
                glowColor = `hsla(${hue},${sat}%,${light}%,${item.opacity * 0.3})`;
                coreColor = `hsla(${hue},${sat}%,${light}%,${item.opacity})`;
              } else {
                // High risk: orange to red
                const t = (r - 0.6) / 0.4; // 0-1 within this range
                hue = 35 - t * 35; // 35 to 0 (orange to red)
                sat = 85 + t * 10; // 85 to 95%
                light = 60 - t * 10; // 60 to 50%
                glowColor = `hsla(${hue},${sat}%,${light}%,${item.opacity * 0.3})`;
                coreColor = `hsla(${hue},${sat}%,${light}%,${item.opacity})`;
              }
            } else {
              // Default mode: yellow/orange based on mass
              hue = 35 + intensity * 15;
              sat = 85;
              light = 60 + intensity * 25;
              glowColor = `hsla(${hue},${sat}%,${55 + intensity * 30}%,${item.opacity * 0.3})`;
              coreColor = `hsla(${hue},${sat}%,${light}%,${item.opacity})`;
            }

            // OPTIMIZATION: Use solid fills with globalAlpha instead of expensive gradients
            // Selection glow (smaller, reduced from 3.5x to 2.5x)
            if (item.sel) {
              ctx.globalAlpha = 0.15;
              ctx.fillStyle = 'rgb(39,197,206)';
              ctx.beginPath();
              ctx.arc(p.x, p.y, radius * 2.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.globalAlpha = 1.0;
            }

            // Star glow (smaller, reduced from 2x to 1.5x)
            ctx.globalAlpha = item.opacity * 0.15;
            ctx.fillStyle = glowColor;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius * 1.5, 0, Math.PI * 2);
            ctx.fill();

            // Star core
            ctx.globalAlpha = item.opacity;
            ctx.fillStyle = item.sel ? 'rgb(39,197,206)' : coreColor;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(1.2, radius), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;

            // Profile picture + label (only for selected member)
            if (item.sel) {
              const picR = Math.min(Math.max(radius, 8), 10);
              let hasPic = false;
              if (item.proPic) {
                let img = imgCacheRef.current.get(item.id);
                if (!img) {
                  img = new Image();
                  img.crossOrigin = 'anonymous';
                  img.src = item.proPic;
                  imgCacheRef.current.set(item.id, img);
                }
                if (img.complete && img.naturalWidth > 0) {
                  hasPic = true;
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, picR, 0, Math.PI * 2);
                  ctx.clip();
                  ctx.drawImage(img, p.x - picR, p.y - picR, picR * 2, picR * 2);
                  ctx.restore();
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, picR, 0, Math.PI * 2);
                  ctx.strokeStyle = 'rgba(39,197,206,0.6)';
                  ctx.lineWidth = 1.5;
                  ctx.stroke();
                }
              }
              ctx.font = '11px system-ui';
              ctx.fillStyle = 'rgba(39,197,206,0.8)';
              ctx.textAlign = 'center';
              const labelY = p.y - (hasPic ? picR : radius) - 8;
              ctx.fillText(item.username, p.x, labelY);
            }
          }
        } else if (item.type === 'post') {
          const p = project(item.pos, camTransform);
          if (p.s > 0) {
            const r = Math.max(0.6, item.size * 6 * p.s);
            const isPostSel = item.postSel;
            if (item.sel || isPostSel) {
              // OPTIMIZATION: Solid fill instead of gradient
              ctx.globalAlpha = isPostSel ? 0.2 : 0.12;
              ctx.fillStyle = 'rgb(155,89,182)';
              ctx.beginPath();
              ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
              ctx.fill();
              ctx.globalAlpha = 1.0;
            }
            // Only show post image when its parent member is selected
            let hasPostImg = false;
            if (item.image && item.sel) {
              const imgKey = 'post:' + item.pid;
              let img = imgCacheRef.current.get(imgKey);
              if (!img) {
                img = new Image();
                img.crossOrigin = 'anonymous';
                img.src = item.image;
                imgCacheRef.current.set(imgKey, img);
              }
              if (img.complete && img.naturalWidth > 0) {
                hasPostImg = true;
                const imgR = Math.min(Math.max(r, 4), 8);
                ctx.save();
                ctx.beginPath();
                ctx.arc(p.x, p.y, imgR, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(img, p.x - imgR, p.y - imgR, imgR * 2, imgR * 2);
                ctx.restore();
                ctx.beginPath();
                ctx.arc(p.x, p.y, imgR, 0, Math.PI * 2);
                ctx.strokeStyle = isPostSel ? 'rgba(255,255,255,0.7)' : 'rgba(155,89,182,0.5)';
                ctx.lineWidth = isPostSel ? 1.5 : 0.8;
                ctx.stroke();
              }
            }
            if (!hasPostImg) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
              ctx.fillStyle = isPostSel ? 'rgba(255,255,255,0.9)' : item.sel ? 'rgba(155,89,182,0.8)' : 'rgba(155,89,182,0.35)';
              ctx.fill();
              if (isPostSel) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(155,89,182,0.6)';
                ctx.lineWidth = 1;
                ctx.stroke();
              }
            }
            // Track post screen position for click detection
            screenPosRef.current.set('post:' + item.pid, { x: p.x, y: p.y });
          }
        } else if (item.type === 'ghost') {
          const p = project(item.pos, camTransform);
          if (p.s > 0) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3 * p.s, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(180,140,255,0.15)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        } else if (item.type === 'errorLine') {
          const p1 = project(item.from, camTransform), p2 = project(item.to, camTransform);
          if (p1.s > 0 && p2.s > 0) {
            const color = item.dist < 5 ? 'rgba(0,255,100,0.25)' : item.dist < 15 ? 'rgba(255,220,80,0.25)' : 'rgba(255,80,60,0.25)';
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.8;
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else if (item.type === 'riskHalo') {
          const p = project(item.pos, camTransform);
          if (p.s > 0) {
            const baseR = (2.5 + Math.min(item.mass, 6) * 0.15) * p.s;
            let haloR, haloColor;
            if (item.riskLevel === 'high') {
              const pulse = 1 + Math.sin(time * 3) * 0.15;
              haloR = baseR * 4 * pulse;
              haloColor = 'rgba(255,80,56,0.15)';
            } else if (item.riskLevel === 'watch') {
              haloR = baseR * 3;
              haloColor = 'rgba(255,200,60,0.10)';
            } else {
              haloR = baseR * 2.5;
              haloColor = 'rgba(60,220,120,0.06)';
            }
            // OPTIMIZATION: Solid fill instead of gradient
            ctx.fillStyle = haloColor;
            ctx.beginPath();
            ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (item.type === 'driftVector') {
          const p1 = project(item.from, camTransform), p2 = project(item.to, camTransform);
          if (p1.s > 0 && p2.s > 0) {
            const color = item.riskLevel === 'high' ? 'rgba(255,80,56,0.3)' : item.riskLevel === 'watch' ? 'rgba(255,200,60,0.2)' : 'rgba(60,220,120,0.15)';
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.stroke();
            // Arrowhead
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 3) {
              const ax = dx / len, ay = dy / len;
              ctx.beginPath();
              ctx.moveTo(p2.x, p2.y);
              ctx.lineTo(p2.x - ax * 4 + ay * 2, p2.y - ay * 4 - ax * 2);
              ctx.lineTo(p2.x - ax * 4 - ay * 2, p2.y - ay * 4 + ax * 2);
              ctx.closePath();
              ctx.fillStyle = color;
              ctx.fill();
            }
          }
        } else if (item.type === 'relapseRing') {
          const p = project(item.pos, camTransform);
          if (p.s > 0) {
            const baseR = (2.5 + Math.min(item.mass, 6) * 0.15) * p.s;
            // Animated expanding ring per relapse event
            const speed = 1.2 + item.ringIndex * 0.5;
            const phase = (time * speed + item.ringIndex * 2.1) % 4;
            const ringR = baseR * (2 + phase * 2.5);
            const alpha = Math.max(0, 0.35 - phase * 0.09) * Math.min(1, item.relapseCount * 0.5);
            if (alpha > 0.01) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255,56,56,${alpha})`;
              ctx.lineWidth = Math.max(0.5, 1.5 - phase * 0.3);
              ctx.stroke();
            }
            // Static inner marker: small filled circle for confirmed relapse
            if (item.ringIndex === 0) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, baseR * 1.4, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(255,56,56,${0.08 + Math.sin(time * 2) * 0.04})`;
              ctx.fill();
            }
          }
        }
      }
    }

    // ACTIVITY SPARKLES: Render expanding sparkles for recent activity
    // Clean up expired sparkles and render active ones
    sparklesRef.current = sparklesRef.current.filter(s => time - s.birthTime < s.duration);
    sparklesRef.current.forEach(s => {
      const age = time - s.birthTime;
      const progress = age / s.duration;
      const alpha = 1 - progress; // Fade out over lifetime

      // Move sparkle based on velocity
      const pos = {
        x: s.pos.x + s.velocity.x * age,
        y: s.pos.y + s.velocity.y * age,
        z: s.pos.z + s.velocity.z * age
      };

      const p = project(pos, camTransform);
      if (p.s > 0 && alpha > 0.01) {
        // Sparkle expands slightly as it fades
        const size = (1 + progress * 2) * p.s;
        ctx.fillStyle = `rgba(255, 255, 150, ${alpha * 0.8})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 0 }}
    />
  );
}
