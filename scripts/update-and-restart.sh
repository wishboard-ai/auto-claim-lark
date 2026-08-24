#!/bin/bash
# update-and-restart.sh —— macOS 每日检查更新脚本（对应 Windows 的 update-and-restart.ps1）
# 逻辑：git fetch 比对远端；有更新则「重启机器人进程」——由 launchd(com.autoclaim.lark,
#       KeepAlive=true) 自动重启，重启会经 run-bot.sh -> start.sh 自动 git pull + 编译 + 运行。
#       无更新则不打扰当前实例。
# 由 launchd com.autoclaim.lark.dailyupdate 每天定时(08:00)调起。
set -o pipefail

export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
export GIT_TERMINAL_PROMPT=0   # 无人值守：禁止交互式凭据提示，未配置凭据则直接失败而非挂起

# 仓库 = 本脚本所在目录(scripts)的上一级（可移植，无需硬编码路径）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
mkdir -p "$REPO/logs"
LOG="$REPO/logs/update.log"
log() { echo "$(date '+%F %T')  $*" >> "$LOG"; }

FORCE=0
[ "$1" = "-Force" ] || [ "$1" = "--force" ] && FORCE=1

cd "$REPO" 2>/dev/null || { log "仓库不存在：$REPO"; exit 0; }
[ -d .git ] || { log "非 git 仓库，跳过"; exit 0; }

log "==== 定时检查开始 ===="

if ! git fetch --quiet origin 2>>"$LOG"; then
  log "git fetch 失败（网络/凭据），跳过"; exit 0
fi

LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse '@{u}' 2>/dev/null)
BASE=$(git merge-base HEAD '@{u}' 2>/dev/null)
if [ -z "$REMOTE" ]; then log "未设置上游(tracking)，跳过"; exit 0; fi

restart_bot() {
  # 杀掉机器人进程；launchd KeepAlive 会重启 -> start.sh 自动 pull+编译+运行新代码
  if pkill -f 'dist/src/index.js'; then
    log "已发送重启信号（launchd 将经 start.sh 自动拉取+编译+运行）"
  else
    log "未发现运行中的机器人进程；launchd 应会按需拉起"
  fi
}

if [ "$LOCAL" = "$REMOTE" ]; then
  log "已是最新（${LOCAL:0:7}），无需重启"
  if [ "$FORCE" = "1" ]; then log "-Force：强制重启"; restart_bot; fi
  log "==== 结束 ===="; exit 0
fi
if [ "$LOCAL" != "$BASE" ]; then
  log "本地与远端分叉（有本地提交/改动），跳过。local=${LOCAL:0:7} remote=${REMOTE:0:7}"
  log "==== 结束 ===="; exit 0
fi

log "发现更新 ${LOCAL:0:7} -> ${REMOTE:0:7}；重启机器人以应用更新"
restart_bot
log "==== 定时检查结束（已触发更新重启） ===="
