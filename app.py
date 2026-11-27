import json
import random
from functools import lru_cache
from flask import Flask, jsonify, render_template, request
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.ops import transform, unary_union

app = Flask(__name__)

# =========================================================
# 1. 가상 철도 노선 데이터
# =========================================================

RAIL_ROUTES = {
    "경부선(가상)": [
        [37.5665, 126.9780],
        [36.3504, 127.3845],
        [35.8714, 128.6014],
        [35.1796, 129.0756],
    ],
    "강릉선(가상)": [
        [37.5665, 126.9780],
        [37.7519, 128.8761],
    ],
    "호남선(가상)": [
        [37.5665, 126.9780],
        [36.3504, 127.3845],
        [35.1595, 126.8526],
    ],
    "전라선(가상)": [
        [35.1595, 126.8526],
        [35.8242, 127.1480],
        [34.9506, 127.4872],
    ],
}

ROUTE_COLORS = {
    "경부선(가상)": "#1f2937",
    "강릉선(가상)": "#0f766e",
    "호남선(가상)": "#4338ca",
    "전라선(가상)": "#b45309",
}

# =========================================================
# 2. 좌표계 변환기 (EPSG:4326 <-> EPSG:5179)
# =========================================================

TRANSFORM_TO_5179 = Transformer.from_crs(
    "EPSG:4326",
    "EPSG:5179",
    always_xy=True,
).transform

TRANSFORM_TO_4326 = Transformer.from_crs(
    "EPSG:5179",
    "EPSG:4326",
    always_xy=True,
).transform


def convert_to_geojson(geometry):
    """EPSG:5179 Shapely geometry를 WGS84 GeoJSON Feature로 변환합니다."""
    if geometry is None or geometry.is_empty:
        return None

    geometry_wgs84 = transform(TRANSFORM_TO_4326, geometry)
    return {
        "type": "Feature",
        "properties": {},
        "geometry": json.loads(json.dumps(geometry_wgs84.__geo_interface__)),
    }


@lru_cache(maxsize=16)
def compute_geodata(buffer_km: float = 5.0):
    """철도 노선, 버퍼(중첩/비중첩) GeoJSON 및 공간 통계를 계산합니다."""
    buffer_meters = buffer_km * 1000.0
    buffers = []
    routes_payload = []

    for route_name, coords in RAIL_ROUTES.items():
        line = LineString([(lon, lat) for lat, lon in coords])
        line_projected = transform(TRANSFORM_TO_5179, line)
        buffer_geom = line_projected.buffer(buffer_meters, resolution=8)
        buffers.append(buffer_geom)

        routes_payload.append(
            {
                "name": route_name,
                "coords": coords,
                "color": ROUTE_COLORS.get(route_name, "#222222"),
                "length_km": round(line_projected.length / 1000.0, 1),
            }
        )

    all_buffer = unary_union(buffers)

    overlap_parts = []
    for i in range(len(buffers)):
        for j in range(i + 1, len(buffers)):
            intersection = buffers[i].intersection(buffers[j])
            if not intersection.is_empty:
                overlap_parts.append(intersection)

    overlap_area = unary_union(overlap_parts) if overlap_parts else None
    if overlap_area is not None and not overlap_area.is_empty:
        non_overlap_area = all_buffer.difference(overlap_area)
    else:
        non_overlap_area = all_buffer

    total_area_km2 = round(all_buffer.area / 1_000_000.0, 2)
    overlap_area_km2 = (
        round(overlap_area.area / 1_000_000.0, 2)
        if overlap_area is not None and not overlap_area.is_empty
        else 0.0
    )
    non_overlap_area_km2 = (
        round(non_overlap_area.area / 1_000_000.0, 2)
        if non_overlap_area is not None and not non_overlap_area.is_empty
        else 0.0
    )
    overlap_ratio = (
        round((overlap_area_km2 / total_area_km2) * 100.0, 1)
        if total_area_km2 > 0
        else 0.0
    )

    return {
        "buffer_km": buffer_km,
        "routes": routes_payload,
        "non_overlap_geojson": convert_to_geojson(non_overlap_area),
        "overlap_geojson": convert_to_geojson(overlap_area),
        "stats": {
            "route_count": len(routes_payload),
            "total_length_km": round(sum(r["length_km"] for r in routes_payload), 1),
            "total_area_km2": total_area_km2,
            "non_overlap_area_km2": non_overlap_area_km2,
            "overlap_area_km2": overlap_area_km2,
            "overlap_ratio_pct": overlap_ratio,
        },
    }


def generate_trains(count: int = 8):
    """노선별 연속 운행 열차 초기 데이터를 생성합니다."""
    count = max(1, min(count, 40))
    route_names = list(RAIL_ROUTES.keys())
    trains = []

    for i in range(count):
        # 처음 4대는 모든 노선에 최소 1대씩 고르게 배치
        route_name = (
            route_names[i] if i < len(route_names) else random.choice(route_names)
        )
        direction = 1 if i % 2 == 0 else -1
        # 같은 노선 내에서도 간격을 두고 시작하도록 분산
        base_progress = ((i * 0.23) + random.uniform(0.05, 0.18)) % 0.9 + 0.05

        trains.append(
            {
                "id": f"train-{101 + i}",
                "name": f"KTX-{101 + i}",
                "route": route_name,
                "coords": RAIL_ROUTES[route_name],
                "progress": round(base_progress, 4),
                "speed": random.randint(140, 260),
                "direction": direction,
            }
        )

    return trains


@app.route("/")
def index():
    """반응형 철도 시뮬레이션 웹앱 메인 페이지."""
    return render_template("index.html")


@app.route("/api/geodata")
def api_geodata():
    """철도 노선 및 버퍼 GeoJSON 데이터를 반환합니다."""
    raw_buffer = request.args.get("buffer_km", "5")
    try:
        buffer_km = float(raw_buffer)
    except ValueError:
        buffer_km = 5.0
    buffer_km = max(1.0, min(buffer_km, 25.0))
    return jsonify(compute_geodata(buffer_km))


@app.route("/api/trains")
def api_trains():
    """시뮬레이션용 열차 목록을 반환합니다."""
    raw_count = request.args.get("count", "8")
    try:
        count = int(raw_count)
    except ValueError:
        count = 8
    return jsonify({"trains": generate_trains(count)})


@app.route("/health")
def health():
    """헬스 체크 엔드포인트."""
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
