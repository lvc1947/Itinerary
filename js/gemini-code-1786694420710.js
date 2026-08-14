/**
 * =================================================================
 * 1. Application Constants (설정 및 상수)
 * =================================================================
 */
const CONFIG = Object.freeze({
  NOMINATIM_EMAIL: 'ktw7024@gmail.com',
  API_DELAY_MS: 1000,
  EARTH_RADIUS_KM: 6371,
  FLIGHT_ARC_SEGMENTS: 50,
  FLIGHT_ARC_HEIGHT_MODIFIER: 0.15,
  DEFAULT_MAP_CENTER: [42.15, 77.05],
  DEFAULT_ZOOM: 9
});

/**
 * =================================================================
 * 2. Helper Classes (유틸리티 및 기하학 계산)
 * =================================================================
 */
class Utils {
  static escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

class GeoMath {
  static toRad(value) { 
    return (value * Math.PI) / 180; 
  }

  static calculateHaversineDistance(start, end) {
    const dLat = this.toRad(end.lat - start.lat);
    const dLon = this.toRad(end.lon - start.lon);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(start.lat)) * Math.cos(this.toRad(end.lat)) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return CONFIG.EARTH_RADIUS_KM * c;
  }

  static generateFlightArc(start, end) {
    const coords = [];
    const dLat = end.lat - start.lat;
    const dLon = end.lon - start.lon;
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    const maxOffset = dist * CONFIG.FLIGHT_ARC_HEIGHT_MODIFIER; 

    for (let i = 0; i <= CONFIG.FLIGHT_ARC_SEGMENTS; i++) {
      const t = i / CONFIG.FLIGHT_ARC_SEGMENTS;
      const lat = start.lat + (dLat * t);
      const lon = start.lon + (dLon * t);
      const offset = maxOffset * (4 * t * (1 - t));
      coords.push([lat + offset, lon]);
    }
    return coords;
  }
}

/**
 * =================================================================
 * 3. API Services (주소 검색 및 경로 탐색)
 * =================================================================
 */
class GeocodingService {
  static cache = new Map();

  static async getCoordinates(cityName) {
    const query = cityName.trim();
    const cacheKey = query.toLowerCase();

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const data = await this.fetchNominatim(query);

    if (!data || data.length === 0) {
      throw new Error(`Location "${Utils.escapeHtml(query)}" not found.`);
    }

    const result = {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      displayName: data[0].display_name
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  static async fetchNominatim(q) {
    const encodedQuery = encodeURIComponent(q);
    const encodedEmail = encodeURIComponent(CONFIG.NOMINATIM_EMAIL);
    const url = `https://nominatim.openstreetmap.org/search?format=json&email=${encodedEmail}&q=${encodedQuery}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Geocoding service unavailable.');
    return await response.json();
  }

  static isCached(cityName) {
    return this.cache.has(cityName.trim().toLowerCase());
  }
}

class RoutingService {
  static MODE_CONFIGS = Object.freeze({
    driving: {
      baseStyle: { color: '#1e293b', weight: 8, opacity: 0.9 },
      overlayStyle: { color: '#facc15', weight: 2, dashArray: '8, 8' },
      icon: '🚗'
    },
    train: {
      baseStyle: { color: '#0f172a', weight: 7, opacity: 0.95 },
      overlayStyle: { color: '#ffffff', weight: 3, dashArray: '6, 6' },
      icon: '🚅'
    },
    plane: {
      baseStyle: { color: '#c084fc', weight: 4, dashArray: '6, 6', opacity: 0.9 },
      overlayStyle: null,
      icon: '✈'
    },
    foot: {
      baseStyle: { color: '#4ade80', weight: 4, dashArray: '3, 7', opacity: 0.95 },
      overlayStyle: null,
      icon: '🚶'
    },
    bike: {
      baseStyle: { color: '#fb923c', weight: 4, dashArray: '7, 7', opacity: 0.95 },
      overlayStyle: null,
      icon: '🚲'
    }
  });

  static async fetchLegRoute(start, end, mode = 'driving', viaCoords = []) {
    if (mode === 'plane') {
      return {
        latlngs: GeoMath.generateFlightArc(start, end),
        distanceKm: GeoMath.calculateHaversineDistance(start, end).toFixed(1),
        mode
      };
    }

    if (mode === 'train') {
      const allPoints = [start, ...viaCoords, end];
      const latlngs = allPoints.map(p => [p.lat, p.lon]);
      
      let totalDistance = 0;
      for (let i = 0; i < allPoints.length - 1; i++) {
        totalDistance += GeoMath.calculateHaversineDistance(allPoints[i], allPoints[i + 1]);
      }

      return { latlngs, distanceKm: totalDistance.toFixed(1), mode };
    }

    const url = `https://router.project-osrm.org/route/v1/${mode}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Routing request for ${mode} failed.`);
    }

    const data = await response.json();
    if (!data.routes || data.routes.length === 0) {
      throw new Error(`No ${mode} route found.`);
    }

    const latlngs = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    return {
      latlngs,
      distanceKm: (data.routes[0].distance / 1000).toFixed(1),
      mode
    };
  }
}

/**
 * =================================================================
 * 4. Map Manager (Leaflet 지도 렌더링 관리)
 * =================================================================
 */
class MapManager {
  constructor(mapElementId) {
    this.map = L.map(mapElementId, { zoomControl: false }).setView(CONFIG.DEFAULT_MAP_CENTER, CONFIG.DEFAULT_ZOOM);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // 1. Esri World Satellite Imagery Base Layer
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
    }).addTo(this.map);

    // 2. Esri World Boundaries & Places Layer
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Boundaries & Labels &copy; Esri'
    }).addTo(this.map);

    this.layers = L.featureGroup().addTo(this.map);
  }

  clear() {
    this.layers.clearLayers();
  }

  fitToBounds() {
    if (this.layers.getLayers().length > 0) {
      this.map.fitBounds(this.layers.getBounds(), { padding: [80, 80] });
    }
  }

  addMarker(lat, lon, index, labelText) {
    const safeLabel = Utils.escapeHtml(labelText);
    const posClass = `pos-${(index - 1) % 4}`;

    const customHtml = `
      <div class="custom-marker ${posClass}">
        <div class="pin-badge">${index}</div>
        <div class="floating-label">${safeLabel}</div>
      </div>`;

    const icon = L.divIcon({
      html: customHtml,
      className: '',
      iconSize: [0, 0]
    });

    L.marker([lat, lon], { icon, zIndexOffset: 100 * index }).addTo(this.layers);
  }

  renderRoute(route, legIndex) {
    const config = RoutingService.MODE_CONFIGS[route.mode] || RoutingService.MODE_CONFIGS.driving;
    const popupContent = `<b>Leg ${legIndex + 1}:</b> ${route.mode.toUpperCase()}<br>Distance: ${route.distanceKm} km`;

    const isReversedMode = ['train', 'foot', 'driving'].includes(route.mode);
    const renderLatlngs = isReversedMode ? [...route.latlngs].reverse() : route.latlngs;

    const baseLine = L.polyline(renderLatlngs, config.baseStyle).addTo(this.layers);

    if (config.overlayStyle) {
      L.polyline(renderLatlngs, config.overlayStyle).addTo(this.layers);
    }

    baseLine.bindPopup(popupContent);

    if (baseLine.setText) {
      const patternText = `         ${config.icon}         `;
      baseLine.setText(patternText, {
        repeat: true,
        offset: 9,
        attributes: {
          fill: '#ffffff',
          'font-size': '28px',
          'font-weight': 'bold',
          'filter': 'drop-shadow(0px 2px 4px rgba(0,0,0,0.9))'
        }
      });
    }
  }
}

/**
 * =================================================================
 * 5. UI Manager (State-Driven Rendering)
 * =================================================================
 */
class UIManager {
  constructor() {
    this.container = document.getElementById('itinerary-list');
    this.statusBanner = document.getElementById('status-banner');
    this.calculateBtn = document.getElementById('calculate-btn');
    this.addStopBtn = document.getElementById('add-stop-btn');
  }

  showStatus(messageHtml, type = 'info') {
    this.statusBanner.innerHTML = messageHtml;
    this.statusBanner.className = `status-banner ${type}`;
  }

  setLoading(isLoading) {
    this.calculateBtn.disabled = isLoading;
    this.calculateBtn.textContent = isLoading ? 'Calculating...' : 'Calculate Full Route';
  }

  // ✨ 핵심 변경점: DOM을 읽는 것이 아니라, 전달받은 상태(State) 배열을 기반으로 화면을 싹 다시 그립니다.
  renderStops(stops) {
    this.container.innerHTML = '';
    
    stops.forEach((stop, index) => {
      // 1. 경유지 연결선 (첫 번째 목적지가 아닐 경우에만 추가)
      if (index > 0) {
        const prevStop = stops[index - 1]; // 이전 목적지에 설정된 이동 수단 가져오기
        const legHtml = `
          <div class="leg-connector">
            <select class="mode-select" data-index="${index - 1}">
              <option value="driving" ${prevStop.nextMode === 'driving' ? 'selected' : ''}>🚗 Drive to next stop</option>
              <option value="train" ${prevStop.nextMode === 'train' ? 'selected' : ''}>🚅 Train to next stop</option>
              <option value="plane" ${prevStop.nextMode === 'plane' ? 'selected' : ''}>✈️ Flight to next stop</option>
              <option value="foot" ${prevStop.nextMode === 'foot' ? 'selected' : ''}>🚶 Hike/Walk to next stop</option>
              <option value="bike" ${prevStop.nextMode === 'bike' ? 'selected' : ''}>🚲 Bike to next stop</option>
            </select>
            <input type="text" class="via-input" data-index="${index - 1}" placeholder="Hidden train stops (e.g., Taraz, Shymkent)" 
                   value="${Utils.escapeHtml(prevStop.nextVia)}" style="display: ${prevStop.nextMode === 'train' ? 'block' : 'none'};">
          </div>`;
        this.container.insertAdjacentHTML('beforeend', legHtml);
      }

      // 2. 도시 입력칸 (data-index를 부여하여 나중에 어떤 칸을 수정했는지 추적)
      const stopHtml = `
        <div class="stop-item">
          <div class="input-row">
            <input type="text" class="city-input" data-index="${index}" placeholder="Stop ${index + 1}" value="${Utils.escapeHtml(stop.name)}">
            <button type="button" class="btn-remove" data-index="${index}" style="visibility: ${index > 0 ? 'visible' : 'hidden'}" title="Remove stop">✕</button>
          </div>
        </div>`;
      this.container.insertAdjacentHTML('beforeend', stopHtml);
    });
  }
}

/**
 * =================================================================
 * 6. Main App Controller & Initialization (State-Driven)
 * =================================================================
 */
class ItineraryApp {
  constructor() {
    this.ui = new UIManager();
    this.mapManager = new MapManager('map');
    
    // ✨ 데이터(상태) 중앙 저장소
    // 앱의 모든 정보는 오직 이 배열 안에만 저장됩니다.
    this.state = {
      stops: [
        { name: 'Kaji-Say', nextMode: 'driving', nextVia: '' },
        { name: 'Eshperovo', nextMode: 'driving', nextVia: '' },
        { name: 'Bokonbayevo', nextMode: 'driving', nextVia: '' }
      ]
    };

    this.bindEvents();
    
    // 초기 상태를 바탕으로 화면 그리기 및 지도 계산 실행
    this.ui.renderStops(this.state.stops); 
    this.calculateItinerary(); 
  }

  bindEvents() {
    // 1. [항목 추가]: 배열에 데이터를 하나 밀어넣고, 화면 다시 그리기
    this.ui.addStopBtn.addEventListener('click', () => {
      this.state.stops.push({ name: '', nextMode: 'driving', nextVia: '' });
      this.ui.renderStops(this.state.stops);
    });

    this.ui.calculateBtn.addEventListener('click', () => this.calculateItinerary());

    // 2. [텍스트 입력]: 사용자가 글자를 칠 때마다 실시간으로 state 배열 업데이트
    this.ui.container.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index, 10);
      if (isNaN(index)) return;

      if (e.target.classList.contains('city-input')) {
        this.state.stops[index].name = e.target.value;
      } else if (e.target.classList.contains('via-input')) {
        this.state.stops[index].nextVia = e.target.value;
      }
    });

    // 3. [옵션 변경]: 셀렉트 박스가 바뀌면 state 업데이트 후 화면 다시 그리기 (숨겨진 인풋 노출용)
    this.ui.container.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index, 10);
      if (isNaN(index)) return;

      if (e.target.classList.contains('mode-select')) {
        this.state.stops[index].nextMode = e.target.value;
        this.ui.renderStops(this.state.stops); 
      }
    });

    // 4. [항목 삭제]: 배열에서 해당 인덱스를 삭제하고 화면 다시 그리기
    this.ui.container.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.btn-remove');
      if (removeBtn) {
        const index = parseInt(removeBtn.dataset.index, 10);
        if (!isNaN(index)) {
          this.state.stops.splice(index, 1);
          this.ui.renderStops(this.state.stops);
        }
      }
    });
  }

  async throttledSleep(cityName) {
    if (!GeocodingService.isCached(cityName)) {
      await Utils.sleep(CONFIG.API_DELAY_MS);
    }
  }

  async calculateItinerary() {
    // ✨ DOM을 파싱할 필요 없이 state에서 바로 빈칸이 아닌 목적지만 필터링
    const validStops = this.state.stops.filter(s => s.name.trim() !== '');

    if (validStops.length < 2) {
      return this.ui.showStatus('Please enter at least two valid destinations.', 'error');
    }

    // 상태 배열을 기반으로 경로(Leg) 배열 조립
    const legs = [];
    for (let i = 0; i < validStops.length - 1; i++) {
      legs.push({
        mode: validStops[i].nextMode,
        via: validStops[i].nextVia
      });
    }

    this.ui.setLoading(true);
    this.mapManager.clear();
    let totalDistanceKm = 0;
    const waypoints = [];
    let hasErrors = false;

    try {
      // 1. 목적지 마커 그리기
      for (let i = 0; i < validStops.length; i++) {
        const cityName = validStops[i].name;
        this.ui.showStatus(`Locating stop ${i + 1}: "<b>${Utils.escapeHtml(cityName)}</b>"...`, 'info');
        
        try {
          const coords = await GeocodingService.getCoordinates(cityName);
          waypoints.push({ ...coords, label: cityName });
          this.mapManager.addMarker(coords.lat, coords.lon, i + 1, cityName);
        } catch (geoError) {
          console.warn(`[검색 실패] ${cityName}:`, geoError);
          waypoints.push(null);
          hasErrors = true;
        }

        await this.throttledSleep(cityName);
      }

      // 2. 경로 선 그리기
      for (let i = 0; i < legs.length; i++) {
        const start = waypoints[i];
        const end = waypoints[i + 1];
        if (!start || !end) continue; 

        const leg = legs[i];
        const viaCoords = [];

        if (leg.mode === 'train' && leg.via.trim()) {
          const viaCities = leg.via.split(',').map(s => s.trim()).filter(Boolean);
          for (const city of viaCities) {
            this.ui.showStatus(`Locating train station: "<b>${Utils.escapeHtml(city)}</b>"...`, 'info');
            try {
              const coords = await GeocodingService.getCoordinates(city);
              viaCoords.push(coords);
              await this.throttledSleep(city);
            } catch (warn) {
              console.warn(`Skipping invalid via station: ${city}`);
            }
          }
        }

        this.ui.showStatus(`Calculating ${leg.mode} route for Leg ${i + 1}...`, 'info');
        
        try {
          const route = await RoutingService.fetchLegRoute(start, end, leg.mode, viaCoords);
          totalDistanceKm += parseFloat(route.distanceKm);
          this.mapManager.renderRoute(route, i);
        } catch (routeError) {
          console.warn(`[경로 탐색 실패] Leg ${i + 1}:`, routeError);
          hasErrors = true;
        }
      }

      this.mapManager.fitToBounds();

      if (hasErrors) {
        this.ui.showStatus(`<b>일부 경로를 찾을 수 없습니다.</b><br>오타가 없는지 확인해 보세요. (계산된 거리: ~${totalDistanceKm.toFixed(1)} km)`, 'error');
      } else {
        this.ui.showStatus(`<b>Itinerary generated!</b><br>Total Distance: ~${totalDistanceKm.toFixed(1)} km`, 'success');
      }

    } catch (err) {
      this.ui.showStatus(Utils.escapeHtml(err.message), 'error');
    } finally {
      this.ui.setLoading(false);
    }
  }
}

// App Initialization (초기 데이터 주입은 내부 state로 옮겼으므로 단순히 앱 객체만 생성하면 됨)
document.addEventListener('DOMContentLoaded', () => {
  new ItineraryApp();
});