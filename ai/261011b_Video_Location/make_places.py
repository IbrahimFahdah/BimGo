"""Builds BimGo's offline place list (Resources/places.tsv) from Natural Earth's 1:10m populated places.

Input:  ne_10m_populated_places.geojson (github.com/nvkelso/natural-earth-vector, public domain)
Output: places.tsv: name, region, country, latitude, longitude, IANA time zone, population (tab separated).

Time zones missing in the source take the zone of the nearest place in the same country that has one
(same region preferred); places in countries with no zone at all are left blank (BimGo estimates from longitude).
Names with characters BimGo's HUD font can't draw use Natural Earth's ASCII name.
"""
import json, math, sys

src, dst, commit = sys.argv[1], sys.argv[2], sys.argv[3]
EXTRA = set('Δ−—–…•↑↓←→“”’≈')
def drawable(s): return all(ord(c) < 256 or c in EXTRA for c in s)
def clean(s): return ' '.join((s or '').replace('\t', ' ').split())

feats = json.load(open(src, encoding='utf-8'))['features']
rows = []
for f in feats:
    p = f['properties']
    name = clean(p.get('NAME'))
    if not drawable(name): name = clean(p.get('NAMEASCII')) or name
    region = clean(p.get('ADM1NAME'))
    if not drawable(region): region = ''
    country = clean(p.get('ADM0NAME'))
    if not drawable(country): country = clean(p.get('SOV0NAME'))
    lat, lon = float(p['LATITUDE']), float(p['LONGITUDE'])
    rows.append(dict(name=name, region=region, country=country, lat=lat, lon=lon,
                     zone=clean(p.get('TIMEZONE')), pop=int(p.get('POP_MAX') or 0)))

def dist(a, b):
    la1, la2 = math.radians(a['lat']), math.radians(b['lat'])
    dl = math.radians(b['lon'] - a['lon'])
    return math.acos(max(-1, min(1, math.sin(la1)*math.sin(la2) + math.cos(la1)*math.cos(la2)*math.cos(dl))))

filled = 0
for r in rows:
    if r['zone']: continue
    same = [o for o in rows if o['zone'] and o['country'] == r['country']]
    region = [o for o in same if o['region'] == r['region']]
    pool = region or same
    if pool:
        r['zone'] = min(pool, key=lambda o: dist(r, o))['zone']
        filled += 1

rows.sort(key=lambda r: (-r['pop'], r['name']))
blank = sum(1 for r in rows if not r['zone'])
with open(dst, 'w', encoding='utf-8', newline='\n') as out:
    out.write('# BimGo place list: name, region, country, latitude, longitude, IANA time zone, population (tab separated)\n')
    out.write(f'# Built from Natural Earth 1:10m populated places (public domain, naturalearthdata.com),\n')
    out.write(f'# github.com/nvkelso/natural-earth-vector commit {commit}, by ai/261011b_Video_Location/make_places.py.\n')
    out.write('# Missing time zones were filled from the nearest place in the same country. Made with Natural Earth.\n')
    for r in rows:
        out.write(f"{r['name']}\t{r['region']}\t{r['country']}\t{r['lat']:.4f}\t{r['lon']:.4f}\t{r['zone']}\t{r['pop']}\n")
print(len(rows), 'places;', filled, 'zones filled;', blank, 'still blank')
