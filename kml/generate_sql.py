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
for placemark in root.findall('.//kml:Placemark', ns):
    name = placemark.find('kml:name', ns)
    desc = placemark.find('kml:description', ns)
    coords = placemark.find('.//kml:coordinates', ns)
    if name is None or desc is None or coords is None:
        continue
    if desc.text.strip() != 'tii':
        continue
    name_text = name.text.strip()
    lon, lat, *_ = map(float, coords.text.strip().split(','))
    tii_coords[name_text] = f"{lat}, {lon}"

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
lines = ["SQL Updates:"]
for i in range(1, 101):
    name = str(i)
    has_coords = name in tii_coords
    has_length = name in fairway_lengths

    if has_coords and has_length:
        lines.append(
            f"UPDATE hole SET coordinates = '{tii_coords[name]}', length = {fairway_lengths[name]} WHERE number = '{name}' AND metrix_competition_id IN {METRIX_IDS};"
        )
    elif has_coords:
        lines.append(
            f"UPDATE hole SET coordinates = '{tii_coords[name]}' WHERE number = '{name}' AND metrix_competition_id IN {METRIX_IDS};"
        )
        lines.append(f"-- Missing fairway length for hole {name}")
        missing_length.append(name)
    elif has_length:
        lines.append(
            f"UPDATE hole SET length = {fairway_lengths[name]} WHERE number = '{name}' AND metrix_competition_id IN {METRIX_IDS};"
        )
        lines.append(f"-- Missing tii coordinates for hole {name}")
        missing_coords.append(name)
    else:
        lines.append(f"-- No data found for hole {name}")
        missing_coords.append(name)
        missing_length.append(name)

lines.append("")
lines.append("Summary:")
lines.append(f"Tii coordinates found: {len(tii_coords)}")
lines.append(f"Fairway lengths found: {len(fairway_lengths)}")
lines.append(f"Holes missing coordinates: {missing_coords or 'none'}")
lines.append(f"Holes missing length: {missing_length or 'none'}")

text = "\n".join(lines) + "\n"
out_path.write_text(text, encoding="utf-8")
print(f"Wrote {out_path} ({len(text)} bytes)")
