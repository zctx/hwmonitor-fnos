#!/usr/bin/env python3
"""Local hwmonitor app patches for Minisforum N5A/F8NAB.

1.5.6 scope:
- keep the upstream 0.2.0 kernel driver untouched;
- bind NVMe block devices to their matching hwmon node through sysfs device paths;
- avoid duplicate chip temperature source IDs when several hwmon chips share name/index;
- classify SPD5118 as memory, not PCIe;
- classify the EC-published "CPU Temp" as CPU while keeping other EC temps as board;
- expose cached/stale HDD temperatures explicitly;
- keep the storage fan safety floor in software-curve mode;
- show the server-selected automatic source in the UI.
"""
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: patch-app.py <server.js> <app.js>")

server = Path(sys.argv[1])
app = Path(sys.argv[2])


def replace_once(text: str, old: str, new: str, desc: str) -> str:
    if old not in text:
        raise SystemExit(f"{desc} anchor not found")
    return text.replace(old, new, 1)


s = server.read_text(encoding="utf-8")

# Add a memory sensor group so SPD5118 DIMM temperature does not get mislabeled as PCIe.
s = replace_once(
    s,
    "const SENSOR_GROUPS = ['cpu', 'board', 'hdd', 'ssd', 'pcie', 'other'];",
    "const SENSOR_GROUPS = ['cpu', 'board', 'hdd', 'ssd', 'memory', 'pcie', 'other'];",
    "server.js SENSOR_GROUPS",
)

# Source-id validator: allow legacy chip:<name>:<tempN> and duplicate-safe
# chip:<name>:hwmonX:<tempN> ids.
s = replace_once(
    s,
    """function normRole(r) {
  if (r === 'sys') return 'board';
  if (r === 'disk') return 'hdd';
  return Object.prototype.hasOwnProperty.call(ROLE_GROUPS, r) ? r : 'other';
}
""",
    """function normRole(r) {
  if (r === 'sys') return 'board';
  if (r === 'disk') return 'hdd';
  return Object.prototype.hasOwnProperty.call(ROLE_GROUPS, r) ? r : 'other';
}
function validTempSourceId(s) {
  return typeof s === 'string' && /^(chip:[\\w.-]+:(?:hwmon\\d+:)?\\d+|disk:[\\w.-]+)$/.test(s);
}
""",
    "server.js validTempSourceId",
)

# Fix classification: SPD5118 is memory, EC CPU Temp is CPU, the remaining EC
# sensors are board/ambient. Explicit PCIe drivers are kept as PCIe.
s = replace_once(
    s,
    """function chipGroup(chip) {
  if (chip.type === 'cpu') return 'cpu';
  if (chip.type === 'superio' || chip.type === 'acpi') return 'board';
  if (chip.type === 'nvme') return 'ssd';           // NVMe is an SSD, not its own class
  if (isPciHwmon(chip.dir)) return 'pcie';
  return 'other';
}
""",
    """function chipGroup(chip, temp) {
  const label = String((temp && temp.label) || '').toLowerCase();
  if (chip.type === 'cpu') return 'cpu';
  if (chip.name === 'spd5118') return 'memory';
  if (chip.name === 'minisforum_n5_it5571') return /cpu/.test(label) ? 'cpu' : 'board';
  if (chip.type === 'superio' || chip.type === 'acpi') return 'board';
  if (chip.type === 'nvme') return 'ssd';           // NVMe is an SSD, not its own class
  if (/^(amdgpu|r8169_)/i.test(chip.name)) return 'pcie';
  if (isPciHwmon(chip.dir)) return 'pcie';
  return 'other';
}
""",
    "server.js chipGroup",
)

# Replace temperature-source builder with duplicate-safe chip source ids and
# cached/stale disk metadata.
s = replace_once(
    s,
    """function tempSources(chips, disks) {
  const out = [];
  for (const c of chips) {
    if (c.type === 'nvme') continue;          // drives are listed once, below
    for (const t of c.temps) {
      out.push({
        id: `chip:${c.name}:${t.index}`,
        label: t.label,
        chip: c.name,
        group: chipGroup(c),
        temp: t.input
      });
    }
  }
  for (const d of disks || []) {
    out.push({
      id: `disk:${d.dev}`,
      label: `${d.dev} · ${d.model}`,
      chip: d.dev,
      group: diskGroup(d.type),
      temp: d.temp
    });
  }
  return out;
}
""",
    """function tempSources(chips, disks) {
  const out = [];
  const chipTempCounts = {};
  for (const c of chips) {
    if (c.type === 'nvme') continue;          // drives are listed once, below
    for (const t of c.temps) {
      const legacyId = `chip:${c.name}:${t.index}`;
      chipTempCounts[legacyId] = (chipTempCounts[legacyId] || 0) + 1;
    }
  }
  for (const c of chips) {
    if (c.type === 'nvme') continue;          // drives are listed once, below
    const hwmon = path.basename(c.dir);
    for (const t of c.temps) {
      const legacyId = `chip:${c.name}:${t.index}`;
      const duplicated = chipTempCounts[legacyId] > 1;
      const id = duplicated ? `chip:${c.name}:${hwmon}:${t.index}` : legacyId;
      out.push({
        id,
        legacy_id: legacyId,
        label: duplicated ? `${t.label} · ${hwmon}` : t.label,
        chip: c.name,
        hwmon,
        group: chipGroup(c, t),
        temp: t.input,
        cached: false,
        stale: false,
        stale_ms: 0
      });
    }
  }
  for (const d of disks || []) {
    const cached = !!d.temp_cached;
    out.push({
      id: `disk:${d.dev}`,
      label: `${d.dev} · ${d.model}${cached ? ' · 缓存' : ''}`,
      chip: d.dev,
      group: diskGroup(d.type),
      temp: d.temp,
      hwmon: d.hwmon || null,
      cached,
      stale: cached,
      stale_ms: d.temp_stale_ms || 0
    });
  }
  return out;
}
""",
    "server.js tempSources",
)

# Match explicit fan source against both current duplicate-safe id and legacy_id.
s = replace_once(
    s,
    """  if (fan.source) {
    const s = sources.find(x => x.id === fan.source);
    if (s) return s.temp;                     // null when a drive is asleep
    return null;                              // bound source vanished: hold duty
  }
""",
    """  if (fan.source) {
    const s = sources.find(x => x.id === fan.source || x.legacy_id === fan.source);
    if (s) return s.temp;                     // null when a drive is asleep
    return null;                              // bound source vanished: hold duty
  }
""",
    "server.js fanTemp source lookup",
)

# Extend autoSource payload so the UI can show cached/stale status if present.
s = replace_once(
    s,
    """    f.autoSource = a ? { id: a.id, label: a.label, temp: a.temp } : null;
""",
    """    f.autoSource = a ? {
      id: a.id,
      legacy_id: a.legacy_id || null,
      label: a.label,
      temp: a.temp,
      group: a.group,
      cached: !!a.cached,
      stale: !!a.stale,
      stale_ms: a.stale_ms || 0
    } : null;
""",
    "server.js autoSource payload",
)

# Add a per-drive last-known cache used only when smartctl cannot return a fresh
# HDD/SATA value, so the UI can tell cached from current values.
s = replace_once(
    s,
    "let smartCache = { ts: 0, data: [] };\n",
    "let smartCache = { ts: 0, data: [] };\nlet diskLastTemps = {}; // dev -> {temp, ts}\n",
    "server.js diskLastTemps",
)

old_nvme = """    // NVMe: model/size from sysfs, temp from nvme hwmon composite
    for (const b of fs.readdirSync('/sys/block')) {
      if (!/^nvme\\d+n\\d+$/.test(b)) continue;
      const size = (readInt(`/sys/block/${b}/size`) || 0) * 512;
      const model = (readFile(`/sys/block/${b}/device/model`) || 'NVMe').trim();
      let temp = null;
      for (const h of listHwmon()) {
        if (readFile(path.join(h, 'name')) !== 'nvme') continue;
        const t = readInt(path.join(h, 'temp1_input'));
        if (t !== null) { temp = t / 1000; break; }
      }
      out.push({ dev: b, type: 'nvme', model, size, temp });
    }
"""

new_nvme = """    // NVMe: model/size from sysfs, temp from the matching nvme hwmon node.
    // Upstream v1.5.1 used the first name=nvme hwmon node for every NVMe block
    // device. On N5A/F8NAB with four NVMe drives that can bind nvme1/nvme2/nvme3
    // to nvme0 temperature and mis-drive the storage fan curve. Match by real
    // sysfs device path instead: /sys/block/nvmeXnY/device <-> hwmon/device.
    const nvmeHwmons = listHwmon()
      .filter(h => readFile(path.join(h, 'name')) === 'nvme')
      .map(h => {
        let device = null;
        try { device = fs.realpathSync(path.join(h, 'device')); } catch (e) { device = null; }
        const temps = [];
        for (const e of listDir(h)) {
          if (!/^temp\\d+_input$/.test(e)) continue;
          const v = readInt(path.join(h, e));
          if (v !== null) temps.push(v / 1000);
        }
        return { dir: h, device, temps };
      })
      .filter(x => x.device && x.temps.length);

    for (const b of fs.readdirSync('/sys/block')) {
      if (!/^nvme\\d+n\\d+$/.test(b)) continue;
      const size = (readInt(`/sys/block/${b}/size`) || 0) * 512;
      const model = (readFile(`/sys/block/${b}/device/model`) || 'NVMe').trim();
      let devPath = null;
      try { devPath = fs.realpathSync(`/sys/block/${b}/device`); } catch (e) { devPath = null; }
      const match = devPath ? nvmeHwmons.find(x =>
        x.device === devPath || x.device.startsWith(devPath + '/') || devPath.startsWith(x.device + '/')
      ) : null;
      // Take the hottest sensor published by that controller. Some drives report
      // a low Composite value while Sensor 2 is significantly hotter.
      const temp = match ? Math.max(...match.temps) : null;
      out.push({
        dev: b, type: 'nvme', model, size, temp,
        hwmon: match ? path.basename(match.dir) : null,
        temp_cached: false, temp_stale_ms: 0
      });
    }
"""
s = replace_once(s, old_nvme, new_nvme, "server.js NVMe block")

# Explicitly mark HDD/SATA temperatures as cached when smartctl cannot return a
# fresh value but we have a previous value. This avoids presenting stale data as
# real-time while still allowing conservative cooling.
s = replace_once(
    s,
    """    // SATA/SAS: rotational flag decides ssd/hdd, temp via smartctl
    for (const b of fs.readdirSync('/sys/block')) {
      if (!/^sd[a-z]+$/.test(b)) continue;
      const rot = readInt(`/sys/block/${b}/queue/rotational`);
      const size = (readInt(`/sys/block/${b}/size`) || 0) * 512;
      const model = (readFile(`/sys/block/${b}/device/model`) || 'Unknown').trim();
      let temp = null;
      try {
        const raw = execFileSync('smartctl', ['-A', '-n', 'standby', `/dev/${b}`],
          { timeout: 6000, encoding: 'utf8' });
        temp = parseSmartTemp(raw);
      } catch (e) { /* standby / unsupported: skip */ }
      out.push({ dev: b, type: rot === 1 ? 'hdd' : 'ssd', model, size, temp });
    }
""",
    """    // SATA/SAS: rotational flag decides ssd/hdd, temp via smartctl.
    // If the disk is asleep or smartctl cannot return a fresh value, expose the
    // last known value as cached/stale instead of pretending it is current.
    for (const b of fs.readdirSync('/sys/block')) {
      if (!/^sd[a-z]+$/.test(b)) continue;
      const rot = readInt(`/sys/block/${b}/queue/rotational`);
      const size = (readInt(`/sys/block/${b}/size`) || 0) * 512;
      const model = (readFile(`/sys/block/${b}/device/model`) || 'Unknown').trim();
      let temp = null, tempCached = false, tempStaleMs = 0;
      try {
        const raw = execFileSync('smartctl', ['-A', '-n', 'standby', `/dev/${b}`],
          { timeout: 6000, encoding: 'utf8' });
        const parsed = parseSmartTemp(raw);
        if (parsed !== null) {
          temp = parsed;
          diskLastTemps[b] = { temp, ts: now };
        }
      } catch (e) { /* standby / unsupported: use cached value below */ }
      if (temp === null && diskLastTemps[b]) {
        temp = diskLastTemps[b].temp;
        tempCached = true;
        tempStaleMs = Math.max(0, now - diskLastTemps[b].ts);
      }
      out.push({
        dev: b, type: rot === 1 ? 'hdd' : 'ssd', model, size, temp,
        temp_cached: tempCached, temp_stale_ms: tempStaleMs
      });
    }
""",
    "server.js SATA/SAS block",
)

# Storage fan safety floor.
s = replace_once(
    s,
    """    const target = curvePwm(cur.points, src);
""",
    """    let target = curvePwm(cur.points, src);
    // storage fan safety floor: a bad/low SSD/HDD temperature source must not
    // stop the storage cooling path. 77/255 ~= 30%.
    if (['ssd', 'hdd'].includes(normRole(fan.role))) target = Math.max(target, 77);
""",
    "server.js curve target",
)

# Accept duplicate-safe chip ids from config/detection.
s = replace_once(
    s,
    """            merged.source = (typeof val.source === 'string' && /^(chip:[\\w.-]+:\\d+|disk:[\\w.-]+)$/.test(val.source))
              ? val.source : null;
""",
    """            merged.source = validTempSourceId(val.source) ? val.source : null;
""",
    "server.js config source regex",
)

s = replace_once(
    s,
    """    const src = typeof item.source === 'string' && /^(chip:[\\w.-]+:\\d+|disk:[\\w.-]+)$/.test(item.source)
      ? item.source : null;
""",
    """    const src = validTempSourceId(item.source) ? item.source : null;
""",
    "server.js detection source regex",
)

server.write_text(s, encoding="utf-8")

u = app.read_text(encoding="utf-8")
# UI: show server-selected autoSource, including labels like "缓存" for stale HDD.
u = replace_once(
    u,
    """        const bound = (d.temp_sources || []).find(s => s.id === f.source);
        const srcT = bound ? bound.temp : (f.role === 'cpu' ? cpuPkgT : boardT);
        const srcN = bound ? bound.label : (f.role === 'cpu' ? t('temp.cpu') : t('temp.board'));
""",
    """        const bound = (d.temp_sources || []).find(s => s.id === f.source || s.legacy_id === f.source);
        const auto = f.autoSource || null;
        const shown = bound || auto;
        const srcT = shown ? shown.temp : (f.role === 'cpu' ? cpuPkgT : boardT);
        const srcN = shown ? shown.label : (f.role === 'cpu' ? t('temp.cpu') : t('temp.board'));
""",
    "app.js auto source UI",
)
app.write_text(u, encoding="utf-8")
