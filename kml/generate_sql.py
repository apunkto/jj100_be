import xml.etree.ElementTree as ET
from math import radians, cos, sin, sqrt, atan2

# Haversine distance function (in meters)
def haversine(lat1, lon1, lat2, lon2):
    R = 6371000  # Earth radius in meters
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lon2 - lon1)
    a = sin(dphi/2)**2 + cos(phi1)*cos(phi2)*sin(dlambda/2)**2
    return 2 * R * atan2(sqrt(a), sqrt(1 - a))

# Parse the KML
tree = ET.parse('data.kml')
root = tree.getroot()
ns = {'kml': 'http://www.opengis.net/kml/2.2'}

# Collect points
points = {}
tii_count = 0
korv_count = 0

for placemark in root.findall('.//kml:Placemark', ns):
    name = placemark.find('kml:name', ns)
    desc = placemark.find('kml:description', ns)
    coords = placemark.find('.//kml:coordinates', ns)

    if name is not None and desc is not None and coords is not None:
        name_text = name.text.strip()
        desc_text = desc.text.strip()
        coord_text = coords.text.strip()
        lon, lat, *_ = map(float, coord_text.split(','))
        latlon_str = f"{lat}, {lon}"

        if name_text not in points:
            points[name_text] = {}

        points[name_text][desc_text] = (lat, lon, latlon_str)

        if desc_text == 'tii':
            tii_count += 1
        elif desc_text == 'korv':
            korv_count += 1

# Generate SQL and log missing data
print("SQL Updates:")
missing = []
for i in range(1, 101):
    name = str(i)
    if name in points:
        descs = points[name]
        if 'tii' in descs:
            lat1, lon1, latlon_str = descs['tii']
            if 'korv' in descs:
                lat2, lon2, _ = descs['korv']
                length = round(haversine(lat1, lon1, lat2, lon2))
                print(f"UPDATE hole SET coordinates = '{latlon_str}', length = {length} WHERE number = '{name}';")
            else:
                print(f"UPDATE hole SET coordinates = '{latlon_str}' WHERE number = '{name}';")
                print(f"-- Missing 'korv' for hole {name}")
                missing.append(name)
        else:
            print(f"-- Missing 'tii' for hole {name}")
            missing.append(name)
    else:
        print(f"-- No Placemark found for hole {name}")
        missing.append(name)

# Summary log
print("\nSummary:")
print(f"Total 'tii' points found: {tii_count}")
print(f"Total 'korv' points found: {korv_count}")
print(f"Total holes missing 'tii' or 'korv': {len(missing)}")
