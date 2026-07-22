#!/usr/bin/env python3
"""从 IMG_5749.jpg 原图满幅铺底，只做圆角裁切（不缩放主体、不加彩色底板）。"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "IMG_5749.jpg"
# 若原图缺失，用已生成的圆角 PNG 作为重出输入
SRC_FALLBACK = ROOT / "build" / "icon.png"
BUILD = ROOT / "build"
OUT_PNG = BUILD / "icon.png"
OUT_ICNS = BUILD / "icon.icns"
OUT_ICO = BUILD / "icon.ico"
SIZE = 1024
# macOS 风格圆角
CORNER = 0.223


def rounded_mask(size: int, radius: float) -> Image.Image:
  mask = Image.new("L", (size, size), 0)
  draw = ImageDraw.Draw(mask)
  r = int(size * radius)
  draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
  return mask


def compose_master() -> Image.Image:
  src = ImageOps.exif_transpose(Image.open(SRC)).convert("RGBA")
  # 原图等比覆盖到 1024 正方形：只做必要的画布适配，不额外缩小/放大主体留白
  # 若原图已是近似正方形，效果即「原图 + 圆角」
  w, h = src.size
  side = min(w, h)
  left = (w - side) // 2
  top = (h - side) // 2
  square = src.crop((left, top, left + side, top + side))
  # 仅当输出尺寸与原图裁切边长不同时，才 resize 到图标标准尺寸（1024）
  if square.size != (SIZE, SIZE):
    square = square.resize((SIZE, SIZE), Image.Resampling.LANCZOS)

  mask = rounded_mask(SIZE, CORNER)
  out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
  out.paste(square, (0, 0))
  out.putalpha(mask)
  return out


def write_icns(png: Path) -> None:
  iconset = BUILD / "icon.iconset"
  if iconset.exists():
    shutil.rmtree(iconset)
  iconset.mkdir(parents=True)

  mapping = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
  }
  master = Image.open(png).convert("RGBA")
  for name, side in mapping.items():
    master.resize((side, side), Image.Resampling.LANCZOS).save(iconset / name, format="PNG")

  subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT_ICNS)], check=True)
  shutil.rmtree(iconset)


def write_ico(png: Path) -> None:
  master = Image.open(png).convert("RGBA")
  sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
  master.save(OUT_ICO, format="ICO", sizes=sizes)


def main() -> None:
  if not SRC.exists():
    raise SystemExit(f"找不到素材: {SRC}")
  BUILD.mkdir(parents=True, exist_ok=True)
  master = compose_master()
  master.save(OUT_PNG, format="PNG", optimize=True)
  write_icns(OUT_PNG)
  write_ico(OUT_PNG)
  print("generated:", OUT_PNG)
  print("generated:", OUT_ICNS)
  print("generated:", OUT_ICO)


if __name__ == "__main__":
  main()
