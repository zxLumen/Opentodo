#!/usr/bin/env bash
# 真机部署：可达性预检 → 构建 → 安装 → 启动（免费个人账号，automatic signing）。
#
# 可达性：优先 USB；无线时自动在 2.4G / 5G 之间尝试（SG659HZ 光猫会同频段隔离）。
# 注意：这里的 5G 指 Wi-Fi 的 CU_77qd_5G，不是手机状态栏的蜂窝 5G。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="Opentodo.xcodeproj"
SCHEME="Opentodo"
BUNDLE_ID="com.opentodo.ios"
DEVICE_UDID="${DEVICE_UDID:-00008030-000804100CE8802E}"
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-T8TG4WAR43}"
APP=".build/device/Build/Products/Debug-iphoneos/Opentodo.app"
WIFI_INTERFACE="${WIFI_INTERFACE:-en0}"

if [ ! -d "$PROJECT" ]; then
  echo "==> 生成 Xcode 工程"
  command -v xcodegen >/dev/null || { echo "需要 xcodegen"; exit 1; }
  xcodegen generate
fi

probe_device() {
  xcrun devicectl device info lockState --device "$DEVICE_UDID" -t 8 >/dev/null 2>&1
}

wait_probe() {
  local tries="${1:-20}" i
  for i in $(seq 1 "$tries"); do
    probe_device && return 0
    sleep 1
  done
  return 1
}

usb_connected() {
  system_profiler SPUSBDataType 2>/dev/null | grep -qiE 'iPhone|Apple Mobile Device'
}

current_ssid() {
  ipconfig getsummary "$WIFI_INTERFACE" 2>/dev/null | awk -F': ' '/ SSID /{print $2; exit}'
}

WIFI_ORIG=""
WIFI_RESTORE=0
restore_wifi() {
  if [ "$WIFI_RESTORE" = "1" ] && [ -n "${WIFI_ORIG:-}" ] && [ -n "${WIFI_PASSWORD:-}" ]; then
    echo "==> 切回原网络 $WIFI_ORIG"
    networksetup -setairportnetwork "$WIFI_INTERFACE" "$WIFI_ORIG" "$WIFI_PASSWORD" >/dev/null 2>&1 || true
  fi
}
trap restore_wifi EXIT

wifi_join() {
  local ssid="$1" i cur
  [ -n "$ssid" ] || return 1
  networksetup -setairportnetwork "$WIFI_INTERFACE" "$ssid" "$WIFI_PASSWORD" >/dev/null 2>&1 || true
  for i in $(seq 1 20); do
    cur="$(current_ssid || true)"
    if [ "$cur" = "$ssid" ] && ifconfig "$WIFI_INTERFACE" 2>/dev/null | grep -q 'inet '; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "==> 检查 iPhone 可达性 ($DEVICE_UDID)"
if probe_device; then
  echo "iPhone 可达（当前 Wi-Fi: $(current_ssid || echo 未知)）"
else
  if usb_connected && ! probe_device; then
    echo "检测到 USB 连接的 iPhone，等待响应…"
    wait_probe 20 || true
  fi
  if ! probe_device; then
    WIFI_LOCAL="$ROOT/scripts/wifi.local.sh"
    if [ -f "$WIFI_LOCAL" ]; then
      # shellcheck disable=SC1090
      source "$WIFI_LOCAL"
      WIFI_PRIMARY_SSID="${WIFI_PRIMARY_SSID:-CU_77qd_5G}"
      WIFI_ALT_SSID="${WIFI_ALT_SSID:-CU_77qd}"
      if [ -n "${WIFI_PASSWORD:-}" ]; then
        WIFI_ORIG="$(current_ssid || true)"
        for target in "$WIFI_PRIMARY_SSID" "$WIFI_ALT_SSID"; do
          [ "$target" = "$WIFI_ORIG" ] && continue
          echo "==> 当前 Wi-Fi 发现不了手机，尝试切到 $target"
          WIFI_RESTORE=1
          if wifi_join "$target" && wait_probe 25; then
            echo "iPhone 可达（${target}）"
            break
          fi
        done
      fi
    fi
  fi
fi

if ! probe_device; then
  CUR_SSID="$(current_ssid || echo 未知)"
  CUR_IP="$(ifconfig "$WIFI_INTERFACE" 2>/dev/null | awk '/inet /{print $2; exit}')"
  cat <<MSG
!! iPhone 不可达，先别急着构建。

请确认：
  1. iPhone 设置 → Wi-Fi 已连接，且网络名是 CU_77qd_5G（不是状态栏的蜂窝 5G）；
  2. 关掉 SideStore 的 LocalDevVPN / StosVPN（VPN 会挡局域网发现）；
  3. 解锁手机并保持亮屏 10 秒（锁屏休眠会停止 Bonjour 广播）；
  4. 最稳：插 USB 线并在手机上点“信任”，再重跑本脚本；
  5. Xcode → Window → Devices and Simulators → 勾选 “Connect via network”。

Mac 当前网络：SSID=${CUR_SSID} ${CUR_IP}
MSG
  exit 2
fi

echo "==> 真机构建 ($DEVICE_UDID)"
xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
  -destination "id=$DEVICE_UDID" -derivedDataPath .build/device build \
  CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM"

echo "==> 真机安装并启动"
xcrun devicectl device install app --device "$DEVICE_UDID" "$APP"
xcrun devicectl device process terminate --device "$DEVICE_UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID" \
  || echo "!! 已安装，但自动启动失败；请在手机上手动打开 Opentodo"

echo "==> 完成"
