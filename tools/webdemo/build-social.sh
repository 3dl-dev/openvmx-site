#!/usr/bin/env bash
# Build the social/ promo set (Reddit + LinkedIn) from the auto-tracked demo
# assets (og-demo.png brand card + ovmx-boot.mp4 real boot recording).
#
# Deterministic + idempotent: re-running with the same source assets produces
# the same outputs. Regenerate whenever og-demo.png / ovmx-boot.mp4 are refreshed
# for a new release (they are auto-tracked, see tools/webdemo/brand-frames.js).
#
# Needs: ffmpeg, ImageMagick (convert), DejaVu fonts. No network, no host installs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/social"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

BG='#0b0c11'; AMBER='#ffb232'; DIMAMBER='#a6690a'; CREAM='#ffe0b0'
SERIF=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
MONO=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
MONOB=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
OG="$ROOT/og-demo.png"; BOOT="$ROOT/ovmx-boot.mp4"
HDR="$WORK/brand-header.png"

# Clean brand header (wordmark+tagline+badge+url), trimmed above the terminal window.
convert "$OG" -crop 2400x315+0+40 +repage "$HDR"

feather_hdr () { # width OUT — soft rounded panel, no hard seam
  local w=$1 O=$2
  convert "$HDR" -resize ${w}x "$WORK/_h.png"
  local W H; W=$(identify -format %w "$WORK/_h.png"); H=$(identify -format %h "$WORK/_h.png")
  convert -size ${W}x${H} xc:black -fill white \
    -draw "roundrectangle 20,14 $((W-21)),$((H-15)) 24,24" -blur 0x16 "$WORK/_m.png"
  convert "$WORK/_h.png" "$WORK/_m.png" -alpha off -compose CopyOpacity -composite "$O"
}
make_bg () { # W H OUT — near-black with a soft top-left amber glow
  local W=$1 H=$2 O=$3
  convert -size ${W}x${H} xc:"$BG" \
    \( -size ${W}x${H} xc:black -fill '#5a3708' \
       -draw "circle $((W/5)),$((H/4)) $((W/5+2)),$((H/4))" -blur 0x$((W/6)) \) \
    -compose screen -composite \
    -size ${W}x${H} xc:"$BG" +swap -compose over -composite "$O"
}
make_title () { # W H OUT
  local W=$1 H=$2 O=$3
  make_bg "$W" "$H" "$WORK/bg.png"
  feather_hdr $(( W*84/100 )) "$WORK/hdr.png"
  local cfs=$(( H*26/1000 )); (( cfs<18 )) && cfs=18
  convert "$WORK/bg.png" \
    "$WORK/hdr.png" -gravity center -geometry +0-$(( H*6/100 )) -compose over -composite \
    -font "$MONO" -pointsize $cfs -fill "$DIMAMBER" -gravity center \
    -annotate +0+$(( H*24/100 )) "DCL   RMS   system services   kernel executive" "$O"
}
make_end () { # W H OUT
  local W=$1 H=$2 O=$3
  make_bg "$W" "$H" "$WORK/bge.png"
  local h1=$(( H*62/1000 )); (( h1<30 )) && h1=30
  local h2=$(( H*46/1000 )); (( h2<24 )) && h2=24
  local h3=$(( H*26/1000 )); (( h3<15 )) && h3=15
  convert "$WORK/bge.png" -gravity center \
    -font "$SERIF" -pointsize $h1 -fill "$AMBER"    -annotate +0-$(( H*9/100 )) "Boots in your browser." \
    -font "$MONOB" -pointsize $h2 -fill "$CREAM"    -annotate +0+$(( H*2/100 )) "openvmx.3dl.dev" \
    -font "$MONO"  -pointsize $h3 -fill "$DIMAMBER" -annotate +0+$(( H*12/100 )) "open source   OpenVMS-compatible   VAX  Alpha  x86-64  ARM" "$O"
}
make_boot_seg () { # W H OUT
  local W=$1 H=$2 O=$3
  local pad=$(( W*22/1000 )); local wfs=$(( H*26/1000 )); (( wfs<16 )) && wfs=16
  ffmpeg -y -loglevel error -i "$BOOT" -vf \
"scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0c11,\
drawtext=fontfile=${MONOB}:text='openvmx.3dl.dev':fontcolor=0xffb232@0.9:fontsize=${wfs}:x=w-tw-${pad}:y=h-th-${pad}:box=1:boxcolor=0x0b0c11@0.5:boxborderw=${pad}" \
    -an -r 30 -pix_fmt yuv420p -c:v libx264 -crf 20 "$O"
}
build_video () { # NAME W H
  local NAME=$1 W=$2 H=$3
  make_title "$W" "$H" "$WORK/title.png"
  make_end   "$W" "$H" "$WORK/end.png"
  make_boot_seg "$W" "$H" "$WORK/seg.mp4"
  ffmpeg -y -loglevel error \
    -loop 1 -t 2.6 -i "$WORK/title.png" -i "$WORK/seg.mp4" -loop 1 -t 3.0 -i "$WORK/end.png" \
    -filter_complex \
"[0:v]scale=${W}:${H},fps=30,format=yuv420p,fade=in:st=0:d=0.4,fade=out:st=2.3:d=0.3[t];\
[1:v]fps=30,format=yuv420p,fade=in:st=0:d=0.3[b];\
[2:v]scale=${W}:${H},fps=30,format=yuv420p,fade=in:st=0:d=0.3,fade=out:st=2.7:d=0.3[e];\
[t][b][e]concat=n=3:v=1:a=0[v]" \
    -map "[v]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 20 "$OUT/$NAME"
  echo "  $NAME  $(du -h "$OUT/$NAME"|cut -f1)"
}

echo "videos:"
build_video demo-landscape-16x9.mp4 1920 1080
build_video demo-square-1x1.mp4     1080 1080

echo "gif (Reddit inline/autoplay):"
ffmpeg -y -loglevel error -i "$BOOT" -vf \
"scale=720:-2:flags=lanczos,fps=15,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$OUT/demo-reddit.gif"
echo "  demo-reddit.gif  $(du -h "$OUT/demo-reddit.gif"|cut -f1)"

echo "static cards:"
make_bg 1200 1200 "$WORK/sq.png"; feather_hdr 1080 "$WORK/hsq.png"
convert "$WORK/sq.png" "$WORK/hsq.png" -gravity north -geometry +0+140 -compose over -composite \
  -font "$SERIF" -pointsize 60 -fill "$AMBER"    -gravity center -annotate +0+70  "Boots in your browser." \
  -font "$MONO"  -pointsize 30 -fill "$DIMAMBER" -gravity center -annotate +0+150 "DCL   RMS   system services   kernel executive" \
  -font "$MONO"  -pointsize 26 -fill "$DIMAMBER" -gravity south  -annotate +0+90  "open source   OpenVMS-compatible   VAX  Alpha  x86-64  ARM" \
  "$OUT/card-square-1200x1200.png"; echo "  card-square-1200x1200.png"
make_bg 1080 1350 "$WORK/pt.png"; feather_hdr 960 "$WORK/hpt.png"
convert "$WORK/pt.png" "$WORK/hpt.png" -gravity north -geometry +0+180 -compose over -composite \
  -font "$SERIF" -pointsize 58 -fill "$AMBER"    -gravity center -annotate +0+40  "Boots in your browser." \
  -font "$MONO"  -pointsize 30 -fill "$DIMAMBER" -gravity center -annotate +0+120 "DCL   RMS   system services   kernel executive" \
  -font "$MONOB" -pointsize 34 -fill "$CREAM"    -gravity south  -annotate +0+140 "openvmx.3dl.dev" \
  -font "$MONO"  -pointsize 24 -fill "$DIMAMBER" -gravity south  -annotate +0+80  "open source   OpenVMS-compatible   VAX  Alpha  x86-64  ARM" \
  "$OUT/card-portrait-1080x1350.png"; echo "  card-portrait-1080x1350.png"

echo "done -> $OUT"
