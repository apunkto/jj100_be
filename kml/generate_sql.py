import json
import xml.etree.ElementTree as ET
from pathlib import Path
from math import radians, cos, sin, sqrt, atan2

SCRIPT_DIR = Path(__file__).resolve().parent

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lon2 - lon1)
    a = sin(dphi/2)**2 + cos(phi1)*cos(phi2)*sin(dlambda/2)**2
    return 2 * R * atan2(sqrt(a), sqrt(1 - a))

METRIX_IDS = (4, 30)
ns = {'kml': 'http://www.opengis.net/kml/2.2'}

# --- Parse data.kml for tii coordinates ---
tree = ET.parse(SCRIPT_DIR / 'data.kml')
root = tree.getroot()

tii_coords = {}
korv_coords = {}
for placemark in root.findall('.//kml:Placemark', ns):
    name = placemark.find('kml:name', ns)
    desc = placemark.find('kml:description', ns)
    coords = placemark.find('.//kml:coordinates', ns)
    if name is None or desc is None or coords is None:
        continue
    desc_text = desc.text.strip()
    name_text = name.text.strip()
    lon, lat, *_ = map(float, coords.text.strip().split(','))
    if desc_text == 'tii':
        tii_coords[name_text] = f"{lat}, {lon}"
    elif desc_text == 'korv':
        korv_coords[name_text] = f"{lat}, {lon}"

# --- Parse Navigatsioon.kml for navigation paths ---
# Placemarks named "X->Y" describe the path from tee X to basket Y.
# We store the path under the destination hole number Y.
tree_nav = ET.parse(SCRIPT_DIR / 'Navigatsioon.kml')
root_nav = tree_nav.getroot()

nav_paths = {}  # hole number (str) -> list of [lat, lon]
for placemark in root_nav.findall('.//kml:Placemark', ns):
    name = placemark.find('kml:name', ns)
    coords_el = placemark.find('.//kml:coordinates', ns)
    if name is None or coords_el is None:
        continue
    name_text = name.text.strip()
    if '->' not in name_text:
        continue
    _, dest = name_text.split('->', 1)
    dest = dest.strip()
    raw = coords_el.text.strip().split()
    path = []
    for entry in raw:
        lon, lat, *_ = map(float, entry.split(','))
        path.append([lat, lon])
    nav_paths[dest] = path

# --- Parse Fairway.kml for line lengths ---
tree_fw = ET.parse(SCRIPT_DIR / 'Fairway.kml')
root_fw = tree_fw.getroot()

fairway_lengths = {}
for placemark in root_fw.findall('.//kml:Placemark', ns):
    name = placemark.find('kml:name', ns)
    coords = placemark.find('.//kml:coordinates', ns)
    if name is None or coords is None:
        continue
    name_text = name.text.strip()
    raw = coords.text.strip().split()
    points = []
    for entry in raw:
        lon, lat, *_ = map(float, entry.split(','))
        points.append((lat, lon))
    total = sum(
        haversine(points[i][0], points[i][1], points[i+1][0], points[i+1][1])
        for i in range(len(points) - 1)
    )
    fairway_lengths[name_text] = round(total)

# --- Generate SQL (write next to this script; avoids empty file if cwd is wrong) ---
out_path = SCRIPT_DIR / 'updates.sql'
missing_coords = []
missing_length = []
missing_target = []
missing_nav = []
lines = ["SQL Updates:"]
for i in range(1, 101):
    name = str(i)
    has_coords = name in tii_coords
    has_length = name in fairway_lengths
    has_target = name in korv_coords
    has_nav = name in nav_paths

    set_parts = []
    if has_coords:
        set_parts.append(f"coordinates = '{tii_coords[name]}'")
    if has_target:
        set_parts.append(f"target_coordinates = '{korv_coords[name]}'")
    if has_length:
        set_parts.append(f"length = {fairway_lengths[name]}")
    if has_nav:
        nav_json = json.dumps(nav_paths[name], separators=(',', ':'))
        set_parts.append(f"nav_from_previous = '{nav_json}'")

    if set_parts:
        lines.append(
            f"UPDATE hole SET {', '.join(set_parts)} WHERE number = '{name}' AND metrix_competition_id IN {METRIX_IDS};"
        )
    else:
        lines.append(f"-- No data found for hole {name}")

    if not has_coords:
        lines.append(f"-- Missing tii coordinates for hole {name}")
        missing_coords.append(name)
    if not has_length:
        lines.append(f"-- Missing fairway length for hole {name}")
        missing_length.append(name)
    if not has_target:
        lines.append(f"-- Missing korv (target) coordinates for hole {name}")
        missing_target.append(name)
    if not has_nav:
        lines.append(f"-- Missing nav_from_previous for hole {name}")
        missing_nav.append(name)

lines.append("")
lines.append("Summary:")
lines.append(f"Tii coordinates found: {len(tii_coords)}")
lines.append(f"Korv (target) coordinates found: {len(korv_coords)}")
lines.append(f"Fairway lengths found: {len(fairway_lengths)}")
lines.append(f"Nav paths found: {len(nav_paths)}")
lines.append(f"Holes missing coordinates: {missing_coords or 'none'}")
lines.append(f"Holes missing target_coordinates: {missing_target or 'none'}")
lines.append(f"Holes missing length: {missing_length or 'none'}")
lines.append(f"Holes missing nav_from_previous: {missing_nav or 'none'}")

text = "\n".join(lines) + "\n"
out_path.write_text(text, encoding="utf-8")
print(f"Wrote {out_path} ({len(text)} bytes)")
