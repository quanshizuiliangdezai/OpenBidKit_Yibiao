#!/usr/bin/env bash
# sync-upstream.sh — Fork 自动同步上游脚本
# 功能：fetch → merge → 冲突处理(DU/UU/UD) → 恢复我们的修改 → tsc校验 → push + tag
# 由 GitHub Actions 调用，7x24 服务器执行，不依赖本地电脑
set -euo pipefail

# ========== 配置 ==========
UPSTREAM_REPO="https://github.com/FB208/OpenBidKit_Yibiao.git"
ORIGIN_REPO="quanshizuiliangdezai/OpenBidKit_Yibiao"
TAG_PREFIX="上游更新"

# 我们的 10 处修改：路径 + marker（证明修改存在的唯一字符串）
OUR_MODS=(
  "client/electron/services/syncService.cjs|createSyncService"
  "client/electron/ipc/syncIpc.cjs|registerSyncIpc"
  "client/src/features/settings/pages/AccountPage.tsx|AccountPage"
  "client/electron/preload.cjs|sync: {"
  "client/src/shared/types/ipc.ts|SyncPushResult"
  "client/src/features/knowledge-base/pages/KnowledgeBasePage.tsx|syncToTeam"
  "client/electron/services/configStore.cjs|normalizeAccount"
  "client/src/app/menuConfig.ts|id: 'account',"
  "client/src/components/Sidebar.tsx|account: UserIcon,"
  "client/electron/ipc/index.cjs|createSyncService"
)

# DU 冲突：fork 删除的路径（保留删除，不从 upstream 恢复）
DU_KEEP_DELETED=("使用说明/" "yibiao-user-manual")

# ========== 日志 ==========
log()  { echo -e "\033[32m[$(date '+%H:%M:%S')]\033[0m $1"; }
warn() { echo -e "\033[33m[$(date '+%H:%M:%S')]\033[0m $1"; }
err()  { echo -e "\033[31m[$(date '+%H:%M:%S')]\033[0m $1"; }

# ========== 0. 前置检查 ==========
if [ -z "${GITHUB_TOKEN:-}" ]; then
  err "GITHUB_TOKEN 未设置！请检查 workflow secrets 配置。"
  exit 1
fi

# ========== 1. 记录合并前 HEAD ==========
PRE_MERGE_HEAD=$(git rev-parse HEAD)
log "Pre-merge HEAD: $PRE_MERGE_HEAD"

# ========== 2. 添加 upstream 并 fetch ==========
log "Adding upstream remote..."
git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
git fetch upstream --tags

# ========== 3. 检查落后情况 ==========
BEHIND=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo "0")
log "Behind upstream by $BEHIND commits"

if [ "$BEHIND" = "0" ]; then
  log "Already up to date. Nothing to do."
  echo "## Upstream Sync - Skipped" >> "$GITHUB_STEP_SUMMARY"
  echo "Already up to date, no changes needed." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# ========== 4. Merge ==========
MERGE_OUTPUT=$(git merge upstream/main --no-edit 2>&1) || true
MERGE_EXIT=$?

if echo "$MERGE_OUTPUT" | grep -q "Already up to date"; then
  log "Already up to date after fetch."
  exit 0
fi

if [ $MERGE_EXIT -ne 0 ]; then
  log "Merge conflicts detected. Resolving..."

  # --- 4a. DU 冲突（我们删除，上游修改）→ git rm 保留删除 ---
  DU_FILES=$(git diff --name-only --diff-filter=DU 2>/dev/null || true)
  if [ -n "$DU_FILES" ]; then
    log "Resolving DU conflicts (keep fork's deletion)..."
    echo "$DU_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      # 检查是否在 keep-deleted 列表
      SHOULD_DELETE=true
      for pattern in "${DU_KEEP_DELETED[@]}"; do
        if [[ "$f" == *"$pattern"* ]]; then
          SHOULD_DELETE=true
          break
        fi
      done
      if [ "$SHOULD_DELETE" = true ]; then
        git rm "$f" 2>/dev/null && log "  [DU→rm] $f"
      fi
    done
  fi

  # --- 4b. UD 冲突（我们修改，上游删除）→ 保留我们的版本 ---
  UD_FILES=$(git diff --name-only --diff-filter=UD 2>/dev/null || true)
  if [ -n "$UD_FILES" ]; then
    log "Resolving UD conflicts (keep our version)..."
    echo "$UD_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      git checkout --ours "$f" 2>/dev/null && git add "$f" && log "  [UD→ours] $f"
    done
  fi

  # --- 4c. UU 冲突（双方都修改）→ 双保留策略 ---
  UU_FILES=$(git diff --name-only --diff-filter=UU 2>/dev/null || true)
  if [ -n "$UU_FILES" ]; then
    log "Resolving UU conflicts (double-preserve)..."
    echo "$UU_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      log "  [UU→double] $f"
      python3 - "$f" << 'PYEOF'
import sys, re

filepath = sys.argv[1]
try:
    with open(filepath, 'r', encoding='utf-8') as fh:
        content = fh.read()
except Exception as e:
    print(f"  ERROR reading {filepath}: {e}", file=sys.stderr)
    sys.exit(1)

# 冲突块格式: <<<<<<< HEAD\n(ours)\n=======\n(theirs)\n>>>>>>> upstream/main
pattern = r'<{7} HEAD\n(.*?)\n={7}\n(.*?)\n>{7} [^\n]+'

def replacer(m):
    head_part = m.group(1).rstrip()
    upstream_part = m.group(2).rstrip()
    # 双保留：HEAD 块在前，upstream 块追加在后
    if head_part and upstream_part:
        return head_part + '\n' + upstream_part
    elif head_part:
        return head_part
    else:
        return upstream_part

content = re.sub(pattern, replacer, content, flags=re.DOTALL)

# 清理孤儿括号 & 多余空行
content = re.sub(r'\n{4,}', '\n\n\n', content)

with open(filepath, 'w', encoding='utf-8') as fh:
    fh.write(content)

print(f"  Resolved: {filepath}")
PYEOF
      git add "$f"
    done
  fi

  # --- 4d. 检查是否还有未解决冲突 ---
  REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    err "Unresolved conflicts remain:"
    echo "$REMAINING"
    git merge --abort
    exit 1
  fi

  # --- 4e. 完成 merge commit ---
  git commit --no-edit 2>/dev/null || log "Nothing to commit (merge auto-resolved)."
  log "All conflicts resolved, merge committed."
else
  log "Merge completed cleanly (no conflicts)."
fi

# ========== 5. 恢复我们的修改 ==========
log "Checking our modifications..."
RESTORED=0
for entry in "${OUR_MODS[@]}"; do
  IFS='|' read -r filepath marker <<< "$entry"
  if [ ! -f "$filepath" ]; then
    # 文件不存在 → 从合并前 HEAD 恢复
    warn "  [MISSING] $filepath — restoring from pre-merge HEAD"
    mkdir -p "$(dirname "$filepath")"
    git show "$PRE_MERGE_HEAD:$filepath" > "$filepath" 2>/dev/null && {
      git add "$filepath"
      RESTORED=$((RESTORED + 1))
      log "  [RESTORED] $filepath"
    } || warn "  [FAILED] Could not restore $filepath"
  else
    # 文件存在但 marker 丢失 → 上游覆盖了我们的修改
    if ! grep -q "$marker" "$filepath" 2>/dev/null; then
      warn "  [OVERWRITTEN] $filepath — marker '$marker' not found, restoring from pre-merge HEAD"
      git show "$PRE_MERGE_HEAD:$filepath" > "$filepath" 2>/dev/null && {
        git add "$filepath"
        RESTORED=$((RESTORED + 1))
        log "  [RESTORED] $filepath"
      } || warn "  [FAILED] Could not restore $filepath"
    fi
  fi
done

if [ "$RESTORED" -gt 0 ]; then
  log "Restored $RESTORED files. Committing restore..."
  git commit --no-edit -m "chore: restore our modifications after upstream sync" 2>/dev/null || \
  git commit -m "chore: restore our modifications after upstream sync" 2>/dev/null || \
  log "No changes to commit after restore."
else
  log "All modifications intact, no restore needed."
fi

# ========== 6. 校验 ==========
log "Running validation..."

# --- 6a. 安装依赖 + tsc --noEmit ---
log "Installing client dependencies for tsc..."
cd client
npm ci --production=false 2>/dev/null || npm install 2>/dev/null || {
  warn "npm install failed. Falling back to typescript-only check."
  npx -y typescript@latest --version 2>/dev/null || {
    err "Could not get typescript. Skipping tsc check (unsafe)."
    cd ..
    exit 1
  }
}

TSC_RESULT=0
log "Running tsc --noEmit..."
npx tsc --noEmit 2>&1 || TSC_RESULT=$?
cd ..

if [ "$TSC_RESULT" -ne 0 ]; then
  err "tsc --noEmit FAILED! Merge is broken. Aborting."
  err "Run 'git merge --abort' or 'git reset --hard $PRE_MERGE_HEAD' locally to investigate."
  git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
  exit 1
fi
log "tsc --noEmit passed."

# --- 6b. node --check on modified .cjs files ---
MODIFIED_CJS=$(git diff --name-only "$PRE_MERGE_HEAD" HEAD -- '*.cjs' 2>/dev/null || true)
if [ -n "$MODIFIED_CJS" ]; then
  log "Checking modified .cjs files..."
  CHECK_FAIL=0
  echo "$MODIFIED_CJS" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -f "$f" ]; then
      node --check "$f" 2>&1 || {
        err "node --check FAILED for $f"
        CHECK_FAIL=1
      }
    fi
  done
  if [ "$CHECK_FAIL" -ne 0 ]; then
    err "node --check failed for some .cjs files. Aborting."
    git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
    exit 1
  fi
  log "All .cjs files passed node --check."
fi

# --- 6c. 关键功能存活检查 ---
log "Checking key function survival..."
KEYWORDS_MISSING=0
for kw in registerKbAuthIpc kbAuth kbTeam checkForUpdates; do
  if ! grep -rq "$kw" client/src/ client/electron/ 2>/dev/null; then
    warn "  Keyword not found: $kw"
    KEYWORDS_MISSING=$((KEYWORDS_MISSING + 1))
  fi
done

if [ "$KEYWORDS_MISSING" -gt 2 ]; then
  err "Too many key functions missing ($KEYWORDS_MISSING). Merge likely broke something. Aborting."
  git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
  exit 1
fi
if [ "$KEYWORDS_MISSING" -gt 0 ]; then
  warn "$KEYWORDS_MISSING keywords not found (may be OK if refactored). Proceeding."
fi
log "Key function check done."

# ========== 7. Push ==========
log "Pushing to origin/main..."
PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${ORIGIN_REPO}.git"
git push "$PUSH_URL" main

# ========== 8. Tag ==========
TAG_NAME="${TAG_PREFIX}-$(date '+%Y%m%d-%H%M')"
log "Creating tag: $TAG_NAME"
git tag "$TAG_NAME"
git push "$PUSH_URL" "$TAG_NAME"

# ========== 9. Summary ==========
log "Sync completed successfully!"
{
  echo "## Upstream Sync Completed"
  echo ""
  echo "- **Behind by**: $BEHIND commits"
  echo "- **Files restored**: $RESTORED"
  echo "- **Tag**: \`$TAG_NAME\`"
  echo "- **Pre-merge HEAD**: \`$PRE_MERGE_HEAD\`"
  echo "- **Post-merge HEAD**: \`$(git rev-parse HEAD)\`"
} >> "$GITHUB_STEP_SUMMARY"
