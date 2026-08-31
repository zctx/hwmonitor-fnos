#!/usr/bin/env python3
"""Local hwmonitor app patches for Minisforum N5A/F8NAB.

This script is intentionally narrow:
- fix NVMe temperature mapping on multi-NVMe systems by binding block devices to
  their matching nvme hwmon node through sysfs device paths;
- add a storage-fan software curve floor so SSD/HDD fans cannot be driven to 0%
  by a bad/low temperature source;
- make the UI show the server-selected automatic source instead of falling back
  to the board temperature for non-CPU fans.
"""
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: patch-app.py <server.js> <app.js>")

server = Path(sys.argv[1])
app = Path(sys.argv[2])

s = server.read_text(encoding="utf-8")

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
      out.push({ dev: b, type: 'nvme', model, size, temp, hwmon: match ? path.basename(match.dir) : null });
    }
"""
if old_nvme not in s:
    raise SystemExit("server.js NVMe block anchor not found")
s = s.replace(old_nvme, new_nvme, 1)

old_target = """    const target = curvePwm(cur.points, src);
"""
new_target = """    let target = curvePwm(cur.points, src);
    // storage fan safety floor: a bad/low SSD/HDD temperature source must not
    // stop the storage cooling path. 77/255 ~= 30%.
    if (['ssd', 'hdd'].includes(normRole(fan.role))) target = Math.max(target, 77);
"""
if old_target not in s:
    raise SystemExit("server.js curve target anchor not found")
s = s.replace(old_target, new_target, 1)
server.write_text(s, encoding="utf-8")

u = app.read_text(encoding="utf-8")
old_ui = """        const bound = (d.temp_sources || []).find(s => s.id === f.source);
        const srcT = bound ? bound.temp : (f.role === 'cpu' ? cpuPkgT : boardT);
        const srcN = bound ? bound.label : (f.role === 'cpu' ? t('temp.cpu') : t('temp.board'));
"""
new_ui = """        const bound = (d.temp_sources || []).find(s => s.id === f.source);
        const auto = f.autoSource || null;
        const shown = bound || auto;
        const srcT = shown ? shown.temp : (f.role === 'cpu' ? cpuPkgT : boardT);
        const srcN = shown ? shown.label : (f.role === 'cpu' ? t('temp.cpu') : t('temp.board'));
"""
if old_ui not in u:
    raise SystemExit("app.js auto source UI anchor not found")
u = u.replace(old_ui, new_ui, 1)
app.write_text(u, encoding="utf-8")
