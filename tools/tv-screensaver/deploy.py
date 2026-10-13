#!/usr/bin/env python3
"""Sube el kit a la TV con ssh/scp de Windows. Uso: python deploy.py [--host 192.168.1.237] [--user root] [--apply]
Sin --apply solo sube ficheros y corre el preflight (solo lectura). Con --apply ademas hace el bind mount."""
import argparse, subprocess, sys
ap = argparse.ArgumentParser(); ap.add_argument("--host", default="192.168.1.237")
ap.add_argument("--user", default="root"); ap.add_argument("--apply", action="store_true"); a = ap.parse_args()
dst = f"{a.user}@{a.host}"
def run(cmd):
    print("$", " ".join(cmd)); r = subprocess.run(cmd); 
    if r.returncode: sys.exit(f"fallo: {cmd}")
run(["ssh", dst, "mkdir -p /media/developer/art /media/developer/art-kit"])
run(["scp", "-r", "art/.", f"{dst}:/media/developer/art/"])
run(["scp", "screensaver-main.qml", "tv_apply.sh", "tv_rollback.sh", "tv_preflight.sh", f"{dst}:/media/developer/art-kit/"])
run(["ssh", dst, "chmod +x /media/developer/art-kit/*.sh && sh /media/developer/art-kit/tv_preflight.sh"])
if a.apply: run(["ssh", dst, "sh /media/developer/art-kit/tv_apply.sh"])
