(() => {
  "use strict";

  // =========================================================
  // 상태 관리
  // =========================================================
  const state = {
    isRunning: true,
    simulationSpeed: 60, // 배속 (1x ~ 200x)
    mode: "shuttle", // "shuttle" | "loop"
    bufferKm: 5,
    showLabels: true,
    trains: [],
    trainMarkers: new Map(), // id -> L.Marker
    routeCache: new Map(), // key -> { segmentLengths, totalLength }
    followingTrainId: null,
    selectedPopupTrainId: null,
    nextTrainSeq: 109,
    lastFrameTime: null,
    lastUiSyncTime: 0,
    availableRoutes: [],
  };

  // =========================================================
  // DOM 요소
  // =========================================================
  const el = {
    sidebar: document.getElementById("control-sidebar"),
    backdrop: document.getElementById("sidebar-backdrop"),
    toggleSidebarBtn: document.getElementById("toggle-sidebar-btn"),
    closeSidebarBtn: document.getElementById("close-sidebar-btn"),
    playPauseBtn: document.getElementById("play-pause-btn"),
    headerPlayBtn: document.getElementById("header-play-btn"),
    addTrainBtn: document.getElementById("add-train-btn"),
    resetTrainsBtn: document.getElementById("reset-trains-btn"),
    speedSlider: document.getElementById("speed-slider"),
    speedBadge: document.getElementById("speed-badge"),
    speedValueText: document.getElementById("speed-value-text"),
    modeSelect: document.getElementById("mode-select"),
    bufferSelect: document.getElementById("buffer-select"),
    bufferBadge: document.getElementById("buffer-badge"),
    toggleLabels: document.getElementById("toggle-labels"),
    trainList: document.getElementById("train-list"),
    unfollowBtn: document.getElementById("unfollow-btn"),
    headerTrainCount: document.getElementById("header-train-count"),
    simStatusPill: document.getElementById("sim-status-pill"),
    simStatusDot: document.getElementById("sim-status-dot"),
    simStatusText: document.getElementById("sim-status-text"),
    mapLoading: document.getElementById("map-loading"),
    mapLegend: document.getElementById("map-legend"),
    toggleLegendBtn: document.getElementById("toggle-legend-btn"),
    legendNonOverlapText: document.getElementById("legend-non-overlap-text"),
    legendOverlapText: document.getElementById("legend-overlap-text"),
    statLength: document.getElementById("stat-length"),
    statTotalArea: document.getElementById("stat-total-area"),
    statNonOverlap: document.getElementById("stat-non-overlap"),
    statOverlap: document.getElementById("stat-overlap"),
    statOverlapPct: document.getElementById("stat-overlap-pct"),
  };

  // =========================================================
  // Leaflet 지도 & 레이어 초기화
  // =========================================================
  const map = L.map("map", {
    center: [36.4, 127.8],
    zoom: 7,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);

  L.control.scale({ imperial: false }).addTo(map);

  const nonOverlapGroup = L.layerGroup().addTo(map);
  const overlapGroup = L.layerGroup().addTo(map);
  const routesGroup = L.layerGroup().addTo(map);
  const trainsGroup = L.layerGroup().addTo(map);

  const overlayMaps = {
    "5km 비중첩 영역": nonOverlapGroup,
    "5km 중첩 영역": overlapGroup,
    "철도 노선": routesGroup,
    "이동 중인 열차": trainsGroup,
  };

  L.control
    .layers(null, overlayMaps, {
      collapsed: window.innerWidth < 768,
      position: "topright",
    })
    .addTo(map);

  // =========================================================
  // 지리 거리 및 보간 계산 (부드러운 60fps 연속 이동)
  // =========================================================
  function distanceKm(a, b) {
    const R = 6371;
    const dLat = ((b[0] - a[0]) * Math.PI) / 180;
    const dLon = ((b[1] - a[1]) * Math.PI) / 180;
    const lat1 = (a[0] * Math.PI) / 180;
    const lat2 = (b[0] * Math.PI) / 180;

    const x =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function getRouteInfo(coords) {
    const key = JSON.stringify(coords);
    if (state.routeCache.has(key)) {
      return state.routeCache.get(key);
    }

    const segmentLengths = [];
    let totalLength = 0;

    for (let i = 0; i < coords.length - 1; i += 1) {
      const d = distanceKm(coords[i], coords[i + 1]);
      segmentLengths.push(d);
      totalLength += d;
    }

    const info = { segmentLengths, totalLength };
    state.routeCache.set(key, info);
    return info;
  }

  function getPosition(coords, progress) {
    const clamped = Math.max(0, Math.min(1, progress));
    const info = getRouteInfo(coords);
    const targetDistance = info.totalLength * clamped;
    let accumulated = 0;

    for (let i = 0; i < coords.length - 1; i += 1) {
      const segment = info.segmentLengths[i];
      if (accumulated + segment >= targetDistance && segment > 0) {
        const ratio = (targetDistance - accumulated) / segment;
        const lat = coords[i][0] + (coords[i + 1][0] - coords[i][0]) * ratio;
        const lon = coords[i][1] + (coords[i + 1][1] - coords[i][1]) * ratio;
        return [lat, lon];
      }
      accumulated += segment;
    }

    return coords[coords.length - 1];
  }

  // =========================================================
  // 지리 데이터 (버퍼 & 노선) 로드
  // =========================================================
  async function loadGeodata(bufferKm) {
    el.mapLoading.classList.remove("hidden");
    try {
      const res = await fetch(`/api/geodata?buffer_km=${encodeURIComponent(bufferKm)}`);
      if (!res.ok) throw new Error("지리 데이터를 불러오지 못했습니다.");
      const data = await res.json();

      nonOverlapGroup.clearLayers();
      overlapGroup.clearLayers();
      routesGroup.clearLayers();

      if (data.non_overlap_geojson) {
        L.geoJSON(data.non_overlap_geojson, {
          style: {
            fillColor: "#3388ff",
            color: "#3388ff",
            weight: 1,
            opacity: 0.55,
            fillOpacity: 0.25,
          },
        })
          .bindTooltip(`철도 기준 ${data.buffer_km}km 비중첩 영역`)
          .addTo(nonOverlapGroup);
      }

      if (data.overlap_geojson) {
        L.geoJSON(data.overlap_geojson, {
          style: {
            fillColor: "#ff0000",
            color: "#ff0000",
            weight: 1,
            opacity: 0.65,
            fillOpacity: 0.45,
          },
        })
          .bindTooltip(`철도 기준 ${data.buffer_km}km 중첩 영역`)
          .addTo(overlapGroup);
      }

      state.availableRoutes = data.routes || [];
      state.availableRoutes.forEach((route) => {
        L.polyline(route.coords, {
          color: "#222222",
          weight: 4,
          opacity: 0.85,
        })
          .bindTooltip(`${route.name} (${route.length_km} km)`)
          .addTo(routesGroup);
      });

      // 통계 및 범례 문구 갱신
      const stats = data.stats;
      el.bufferBadge.textContent = `${data.buffer_km} km`;
      el.legendNonOverlapText.textContent = `${data.buffer_km}km 비중첩 영역`;
      el.legendOverlapText.textContent = `${data.buffer_km}km 중첩 영역`;
      el.statLength.textContent = `${stats.total_length_km.toLocaleString()} km`;
      el.statTotalArea.textContent = `${stats.total_area_km2.toLocaleString()} km²`;
      el.statNonOverlap.textContent = `${stats.non_overlap_area_km2.toLocaleString()} km²`;
      el.statOverlap.textContent = `${stats.overlap_area_km2.toLocaleString()} km²`;
      el.statOverlapPct.textContent = `${stats.overlap_ratio_pct}%`;
    } catch (err) {
      console.error(err);
      alert("지도 데이터를 불러오는 중 오류가 발생했습니다.");
    } finally {
      el.mapLoading.classList.add("hidden");
    }
  }

  // =========================================================
  // 열차 마커 & 팝업 & 사이드바 목록
  // =========================================================
  function createTrainIcon(train) {
    const isFollowing = state.followingTrainId === train.id;
    return L.divIcon({
      className: "train-icon",
      html: `
        <div class="train-marker-wrap ${isFollowing ? "following" : ""}">
          <span class="train-pulse-ring"></span>
          <span class="train-label-tag">${train.name}</span>
          <div class="train-badge-core">🚄</div>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
  }

  function formatPopupHtml(train, pos) {
    const dirLabel = train.direction > 0 ? "하행 (정방향)" : "상행 (역방향)";
    const pct = (train.progress * 100).toFixed(1);
    return `
      <div style="min-width:170px; line-height:1.5;">
        <div style="font-weight:700; font-size:14px; margin-bottom:4px;">🚄 ${train.name}</div>
        <div><b>노선:</b> ${train.route}</div>
        <div><b>속도:</b> ${train.speed} km/h</div>
        <div><b>운행 방향:</b> ${dirLabel}</div>
        <div><b>진행률:</b> ${pct}%</div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">
          위치: ${pos[0].toFixed(4)}, ${pos[1].toFixed(4)}
        </div>
      </div>
    `;
  }

  function clearAllTrains() {
    trainsGroup.clearLayers();
    state.trainMarkers.clear();
    state.trains = [];
    setFollowingTrain(null);
  }

  function addTrainToMap(train) {
    state.trains.push(train);
    const pos = getPosition(train.coords, train.progress);

    const marker = L.marker(pos, {
      icon: createTrainIcon(train),
      zIndexOffset: 1000,
    }).addTo(trainsGroup);

    marker.bindPopup(formatPopupHtml(train, pos));
    marker.on("popupopen", () => {
      state.selectedPopupTrainId = train.id;
    });
    marker.on("popupclose", () => {
      if (state.selectedPopupTrainId === train.id) {
        state.selectedPopupTrainId = null;
      }
    });
    marker.on("click", () => {
      setFollowingTrain(train.id);
    });

    state.trainMarkers.set(train.id, marker);
  }

  async function loadInitialTrains(count = 8) {
    try {
      const res = await fetch(`/api/trains?count=${count}`);
      if (!res.ok) throw new Error("열차 데이터를 불러오지 못했습니다.");
      const data = await res.json();
      clearAllTrains();
      data.trains.forEach(addTrainToMap);
      state.nextTrainSeq = 101 + data.trains.length;
      renderTrainList();
    } catch (err) {
      console.error(err);
    }
  }

  function spawnExtraTrain() {
    if (!state.availableRoutes.length) return;
    const routeObj =
      state.availableRoutes[Math.floor(Math.random() * state.availableRoutes.length)];
    const seq = state.nextTrainSeq++;
    const train = {
      id: `train-${seq}`,
      name: `KTX-${seq}`,
      route: routeObj.name,
      coords: routeObj.coords,
      progress: Number((Math.random() * 0.8 + 0.1).toFixed(4)),
      speed: Math.floor(Math.random() * 121) + 140,
      direction: Math.random() < 0.5 ? 1 : -1,
    };
    addTrainToMap(train);
    renderTrainList();
    setFollowingTrain(train.id);
  }

  function setFollowingTrain(trainId) {
    const prevId = state.followingTrainId;
    state.followingTrainId = trainId;
    el.unfollowBtn.hidden = !trainId;

    [prevId, trainId].forEach((id) => {
      if (!id) return;
      const train = state.trains.find((t) => t.id === id);
      const marker = state.trainMarkers.get(id);
      if (train && marker) {
        marker.setIcon(createTrainIcon(train));
      }
    });

    if (trainId) {
      const marker = state.trainMarkers.get(trainId);
      if (marker) {
        map.panTo(marker.getLatLng(), { animate: true });
      }
    }
    renderTrainList();
  }

  function renderTrainList() {
    el.headerTrainCount.textContent = String(state.trains.length);
    if (!state.trains.length) {
      el.trainList.innerHTML = `<div class="empty-state">운행 중인 열차가 없습니다.</div>`;
      return;
    }

    el.trainList.innerHTML = state.trains
      .map((train) => {
        const isFollowing = state.followingTrainId === train.id;
        const pct = (train.progress * 100).toFixed(1);
        const dirText = train.direction > 0 ? "정방향 →" : "← 역방향";
        return `
          <div class="train-item ${isFollowing ? "following" : ""}" data-train-id="${train.id}">
            <div class="train-item-top">
              <span class="train-name">🚄 ${train.name}</span>
              <span class="train-speed">${train.speed} km/h</span>
            </div>
            <div class="train-item-meta">
              <span>${train.route}</span>
              <span data-role="dir-pct">${dirText} · ${pct}%</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function updateTrainListProgressOnly() {
    state.trains.forEach((train) => {
      const card = el.trainList.querySelector(`[data-train-id="${train.id}"]`);
      if (!card) return;
      const pct = (train.progress * 100).toFixed(1);
      const dirText = train.direction > 0 ? "정방향 →" : "← 역방향";
      const meta = card.querySelector('[data-role="dir-pct"]');
      const bar = card.querySelector(".progress-fill");
      if (meta) meta.textContent = `${dirText} · ${pct}%`;
      if (bar) bar.style.width = `${pct}%`;
    });
  }

  // =========================================================
  // 60fps 연속 시뮬레이션 루프 (requestAnimationFrame)
  // =========================================================
  function stepSimulation(timestamp) {
    if (state.lastFrameTime === null) {
      state.lastFrameTime = timestamp;
    }
    const dtSeconds = Math.min((timestamp - state.lastFrameTime) / 1000, 0.1);
    state.lastFrameTime = timestamp;

    if (state.isRunning && state.trains.length > 0) {
      state.trains.forEach((train) => {
        const info = getRouteInfo(train.coords);
        const totalLength = info.totalLength || 1;
        const movement =
          (train.speed / 3600 / totalLength) * state.simulationSpeed * dtSeconds;

        train.progress += movement * train.direction;

        if (state.mode === "shuttle") {
          if (train.progress >= 1) {
            train.progress = 1 - (train.progress - 1);
            train.direction = -1;
          } else if (train.progress <= 0) {
            train.progress = Math.abs(train.progress);
            train.direction = 1;
          }
        } else {
          // 연속 순환 모드: 종점 도달 시 반대편 기점에서 끊임없이 연속 재진입
          if (train.progress >= 1) {
            train.progress = train.progress % 1;
          } else if (train.progress < 0) {
            train.progress = 1 + (train.progress % 1);
          }
        }

        const newPos = getPosition(train.coords, train.progress);
        const marker = state.trainMarkers.get(train.id);
        if (marker) {
          marker.setLatLng(newPos);

          if (state.selectedPopupTrainId === train.id && marker.isPopupOpen()) {
            marker.setPopupContent(formatPopupHtml(train, newPos));
          }

          if (state.followingTrainId === train.id) {
            map.panTo(newPos, { animate: false });
          }
        }
      });

      // DOM 텍스트 업데이트는 약 120ms 간격으로 스로틀링해 성능 최적화
      if (timestamp - state.lastUiSyncTime > 120) {
        state.lastUiSyncTime = timestamp;
        updateTrainListProgressOnly();
      }
    }

    requestAnimationFrame(stepSimulation);
  }

  // =========================================================
  // UI 이벤트 바인딩 & 반응형 사이드바/드로어 제어
  // =========================================================
  function isMobileViewport() {
    return window.innerWidth <= 991;
  }

  function openMobileSidebar() {
    el.sidebar.classList.add("open");
    el.backdrop.hidden = false;
    el.backdrop.classList.add("visible");
    el.toggleSidebarBtn.setAttribute("aria-expanded", "true");
  }

  function closeMobileSidebar() {
    el.sidebar.classList.remove("open");
    el.backdrop.classList.remove("visible");
    el.backdrop.hidden = true;
    el.toggleSidebarBtn.setAttribute("aria-expanded", "false");
  }

  function toggleSidebar() {
    if (isMobileViewport()) {
      if (el.sidebar.classList.contains("open")) {
        closeMobileSidebar();
      } else {
        openMobileSidebar();
      }
    } else {
      const collapsed = el.sidebar.classList.toggle("collapsed");
      el.toggleSidebarBtn.setAttribute("aria-expanded", String(!collapsed));
      setTimeout(() => map.invalidateSize(), 260);
    }
  }

  function syncPlayStateUI() {
    const label = state.isRunning ? "⏸ 일시정지" : "▶ 운행 재개";
    el.playPauseBtn.textContent = label;
    el.headerPlayBtn.textContent = label;

    el.simStatusPill.classList.toggle("paused", !state.isRunning);
    el.simStatusDot.classList.toggle("running", state.isRunning);
    el.simStatusDot.classList.toggle("paused", !state.isRunning);
    el.simStatusText.textContent = state.isRunning ? "연속 운행 중" : "일시정지됨";
  }

  el.toggleSidebarBtn.addEventListener("click", toggleSidebar);
  el.closeSidebarBtn.addEventListener("click", closeMobileSidebar);
  el.backdrop.addEventListener("click", closeMobileSidebar);

  const togglePlay = () => {
    state.isRunning = !state.isRunning;
    syncPlayStateUI();
  };
  el.playPauseBtn.addEventListener("click", togglePlay);
  el.headerPlayBtn.addEventListener("click", togglePlay);

  el.addTrainBtn.addEventListener("click", spawnExtraTrain);
  el.resetTrainsBtn.addEventListener("click", () => loadInitialTrains(8));
  el.unfollowBtn.addEventListener("click", () => setFollowingTrain(null));

  el.speedSlider.addEventListener("input", (e) => {
    state.simulationSpeed = Number(e.target.value);
    el.speedBadge.textContent = `${state.simulationSpeed}x`;
    el.speedValueText.textContent = `${state.simulationSpeed}배속`;
  });

  el.modeSelect.addEventListener("change", (e) => {
    state.mode = e.target.value;
  });

  el.bufferSelect.addEventListener("change", (e) => {
    state.bufferKm = Number(e.target.value);
    loadGeodata(state.bufferKm);
  });

  el.toggleLabels.addEventListener("change", (e) => {
    state.showLabels = e.target.checked;
    document.getElementById("map").classList.toggle("hide-train-labels", !state.showLabels);
  });

  el.trainList.addEventListener("click", (e) => {
    const card = e.target.closest("[data-train-id]");
    if (!card) return;
    const trainId = card.getAttribute("data-train-id");
    setFollowingTrain(state.followingTrainId === trainId ? null : trainId);
    const marker = state.trainMarkers.get(trainId);
    if (marker) {
      marker.openPopup();
    }
    if (isMobileViewport()) {
      closeMobileSidebar();
    }
  });

  el.toggleLegendBtn.addEventListener("click", () => {
    const collapsed = el.mapLegend.classList.toggle("collapsed");
    el.toggleLegendBtn.textContent = collapsed ? "▸" : "▾";
  });

  window.addEventListener("resize", () => {
    if (!isMobileViewport()) {
      closeMobileSidebar();
    }
    map.invalidateSize();
  });

  // 모바일 초기 진입 시 범례를 기본 접힘 상태로 둘 수도 있지만, 내용 확인을 위해 600px 미만에서만 접기
  if (window.innerWidth <= 480) {
    el.mapLegend.classList.add("collapsed");
    el.toggleLegendBtn.textContent = "▸";
  }

  // =========================================================
  // 앱 시작
  // =========================================================
  (async function init() {
    syncPlayStateUI();
    await loadGeodata(state.bufferKm);
    await loadInitialTrains(8);
    requestAnimationFrame(stepSimulation);
  })();
})();
